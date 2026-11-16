import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { FilesystemBackend } from "../src/storage/filesystem.js";
import { packReferenced, unpackReferenced, referencedManifest, validateReferencedManifest, MAX_PART_OBJECTS } from "../src/storage/bundle.js";
import type { BlobBackend } from "../src/storage/backend.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fingerprint = hash("synthetic complete PostgreSQL rows");
function source(entries: [string, Buffer][]): BlobBackend {
  const objects = new Map(entries);
  return { async init() {}, identity: () => "synthetic", async size(key) { return objects.get(key)!.length; },
    async read(key) { if (!objects.has(key)) throw new Error("missing"); return Readable.from([objects.get(key)!]); },
    async publish() { throw new Error("read only"); }, async assertEmpty() { throw new Error("not empty"); } };
}
async function packed(entries: [string, Buffer][]) {
  const output = new PassThrough(), chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(chunk));
  await packReferenced(source(entries), (async function* () { for (const [key] of entries) yield key; })(), fingerprint, output);
  return Buffer.concat(chunks);
}
function split(bytes: Buffer) { return Readable.from((function* () { for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7); })()); }

test("referenced bundle round trips exact binary bytes with bounded part manifests and no source deletion", async t => {
  const directory = await mkdtemp(join(tmpdir(), "feedink-bundle-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 13, 10, 42]), key = hash(bytes);
  const encoded = await packed([[key, bytes]]);
  const checked = await unpackReferenced(split(encoded), fingerprint);
  assert.deepEqual(checked, { count: 1, bytes: bytes.length, parts: 1, fingerprint });
  const backend = new FilesystemBackend(directory);
  await unpackReferenced(split(encoded), fingerprint, { backend, scratch: join(directory, ".restore") });
  assert.deepEqual(await readFile(backend.path(key)), bytes);
  await assert.rejects(unpackReferenced(split(encoded), fingerprint, { backend, scratch: join(directory, ".restore") }), /empty blob target/);
  assert.deepEqual(await readFile(backend.path(key)), bytes);
});

test("referenced bundle rolls independently verified parts without an archive-wide name set", async () => {
  const entries: [string, Buffer][] = Array.from({ length: MAX_PART_OBJECTS + 1 }, (_, index) => {
    const bytes = Buffer.from(`synthetic ${index}`); return [hash(bytes), bytes];
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  const checked = await unpackReferenced(split(await packed(entries)), fingerprint);
  assert.equal(checked.parts, 2); assert.equal(checked.count, MAX_PART_OBJECTS + 1);
});

test("referenced bundle rejects corruption, missing/footer bytes, duplicate keys and fingerprint substitution before target writes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "feedink-bundle-refusal-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("unique-payload"), key = hash(bytes), encoded = await packed([[key, bytes]]);
  const corrupt = Buffer.from(encoded); corrupt[corrupt.indexOf(bytes)] ^= 1;
  await assert.rejects(unpackReferenced(split(corrupt), fingerprint), /integrity mismatch/);
  for (const invalid of [encoded.subarray(0, -1), Buffer.concat([encoded, Buffer.from("unexpected")]), Buffer.from(encoded.toString().replace('"number":0', '"number":1'))])
    await assert.rejects(unpackReferenced(split(invalid), fingerprint));
  await assert.rejects(unpackReferenced(split(encoded), hash("different owner/context snapshot")), /manifest mismatch/);
  await assert.rejects(packed([[key, bytes], [key, bytes]]), /strictly increasing/);
  assert.deepEqual(await readdir(directory), [], "preflight never receives a writable target");
});

test("referenced bundle rejects oversized headers/objects and version1 is not silently reinterpreted", async () => {
  for (const body of ["x".repeat(9000), '{"type":"blob","key":"' + "a".repeat(64) + '","size":999999999999}\n', '{"type":"end","parts":0,"count":0,"bytes":0,"fingerprint":"bad"}\n']) {
    await assert.rejects(unpackReferenced(Readable.from([Buffer.from("FEEDINK-REFERENCED-BLOBS-2\n" + body)])));
  }
  await assert.rejects(unpackReferenced(Readable.from([Buffer.from('FEEDINK-DATA-1\n{"end":true}\n')])), /Unsupported/);
  const checked = await unpackReferenced(split(await packed([])), fingerprint);
  assert.deepEqual(checked, { count: 0, bytes: 0, parts: 0, fingerprint });
});

test("referenced manifest binds paired PostgreSQL dump, blob stream and complete-row fingerprint", () => {
  const pg = hash("dump"), blobs = hash("blob parts"), manifest = referencedManifest(pg, blobs, fingerprint);
  assert.equal(validateReferencedManifest(manifest), `${pg} ${blobs} ${fingerprint}`);
  for (const invalid of [{ ...manifest, version: 1 }, { ...manifest, scope: "whole-volume" }, { ...manifest, fingerprint: "invalid" }, { ...manifest, files: { ...manifest.files, extra: pg } }]) {
    assert.throws(() => validateReferencedManifest(invalid));
  }
});
