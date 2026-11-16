import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { durableDirectory, storageKey, syncDirectory, type BlobBackend } from "./backend.js";

const MAGIC = "FEEDINK-REFERENCED-BLOBS-2";
const MAX_HEADER = 8192;
export const MAX_BLOB_BYTES = 256 * 1024 ** 2;
export const MAX_PART_BYTES = 512 * 1024 ** 2;
export const MAX_PART_OBJECTS = 1024;
const hash = () => createHash("sha256");
const jsonLine = (value: unknown) => JSON.stringify(value) + "\n";
async function write(output: Writable, value: string | Buffer) { if (!output.write(value)) await once(output, "drain"); }
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid bundle integer");
}
function fields(value: Record<string, unknown>, expected: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected)
    throw new Error("Invalid bundle record");
}

/** One stream, bounded independently checked parts, constant-size final manifest; never a list of all names. */
export async function packReferenced(backend: BlobBackend, keys: AsyncIterable<string>, fingerprint: string, output: Writable) {
  storageKey(fingerprint);
  await write(output, MAGIC + "\n");
  let partHash = hash(), partObjects = 0, partBytes = 0, count = 0, bytes = 0, parts = 0, last = "";
  const finishPart = async () => {
    if (!partObjects) return;
    await write(output, jsonLine({ type: "part", number: parts, count: partObjects, bytes: partBytes, sha256: partHash.digest("hex") }));
    parts++; partHash = hash(); partObjects = 0; partBytes = 0;
  };
  for await (const key of keys) {
    storageKey(key);
    if (key <= last) throw new Error("Bundle keys must be strictly increasing");
    last = key;
    const size = await backend.size(key);
    integer(size);
    if (size > MAX_BLOB_BYTES) throw new Error("Referenced blob exceeds bundle per-object limit");
    if (partObjects && (partObjects >= MAX_PART_OBJECTS || partBytes + size > MAX_PART_BYTES)) await finishPart();
    const header = jsonLine({ type: "blob", key, size });
    partHash.update(header); await write(output, header);
    const objectHash = hash(); let copied = 0;
    for await (const chunk of await backend.read(key)) {
      const data = Buffer.from(chunk); copied += data.length;
      if (copied > size) throw new Error("Blob changed during backup");
      objectHash.update(data); partHash.update(data); await write(output, data);
    }
    if (copied !== size || objectHash.digest("hex") !== key) throw new Error("Blob integrity mismatch during backup");
    partObjects++; partBytes += size; count++; bytes += size;
    integer(count); integer(bytes);
  }
  await finishPart();
  await write(output, jsonLine({ type: "end", parts, count, bytes, fingerprint }));
}

class Reader {
  private iterator: AsyncIterator<Buffer>;
  buffer = Buffer.alloc(0);
  constructor(input: Readable) { this.iterator = input[Symbol.asyncIterator](); }
  async fill() {
    const next = await this.iterator.next();
    if (next.done) return false;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : Buffer.from(next.value);
    return true;
  }
  async line() {
    while (true) {
      const end = this.buffer.indexOf(10);
      if (end >= 0) {
        if (end > MAX_HEADER) throw new Error("Bundle header too large");
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1); return line;
      }
      if (this.buffer.length > MAX_HEADER) throw new Error("Bundle header too large");
      if (!await this.fill()) throw new Error("Truncated bundle");
    }
  }
  async body(size: number, consume: (bytes: Buffer) => Promise<void>) {
    while (size) {
      if (!this.buffer.length && !await this.fill()) throw new Error("Truncated bundle object");
      const length = Math.min(size, this.buffer.length);
      await consume(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length); size -= length;
    }
  }
}

/** Call once without a target to validate the COMPLETE stream before restoring PostgreSQL or any objects. */
export async function unpackReferenced(input: Readable, expectedFingerprint?: string, target?: { backend: BlobBackend; scratch: string }) {
  if (expectedFingerprint) storageKey(expectedFingerprint);
  if (target) {
    await target.backend.assertEmpty();
    // Scratch is on the destination filesystem for hard-link publish, created only AFTER emptiness refusal.
    await durableDirectory(target.scratch);
  }
  const reader = new Reader(input);
  if (await reader.line() !== MAGIC) throw new Error("Unsupported referenced-blob bundle");
  let partHash = hash(), partObjects = 0, partBytes = 0, count = 0, bytes = 0, parts = 0, last = "";
  while (true) {
    const record = JSON.parse(await reader.line());
    if (record?.type === "end") {
      fields(record, "bytes,count,fingerprint,parts,type"); storageKey(record.fingerprint);
      if (partObjects || record.parts !== parts || record.count !== count || record.bytes !== bytes ||
          (expectedFingerprint && record.fingerprint !== expectedFingerprint)) throw new Error("Bundle final manifest mismatch");
      if (reader.buffer.length || await reader.fill()) throw new Error("Unexpected trailing bundle bytes");
      return { fingerprint: record.fingerprint as string, count, bytes, parts };
    }
    if (record?.type === "part") {
      fields(record, "bytes,count,number,sha256,type");
      if (!partObjects || record.number !== parts || record.count !== partObjects || record.bytes !== partBytes || record.sha256 !== partHash.digest("hex"))
        throw new Error("Bundle part integrity mismatch");
      parts++; integer(parts); partObjects = 0; partBytes = 0; partHash = hash(); continue;
    }
    fields(record, "key,size,type");
    if (record.type !== "blob") throw new Error("Unknown bundle record");
    const key = storageKey(record.key); integer(record.size);
    if (key <= last || record.size > MAX_BLOB_BYTES || ++partObjects > MAX_PART_OBJECTS || (partBytes += record.size) > MAX_PART_BYTES)
      throw new Error("Unsorted/duplicate key or bundle part limit exceeded");
    last = key; count++; bytes += record.size; integer(count); integer(bytes);
    partHash.update(jsonLine({ type: "blob", key, size: record.size }));
    const objectHash = hash();
    const directory = target ? await mkdtemp(join(target.scratch, "restore-")) : undefined;
    if (target) await syncDirectory(target.scratch);
    const file = directory ? join(directory, key) : undefined;
    const handle = file ? await open(file, "wx", 0o600) : undefined;
    try {
      await reader.body(record.size, async data => {
        objectHash.update(data); partHash.update(data);
        if (handle) {
          let offset = 0;
          while (offset < data.length) {
            const result = await handle.write(data, offset, data.length - offset);
            if (!result.bytesWritten) throw new Error("Short bundle write");
            offset += result.bytesWritten;
          }
        }
      });
      if (objectHash.digest("hex") !== key) throw new Error("Bundle object integrity mismatch");
      await handle?.sync();
    } finally { await handle?.close(); }
    if (target && directory && file) {
      await syncDirectory(directory);
      await target.backend.publish(key, file);
      await rm(directory, { recursive: true });
      await syncDirectory(target.scratch);
    }
  }
}

export function referencedManifest(databaseHash: string, blobHash: string, fingerprint: string) {
  [databaseHash, blobHash, fingerprint].forEach(storageKey);
  return { format: "feedink-backup", version: 2, scope: "postgres-and-referenced-blobs", fingerprint,
    files: { "postgres.dump": databaseHash, "blobs.archive": blobHash } };
}
export function validateReferencedManifest(value: any) {
  if (!value || value.format !== "feedink-backup" || value.version !== 2 || value.scope !== "postgres-and-referenced-blobs" ||
      !value.files || Object.keys(value.files).sort().join(",") !== "blobs.archive,postgres.dump") throw new Error("Invalid referenced-blob manifest");
  [value.fingerprint, value.files["postgres.dump"], value.files["blobs.archive"]].forEach(storageKey);
  return `${value.files["postgres.dump"]} ${value.files["blobs.archive"]} ${value.fingerprint}`;
}
