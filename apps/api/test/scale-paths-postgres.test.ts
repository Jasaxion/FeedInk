import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { connect, type Config } from "../src/core.js";
import { upstreamFixture } from "./fixture.js";

const hosted = process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
test("scale counters: real ingest, OPML, save URL, portable restore, demo and sidebar routes", {
  skip: !hosted || !process.env.TEST_DATABASE_URL, timeout: 180000,
}, async () => {
  const fixture = await upstreamFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "feedink-scale-paths-"));
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir, appUrl: "http://localhost:3000", sessionSecret: "synthetic-scale-session-secret-at-least-32", host: "127.0.0.1", port: 0, registration: true, fetchAllowHosts: ["127.0.0.1"], webDir: join(dataDir, "no-web"), worker: false };
  const db = connect(config);
  const { app, articles, archives } = await createApp(config, db);
  type Session = { id: string; cookie: string; csrf: string };
  const owners: string[] = [];
  const account = async (demo = false): Promise<Session> => {
    const response = await app.inject({ method: "POST", url: demo ? "/api/auth/demo" : "/api/auth/register", payload: demo ? {} : { email: `${randomUUID()}@example.invalid`, password: "synthetic-password-long", name: "Synthetic" } });
    assert.ok(response.statusCode === 200 || response.statusCode === 201);
    const body = response.json(); owners.push(body.user.id);
    return { id: body.user.id, cookie: String(response.headers["set-cookie"]).split(";")[0], csrf: body.csrfToken };
  };
  const request = (session: Session, method: string, path: string, payload?: any) => app.inject({ method: method as any, url: `/api${path}`, payload, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
  const audit = async () => {
    const [row] = await db.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL statement_timeout='20s'`;
      return sql`SELECT scale_audit_counts()::integer AS drift`;
    });
    assert.equal(row.drift, 0);
  };
  try {
    const a = await account(), b = await account(), c = await account();
    const folder = (await request(a, "POST", "/folders", { name: "Synthetic" })).json();
    const subscribe = await request(a, "POST", "/subscriptions", { url: fixture.base + "/feed", folderId: folder.id });
    assert.equal(subscribe.statusCode, 201);
    const subscription = subscribe.json();
    assert.equal(subscription.totalCount, 2);
    assert.equal((await request(a, "GET", "/folders")).json().items[0].unreadCount, 2);
    await audit();
    const first = (await articles.page(a.id, { limit: 1 })).items[0];
    const tag = (await request(a, "POST", "/tags", { name: "Synthetic" })).json();
    const patch = await request(a, "PATCH", `/articles/${first.id}/state`, { read: true, saved: true, tagIds: [tag.id] });
    assert.equal(patch.statusCode, 200);
    assert.equal((await request(a, "GET", "/folders")).json().items[0].unreadCount, 1);
    assert.equal((await request(a, "GET", "/tags")).json().items[0].count, 1);
    const counts = [...await db`SELECT * FROM article_counts WHERE user_id=${a.id} ORDER BY tag_key,feed_key`];
    assert.equal((await request(a, "POST", `/subscriptions/${subscription.id}/refresh`, {})).statusCode, 200);
    assert.deepEqual([...await db`SELECT * FROM article_counts WHERE user_id=${a.id} ORDER BY tag_key,feed_key`], counts, "duplicate/304 ingest has no counter delta");
    const opml = (await request(a, "GET", "/export/opml")).body;
    const imported = await request(b, "POST", "/import/opml", { content: opml });
    assert.equal(imported.statusCode, 200); assert.equal(imported.json().imported, 1);
    assert.equal((await articles.page(b.id, {})).total, 2);
    const saved = await request(a, "POST", "/articles/save-url", { url: fixture.base + "/saved" });
    assert.equal(saved.statusCode, 201);
    assert.equal((await articles.page(a.id, { scope: "saved" })).total, 2);
    const beforeFulltext = [...await db`SELECT *,xmin::text AS version FROM article_counts WHERE user_id=${a.id} ORDER BY tag_key,feed_key`];
    assert.equal((await request(a, "POST", `/articles/${saved.json().id}/fulltext`, {})).statusCode, 200);
    assert.deepEqual([...await db`SELECT *,xmin::text AS version FROM article_counts WHERE user_id=${a.id} ORDER BY tag_key,feed_key`], beforeFulltext);
    await audit();
    const zip = await archives.export(a.id);
    assert.equal((await archives.import(c.id, zip)).imported, 3);
    assert.equal((await archives.import(c.id, zip)).skipped, 3);
    assert.equal((await articles.page(c.id, { scope: "archive" })).total, 3);
    assert.equal((await articles.tags(c.id))[0].count, 1);
    await audit();
    assert.equal((await request(a, "DELETE", `/subscriptions/${subscription.id}`)).statusCode, 204);
    assert.equal((await articles.page(a.id, {})).total, 1);
    assert.equal((await articles.page(a.id, { scope: "archive" })).total, 3);
    assert.equal((await request(a, "GET", "/folders")).json().items[0].unreadCount, 0);
    const demo = await account(true);
    assert.equal((await articles.page(demo.id, { scope: "archive" })).total, 20);
    assert.equal((await articles.page(a.id, { scope: "archive" })).total, 3);
    await audit();
    await db`DELETE FROM users WHERE id IN ${db(owners)}`;
    assert.equal((await db`SELECT * FROM article_counts WHERE user_id IN ${db(owners)}`).length, 0);
    await audit();
  } finally {
    await db`DELETE FROM users WHERE id IN ${db(owners.length ? owners : [randomUUID()])}`;
    await app.close(); await db.end({ timeout: 5 });
    await fixture.close(); await rm(dataDir, { recursive: true, force: true });
  }
});
