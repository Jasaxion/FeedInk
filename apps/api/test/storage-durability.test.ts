import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store, hash, type SQL } from "../src/core.js";
import { durableDirectory, syncDirectory } from "../src/storage/backend.js";
import { FilesystemBackend } from "../src/storage/filesystem.js";
import { copyBlob } from "../src/storage/copy.js";

function connection(references: Set<string>, commit: () => void = () => {}) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query === "COMMIT") commit();
    return query.includes("SELECT EXISTS") ? [{ found: references.has(values[0] as string) }] : [];
  }) as unknown as SQL;
}

for (const failedEdge of ["parent", "root"] as const) {
  test(`durableDirectory retries existing directories after one-time ${failedEdge} fsync failure without crossing root`, async t => {
    const root = await mkdtemp(join(tmpdir(), "feedink-barrier-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const parent = join(root, "ab"), leaf = join(parent, "cd"), failed = failedEdge === "parent" ? parent : root;
    const calls: string[] = []; let armed = true;
    const synchronize = async (directory: string) => {
      calls.push(directory);
      assert.ok(directory === root || directory.startsWith(root + "/"), "never fsync an unrelated/read-only mount ancestor");
      if (directory === failed && armed) {
        armed = false;
        assert.equal((await lstat(leaf)).isDirectory(), true, "mkdir already happened before the failed barrier");
        throw Object.assign(new Error("one-time directory fsync failure"), { code: "EIO" });
      }
      await syncDirectory(directory);
    };
    await assert.rejects(durableDirectory(leaf, root, synchronize), /one-time/);
    assert.equal((await lstat(leaf)).isDirectory(), true);
    calls.length = 0;
    await durableDirectory(leaf, root, synchronize);
    assert.deepEqual(calls, [leaf, parent, root], "existing entries do not bypass any edge barrier");
    await assert.rejects(durableDirectory(join(root, "missing-root", "child"), join(root, "missing-root")), /pre-provisioned/);
    await assert.rejects(durableDirectory(dirname(root), root), /outside/);
    assert.ok(!calls.includes(dirname(root)));
  });
}

test("filesystem publication cannot COMMIT until a previously failed fanout parent barrier succeeds", async t => {
  const root = await mkdtemp(join(tmpdir(), "feedink-publish-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), bytes = Buffer.from("publish barrier"), key = hash(bytes);
  const parent = join(root, key.slice(0, 2)), leaf = dirname(store.path(key)), events: string[] = [];
  let armed = true, commits = 0;
  const backend = new FilesystemBackend(root, async directory => {
    events.push(directory);
    if (directory === parent && armed) { armed = false; throw new Error("parent fsync failed"); }
    await syncDirectory(directory);
  });
  (store as any).backendPromise = Promise.resolve(backend);
  await store.init(); events.length = 0;
  const sql = connection(new Set(), () => { commits++; events.push("COMMIT"); });
  await assert.rejects(store.writeTransaction(sql, put => put(bytes)), /parent fsync failed/);
  assert.equal(commits, 0); assert.equal((await lstat(leaf)).isDirectory(), true);
  events.length = 0;
  await store.writeTransaction(sql, put => put(bytes));
  assert.deepEqual(events, [leaf, parent, root, leaf, "COMMIT"]);
  assert.deepEqual(await store.get(key), bytes);
  assert.deepEqual(await readdir(store.stagingDirectory), []);
});

test("restart recovery retains its journal across failed fanout fsync and re-establishes every edge on retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "feedink-recovery-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), bytes = Buffer.from("recovery barrier"), key = hash(bytes), references = new Set([key]);
  await store.init();
  await assert.rejects(store.writeTransaction(connection(references, () => { throw new Error("lost COMMIT response"); }), put => put(bytes)));
  const parent = join(root, key.slice(0, 2)), leaf = dirname(store.path(key));
  await rm(store.path(key)); await rmdir(leaf);
  const events: string[] = []; let armed = true;
  (store as any).backendPromise = Promise.resolve(new FilesystemBackend(root, async directory => {
    events.push(directory);
    if (directory === parent && armed) { armed = false; throw new Error("recovery parent fsync failed"); }
    await syncDirectory(directory);
  }));
  await assert.rejects(store.recover(connection(references)), /parent fsync failed/);
  assert.equal((await readdir(store.stagingDirectory)).length, 1);
  assert.equal((await lstat(leaf)).isDirectory(), true);
  events.length = 0;
  await store.recover(connection(references));
  assert.deepEqual(events, [leaf, parent, root, leaf]);
  assert.deepEqual(await store.get(key), bytes); assert.deepEqual(await readdir(store.stagingDirectory), []);
});

test("copy retries a failed mkdir-parent barrier without trusting the surviving destination directory", async t => {
  const directory = await mkdtemp(join(tmpdir(), "feedink-copy-barrier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source"), root = join(directory, "target"), scratch = join(root, ".copy");
  await mkdir(sourceRoot); await mkdir(root); await syncDirectory(directory);
  await durableDirectory(scratch, root);
  const bytes = Buffer.from("copy barrier"), key = hash(bytes), source = new FilesystemBackend(sourceRoot);
  await writeFile(join(sourceRoot, key), bytes);
  const parent = join(root, key.slice(0, 2)), leaf = join(parent, key.slice(2, 4)), events: string[] = [];
  let armed = true;
  const target = new FilesystemBackend(root, async directory => {
    events.push(directory);
    if (directory === parent && armed) { armed = false; throw new Error("copy parent fsync failed"); }
    await syncDirectory(directory);
  });
  await assert.rejects(copyBlob(source, target, scratch, key), /parent fsync failed/);
  events.length = 0;
  await copyBlob(source, target, scratch, key);
  assert.deepEqual(events, [leaf, parent, root, leaf]);
  assert.deepEqual(await readFile(target.path(key)), bytes);
  assert.deepEqual(await readFile(join(sourceRoot, key)), bytes, "source retained after failure and retry");
});
