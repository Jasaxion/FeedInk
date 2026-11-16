// Real production-logger HTTP fixture; only spawned by the hosted storage acceptance test.
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createApp } from "../src/app.js";
import { hash, id, type Config } from "../src/core.js";
import type { BlobBackend } from "../src/storage/backend.js";

async function main() {
  if (!process.send || !process.env.TEST_STORAGE_DATABASE_URL) throw new Error("Hosted fixture IPC/database required");
  const [directory, owner, other] = process.argv.slice(2);
  const db = postgres(process.env.TEST_STORAGE_DATABASE_URL, { max: 4, connect_timeout: 5 });
  const config: Config = { databaseUrl: process.env.TEST_STORAGE_DATABASE_URL, dataDir: directory,
    appUrl: "http://127.0.0.1:3000", sessionSecret: "synthetic-http-storage-session-secret-32-characters",
    host: "127.0.0.1", port: 0, registration: false, fetchAllowHosts: [], webDir: directory + "/no-web", worker: false };
  const ctx = await createApp(config, db);
  const tokens: string[] = [];
  for (const user of [owner, other]) {
    await db`INSERT INTO users(id,email,name,password_hash) VALUES(${user},${`stream-${user}@example.invalid`},'Synthetic stream','disabled')`;
    const token = randomBytes(32).toString("base64url"); tokens.push(token);
    await db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${user},now()+interval '1 hour')`;
  }
  const article = id(), image = id(), feed = id(), ebook = id(), bytes = Buffer.from("synthetic owned bytes");
  const sql = await db.reserve();
  try {
    await ctx.store.writeTransaction(sql, async put => {
      const key = await put(bytes);
      await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${article},${owner},${article},'Synthetic',now(),'Stream','https://example.invalid/stream','<p>Stream</p>','Stream',${hash('<p>Stream</p>')})`;
      await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_type,content_hash) VALUES(${image},${article},'https://example.invalid/image','cached',${key},'image/png',${key})`;
      await sql`INSERT INTO feeds(id,user_id,url,title,icon_file_key) VALUES(${feed},${owner},'https://example.invalid/feed','Stream feed',${key})`;
      await sql`INSERT INTO ebooks(id,user_id,title,article_count,file_key) VALUES(${ebook},${owner},'Stream ebook',1,${key})`;
    });
  } finally { sql.release(); }
  const backend = await (ctx.store as any).backend() as BlobBackend, read = backend.read.bind(backend);
  let mode = "normal", sequence = 0;
  const active = new Map<number, Readable>();
  const rawError = () => Object.assign(new Error("SYNTHETIC_BACKEND_PRIVATE_MESSAGE"), {
    code: "SYNTHETIC_BACKEND_PRIVATE_CODE", endpoint: "SYNTHETIC_BACKEND_PRIVATE_ENDPOINT",
  });
  backend.read = async key => {
    const requestId = ++sequence;
    if (mode === "normal") return read(key);
    if (mode === "reject") throw rawError();
    // Keep a real filesystem descriptor open behind the fault adapter. The close witness
    // is sent only after that descriptor closes, not merely when the adapter is destroyed.
    const backing = await read(key);
    backing.on("error", () => {});
    let sent = false;
    const source = new Readable({ read() {
      if (sent) return; sent = true;
      if (mode === "early") this.destroy(rawError());
      else this.push(Buffer.from("partial-owned-body"));
    } });
    active.set(requestId, source);
    source.once("close", () => backing.destroy());
    backing.once("close", () => { active.delete(requestId); process.send?.({ type: "closed", requestId }); });
    return source;
  };
  process.on("message", async (message: any) => {
    try {
      if (message.type === "mode") { mode = message.mode; process.send?.({ type: "mode", sequence }); }
      else if (message.type === "fail") for (const stream of active.values()) stream.destroy(rawError());
      else if (message.type === "state") process.send?.({ type: "state", sequence, active: active.size });
      else if (message.type === "shutdown") {
        await ctx.app.close(); await db.end(); process.send?.({ type: "shutdown" }); process.disconnect();
      }
    } catch { process.send?.({ type: "failure" }); }
  });
  const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  process.send({ type: "ready", address, cookies: tokens.map(token => `feedink_session=${token}`),
    paths: [`/api/assets/${image}`, `/api/feed-icons/${feed}`, `/api/ebooks/${ebook}/download`] });
}
main().catch(() => { process.send?.({ type: "failure" }); process.exitCode = 1; });
