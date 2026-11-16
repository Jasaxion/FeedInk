import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { hash, id, migrate, Store } from "../src/core.js";

function childFixture(args: string[]) {
  const child = fork(new URL("./storage-process-fixture.ts", import.meta.url), args, {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  let received = false;
  const message = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Writer fixture barrier timeout")); }, 15000);
    child.once("message", value => { received = true; clearTimeout(timer); resolve(value); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!received) reject(new Error("Writer exited before witness")); });
  });
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024) child.kill("SIGKILL");
  });
  return { child, message };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL");
  await Promise.race([exited, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Writer termination timeout")), 5000); timer.unref();
  })]);
}

test("owned writer SIGKILL before/after COMMIT and a new recovery process preserve every committed reference", {
  skip: !process.env.TEST_STORAGE_DATABASE_URL, timeout: 90000,
}, async t => {
  const db = postgres(process.env.TEST_STORAGE_DATABASE_URL!, { max: 2, connect_timeout: 5 });
  await migrate(db);
  const owner = id(), children: ChildProcess[] = [], directories: string[] = [];
  await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},${`writer-${owner}@example.invalid`},'Synthetic writer','disabled')`;
  t.after(async () => {
    for (const child of children) await stop(child);
    await db`DELETE FROM users WHERE id=${owner}`; await db.end();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });
  for (const phase of ["before", "after"]) {
    const directory = await mkdtemp(join(tmpdir(), "feedink-process-witness-")); directories.push(directory);
    const article = id(), image = id(), bytes = Buffer.from(`synthetic writer ${phase}`), key = hash(bytes);
    const writer = childFixture(["write", phase, directory, owner, article, image]); children.push(writer.child);
    const witness = await writer.message;
    assert.deepEqual(witness, { type: "barrier", phase, key, journals: 1 });
    assert.deepEqual(await readFile(new Store(directory).path(key)), bytes, "published bytes exist before COMMIT barrier");
    const [{ present }] = await db`SELECT EXISTS(SELECT 1 FROM images WHERE id=${image}) AS present`;
    assert.equal(present, phase === "after", "observer sees only acknowledged server COMMIT");
    await stop(writer.child); assert.equal(writer.child.signalCode, "SIGKILL");
    const probe = await db.reserve();
    try {
      let released = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await probe`SELECT pg_try_advisory_lock(71244004) AS acquired`;
        if (row.acquired) { await probe`SELECT pg_advisory_unlock(71244004)`; released = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(released, true, "dead writer's DB session releases global coordination");
    } finally { probe.release(); }
    const recovery = childFixture(["recover", phase, directory, owner, article, image]); children.push(recovery.child);
    assert.deepEqual(await recovery.message, { type: "recovered", present: phase === "after", key, journals: 0 });
    assert.deepEqual(await readFile(new Store(directory).path(key)), bytes, "unreferenced unknown finals are retained too");
    await stop(recovery.child);
  }
});
