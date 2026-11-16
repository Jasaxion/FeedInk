import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type SQL } from "../src/core.js";
import { FilesystemBackend } from "../src/storage/filesystem.js";
import { copyBlob } from "../src/storage/copy.js";
import { digest, fanoutKey } from "../src/storage/backend.js";
import { storageConfigFromEnv, validateStorageConfig } from "../src/storage/config.js";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function connection(options: { references?: Set<string>; commit?: () => void; rollback?: () => void } = {}) {
  let locks = 0;
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?"); calls.push(query);
    if (query.includes("pg_advisory_unlock")) locks--;
    else if (query.includes("pg_advisory_lock")) locks++;
    if (query === "COMMIT") options.commit?.();
    if (query === "ROLLBACK") options.rollback?.();
    return query.includes("SELECT EXISTS") ? [{ found: options.references?.has(values[0] as string) || false }] : [];
  }) as unknown as SQL;
  return { sql, calls, get locks() { return locks; } };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "feedink-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); await store.init();
  return { directory, store };
}

test("storage config remains optional and deployment-only with explicit HTTP opt-in", () => {
  assert.equal(storageConfigFromEnv({}), undefined);
  assert.deepEqual(validateStorageConfig(), { backend: "filesystem" });
  for (const endpoint of ["http://127.0.0.1:9000", "https://user:secret@example.invalid", "https://example.invalid/path", "https://example.invalid/?token=x"]) {
    assert.throws(() => validateStorageConfig({ backend: "s3", bucket: "synthetic", region: "us-east-1", endpoint }));
  }
  assert.equal(validateStorageConfig({ backend: "s3", bucket: "synthetic", region: "us-east-1", endpoint: "http://127.0.0.1:9000", allowHttp: true }).backend, "s3");
  assert.throws(() => validateStorageConfig({ backend: "s3", bucket: "synthetic", region: "us-east-1", prefix: "../" }));
});

test("Store writes immutable hash fanout and reads legacy exact bytes without changing keys", async t => {
  const { directory, store } = await fixture(t), db = connection();
  const bytes = Buffer.from([0, 255, 10, 13, 42]), key = hash(bytes);
  await writeFile(join(directory, key), bytes);
  assert.deepEqual(await store.get(key), bytes);
  assert.equal(await store.size(key), bytes.length);
  assert.equal(await store.writeTransaction(db.sql, put => put(bytes)), key);
  assert.equal(store.path(key), join(directory, fanoutKey(key)));
  assert.deepEqual(await readFile(store.path(key)), bytes);
  assert.deepEqual(await readFile(join(directory, key)), bytes, "legacy original retained");
  assert.deepEqual(await digest(await store.stream(key)), { key, size: bytes.length });
  assert.deepEqual(await readdir(store.stagingDirectory), []);
  assert.equal(db.locks, 0);
  await assert.rejects(store.get("../anything"), /Invalid storage key/);
});

test("Store rollback before publish cleans only owned staging; a failed publish retains unknown finals", async t => {
  const { store } = await fixture(t), db = connection(), bytes = Buffer.from("interruption fixture"), key = hash(bytes);
  await assert.rejects(store.writeTransaction(db.sql, async put => { await put(bytes); throw new Error("before publish"); }), /before publish/);
  await assert.rejects(store.get(key), { code: "ENOENT" });
  assert.deepEqual(await readdir(store.stagingDirectory), []);
  const backend = await (store as any).backend() as FilesystemBackend;
  const publish = backend.publish.bind(backend);
  backend.publish = async (key, file) => { await publish(key, file); throw new Error("after publish, before commit"); };
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)), /after publish/);
  assert.deepEqual(await store.get(key), bytes, "published outcome is never blindly deleted");
  assert.ok(!db.calls.includes("COMMIT")); assert.equal(db.locks, 0);
});

test("Store ambiguous COMMIT retains durable intent even when a subsequent ROLLBACK succeeds", async t => {
  const { store } = await fixture(t), bytes = Buffer.from("committed shared bytes"), key = hash(bytes), references = new Set<string>();
  const db = connection({ references, commit: () => { references.add(key); throw new Error("commit acknowledgement lost"); } });
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)), /acknowledgement lost/);
  assert.equal((await readdir(store.stagingDirectory)).length, 1);
  assert.deepEqual(await store.get(key), bytes);
  await store.recover(db.sql);
  assert.deepEqual(await readdir(store.stagingDirectory), []);
  assert.deepEqual(await store.get(key), bytes);
  assert.equal(db.locks, 0);
});

test("Store unknown uncommitted outcomes retain shared final bytes and recovery repairs missing committed publishes", async t => {
  const { store } = await fixture(t), bytes = Buffer.from("missing committed publish"), key = hash(bytes), references = new Set<string>();
  const db = connection({ references, commit: () => { throw new Error("unknown commit"); }, rollback: () => { throw new Error("connection lost"); } });
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)), /unknown commit/);
  const recovered = connection({ references });
  references.add(key);
  await rm(store.path(key));
  await store.recover(recovered.sql);
  assert.deepEqual(await store.get(key), bytes);
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)));
  references.clear();
  await store.recover(recovered.sql);
  assert.deepEqual(await store.get(key), bytes, "unreferenced does not mean safe to delete");
});

test("Store rejects corrupt immutable destination and preserves evidence on corrupt referenced recovery", async t => {
  const { store } = await fixture(t), bytes = Buffer.from("correct bytes"), key = hash(bytes), references = new Set([key]);
  const db = connection({ references, commit: () => { throw new Error("unknown"); } });
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)), /unknown/);
  await writeFile(store.path(key), "corruption");
  await assert.rejects(store.recover(connection({ references }).sql), /integrity mismatch/);
  assert.equal((await readdir(store.stagingDirectory)).length, 1);
  await assert.rejects(store.writeTransaction(connection().sql, put => put(bytes)), /integrity mismatch/);
  assert.equal(await readFile(store.path(key), "utf8"), "corruption", "collision is not overwritten");
});

test("Store recovery refuses a journal backend fingerprint mismatch without removing evidence", async t => {
  const { store } = await fixture(t), bytes = Buffer.from("journal identity"), key = hash(bytes);
  const db = connection({ references: new Set([key]), commit: () => { throw new Error("interrupted"); } });
  await assert.rejects(store.writeTransaction(db.sql, put => put(bytes)), /interrupted/);
  const [name] = await readdir(store.stagingDirectory), intentPath = join(store.stagingDirectory, name, "intent.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  await writeFile(intentPath, JSON.stringify({ ...intent, backend: "0".repeat(64) }));
  await assert.rejects(store.recover(db.sql), /backend mismatch/);
  assert.equal((await readdir(store.stagingDirectory)).length, 1);
  assert.deepEqual(await store.get(key), bytes);
  assert.equal(db.locks, 0);
});

test("Store recovery bounds journal work and leaves legacy root discovery to explicit maintenance", async t => {
  const { directory, store } = await fixture(t), references = new Set<string>(), db = connection({ references, commit: () => { throw new Error("interrupted"); } });
  for (let i = 0; i < 3; i++) await assert.rejects(store.writeTransaction(db.sql, put => put(Buffer.from(`fixture ${i}`))));
  const bytes = Buffer.from("legacy referenced"), key = hash(bytes), orphanBytes = Buffer.from("legacy orphan"), orphan = hash(orphanBytes);
  const legacy = await mkdtemp(join(directory, ".stage-"));
  await writeFile(join(legacy, key), bytes); references.add(key);
  await writeFile(join(legacy, orphan), orphanBytes); await link(join(legacy, orphan), join(directory, orphan));
  const recovery = connection({ references });
  const first = await store.recover(recovery.sql, 1);
  assert.equal(first.processed, 1); assert.equal(first.remainingPossible, true);
  assert.equal((await readdir(store.stagingDirectory)).length, 2);
  assert.deepEqual((await readdir(legacy)).sort(), [key, orphan].sort());
  await store.recover(recovery.sql);
  await store.recoverLegacy(recovery.sql);
  await assert.rejects(readdir(legacy), { code: "ENOENT" });
  assert.deepEqual(await store.get(key), bytes); assert.deepEqual(await store.get(orphan), orphanBytes);
});

test("copyBlob retains exact source bytes, rejects missing/corrupt source and verifies preexisting targets", async t => {
  const { directory } = await fixture(t);
  const source = new FilesystemBackend(join(directory, "source")), target = new FilesystemBackend(join(directory, "target"));
  await source.init(); await target.init();
  const scratch = join(target.directory, ".scratch"); await mkdir(scratch);
  const bytes = Buffer.from([0, 1, 10, 255]), key = hash(bytes);
  await writeFile(join(source.directory, key), bytes);
  await copyBlob(source, target, scratch, key); await copyBlob(source, target, scratch, key);
  assert.deepEqual(await readFile(join(source.directory, key)), bytes);
  assert.deepEqual(await digest(await target.read(key)), { key, size: bytes.length });
  await writeFile(target.path(key), "corrupt destination");
  await assert.rejects(copyBlob(source, target, scratch, key), /integrity mismatch/);
  await assert.rejects(copyBlob(source, target, scratch, "f".repeat(64)), { code: "ENOENT" });
  await writeFile(join(source.directory, key), "corrupt source");
  await assert.rejects(copyBlob(source, target, scratch, key), /Source blob integrity mismatch/);
});
