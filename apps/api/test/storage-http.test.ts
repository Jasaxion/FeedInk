import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { id } from "../src/core.js";

function request(url: string, cookie: string, firstChunk?: () => void, cancel = false) {
  return new Promise<{ status: number; complete: boolean; body: string }>((resolve, reject) => {
    const req = get(url, { headers: { cookie } });
    let responded = false;
    req.setTimeout(5000, () => req.destroy(new Error("HTTP storage fixture timeout")));
    req.on("error", error => { if (!responded) reject(error); });
    req.on("response", response => {
      responded = true; let body = "", seen = false;
      response.on("data", chunk => {
        body += chunk.toString();
        if (body.length > 16384) req.destroy(new Error("HTTP fixture exceeded bound"));
        if (!seen) { seen = true; firstChunk?.(); if (cancel) req.destroy(); }
      });
      response.on("error", () => {});
      response.once("close", () => resolve({ status: response.statusCode!, complete: response.complete, body }));
    });
  });
}

test("owned image/icon/ebook HTTP streams mask early/mid errors and close backend resources on cancellation", {
  skip: !process.env.TEST_STORAGE_DATABASE_URL, timeout: 120000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "feedink-http-stream-")), owner = id(), other = id();
  const child = fork(new URL("./storage-http-fixture.ts", import.meta.url), [directory, owner, other], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
    logs += chunk.toString(); if (logs.length > 256 * 1024) child.kill("SIGKILL");
  });
  const queue: any[] = [], waiters = new Map<string, (message: any) => void>();
  child.on("message", (message: any) => {
    const waiter = waiters.get(message.type);
    if (waiter) { waiters.delete(message.type); waiter(message); } else queue.push(message);
  });
  const receive = (type: string): Promise<any> => {
    const index = queue.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(type); reject(new Error(`HTTP fixture ${type} witness timeout`)); }, 10000);
      waiters.set(type, message => { clearTimeout(timer); resolve(message); });
    });
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL");
      await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
    }
    const db = postgres(process.env.TEST_STORAGE_DATABASE_URL!, { max: 1 });
    await db`DELETE FROM users WHERE id IN (${owner},${other})`; await db.end();
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await receive("ready");
  const setMode = async (mode: string) => { child.send({ type: "mode", mode }); return receive("mode"); };
  for (const path of ready.paths as string[]) {
    const url = ready.address + path;
    await setMode("normal");
    assert.deepEqual(await request(url, ready.cookies[0]), { status: 200, complete: true, body: "synthetic owned bytes" });
    const { sequence } = await setMode("reject");
    assert.equal((await request(url, ready.cookies[1])).status, 404);
    child.send({ type: "state" }); assert.equal((await receive("state")).sequence, sequence, "owner denial must precede backend open");
    for (const mode of ["reject", "early"]) {
      await setMode(mode);
      const failed = await request(url, ready.cookies[0]);
      assert.equal(failed.status, 500);
      assert.ok(!failed.body.includes("SYNTHETIC_BACKEND_PRIVATE"));
      if (mode === "early") await receive("closed");
    }
    await setMode("held");
    const failed = await request(url, ready.cookies[0], () => child.send({ type: "fail" }));
    assert.equal(failed.status, 200); assert.equal(failed.body, "partial-owned-body");
    assert.equal(failed.complete, false, "mid-body failure must not become successful EOF");
    await receive("closed");
    await setMode("held");
    const cancelled = await request(url, ready.cookies[0], undefined, true);
    assert.equal(cancelled.complete, false);
    await receive("closed");
    child.send({ type: "state" }); assert.equal((await receive("state")).active, 0);
  }
  child.send({ type: "shutdown" }); await receive("shutdown");
  assert.ok(logs.includes('"level"'), "production logger output was actually captured");
  assert.ok(!logs.includes("SYNTHETIC_BACKEND_PRIVATE"), "Fastify late-stream logs must not contain raw backend error details");
});
