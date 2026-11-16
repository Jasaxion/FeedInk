import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SQL } from "../core.js";
import { digest, durableDirectory, missing, storageKey, syncDirectory, verifyBlob, type BlobBackend } from "./backend.js";
import { databaseFingerprint, referencedKeys } from "./inventory.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export async function durableJson(file: string, value: unknown) {
  await durableDirectory(dirname(file));
  // A unique temp file survives interruptions without clobbering another checkpoint generation.
  const directory = await mkdtemp(join(dirname(file), ".checkpoint-"));
  await syncDirectory(dirname(file));
  const temporary = join(directory, "value.json"), handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  await syncDirectory(dirname(file));
  await rm(directory, { recursive: true });
  await syncDirectory(dirname(file));
}
export async function readJson(file: string, maxBytes = 8192) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error("Invalid metadata file");
  return JSON.parse(await readFile(file, "utf8"));
}
export async function copyBlob(source: BlobBackend, target: BlobBackend, scratch: string, key: string) {
  const directory = await mkdtemp(join(scratch, "copy-")), file = join(directory, storageKey(key));
  await syncDirectory(scratch);
  const handle = await open(file, "wx", 0o600);
  try {
    for await (const chunk of await source.read(key)) {
      const bytes = Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw new Error("Short blob copy write");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(directory);
  const staged = await digest((await open(file, "r")).createReadStream());
  if (staged.key !== key) throw new Error("Source blob integrity mismatch; scratch retained");
  await target.publish(key, file); // Backend contract includes full destination hash verification.
  await rm(directory, { recursive: true });
  await syncDirectory(scratch);
  return staged;
}
interface Checkpoint {
  version: 1; source: string; target: string; fingerprint: string; lastKey: string;
  copied: number; complete: boolean;
}
/** Non-deleting, maintenance-only copy. Resume replays at most one page; final verification always scans all references. */
export async function migrateStorage(sql: SQL, source: BlobBackend, target: BlobBackend, scratch: string, checkpointFile: string) {
  await durableDirectory(scratch);
  const fingerprint = await databaseFingerprint(sql);
  const expected = { version: 1 as const, source: sha256(source.identity()), target: sha256(target.identity()), fingerprint };
  let checkpoint: Checkpoint = { ...expected, lastKey: "", copied: 0, complete: false };
  try {
    const saved = await readJson(checkpointFile) as Checkpoint;
    if (saved.version !== 1 || saved.source !== expected.source || saved.target !== expected.target || saved.fingerprint !== fingerprint ||
        (saved.lastKey !== "" && storageKey(saved.lastKey) !== saved.lastKey) || !Number.isSafeInteger(saved.copied) || saved.copied < 0 || typeof saved.complete !== "boolean")
      throw new Error("Migration checkpoint deployment/database mismatch");
    checkpoint = saved;
  } catch (error) { if (!missing(error)) throw error; }
  await durableJson(checkpointFile, checkpoint);
  for await (const key of referencedKeys(sql, checkpoint.lastKey)) {
    await copyBlob(source, target, scratch, key);
    checkpoint.lastKey = key;
    checkpoint.copied++;
    checkpoint.complete = false;
    if (checkpoint.copied % 128 === 0) await durableJson(checkpointFile, checkpoint);
  }
  await durableJson(checkpointFile, checkpoint);
  // Do not trust checkpoints as proof that earlier destination bytes still exist or are intact.
  const verified = await verifyReferenced(sql, target);
  if (await databaseFingerprint(sql) !== fingerprint) throw new Error("Database changed during migration; keep source and repeat from a new checkpoint");
  checkpoint.complete = true;
  await durableJson(checkpointFile, checkpoint);
  return { fingerprint, ...verified };
}
export async function verifyReferenced(sql: SQL, backend: BlobBackend) {
  let count = 0, bytes = 0;
  const hash = createHash("sha256");
  for await (const key of referencedKeys(sql)) {
    const verified = await verifyBlob(backend, key);
    hash.update(`${key}:${verified.size}\n`);
    count++; bytes += verified.size;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(count)) throw new Error("Inventory exceeds supported integer range");
  }
  return { count, bytes, objectsFingerprint: hash.digest("hex") };
}
