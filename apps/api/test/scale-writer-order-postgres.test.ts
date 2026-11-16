import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../src/app.js";
import { Articles } from "../src/articles.js";
import { Archives } from "../src/archive.js";
import { Annotations } from "../src/annotations.js";
import { type DB, type SQL, type Config, hash } from "../src/core.js";
import { makeZip, readZip } from "../src/zip.js";
import { uuid } from "../src/validation.js";

const hosted = process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic barrier timed out")), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
type Hook = (sql: SQL, text: string, args: unknown[]) => Promise<void>;
// Test-only executor wrapper: intercept awaited queries, not SQL fragments. No
// production hooks, sleeps as synchronization, alternate writer, or retry path.
function observedDb(db: DB, hooks: { before?: Hook; after?: Hook }): DB {
  const wrap = (sql: any): any => new Proxy(sql, {
    apply(target, _receiver, args) {
      const query = Reflect.apply(target, target, args);
      if (!Array.isArray(args[0]) || !("raw" in args[0]) || !query?.then) return query;
      const text = args[0].join("?");
      let work: Promise<unknown> | undefined;
      return new Proxy(query, { get(value, key) {
        if (key === "then") return (resolve: any, reject: any) => {
          work ??= (async () => {
            await hooks.before?.(target, text, args.slice(1));
            const rows = await value;
            await hooks.after?.(target, text, args.slice(1));
            return rows;
          })();
          return work.then(resolve, reject);
        };
        return Reflect.get(value, key, value);
      } });
    },
    get(target, key) {
      if (key === "reserve") return async () => wrap(await target.reserve());
      if (key === "begin") return (...args: any[]) => {
        const callback = args.pop();
        return target.begin(...args, (tx: SQL) => callback(wrap(tx)));
      };
      return Reflect.get(target, key, target);
    },
  });
  return wrap(db);
}
async function blockedOnOwner(sql: SQL, writerPid: number) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const [row] = await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${writerPid} AND locktype='advisory' AND NOT granted) AND pg_backend_pid()=ANY(pg_blocking_pids(${writerPid})) AS blocked`;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The competing writer did not wait on owner coordination before row locks");
}

test("scale writer ordering: two-connection mixed import/tag-delete races finish without deadlock", {
  skip: !hosted || !process.env.TEST_DATABASE_URL, timeout: 180000,
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "feedink-scale-order-"));
  const connection = { statement_timeout: "15000", lock_timeout: "10000" };
  const left = postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection });
  const right = postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection });
  const hooks: { before?: Hook; after?: Hook } = {};
  const db = observedDb(left, hooks);
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir, appUrl: "http://localhost:3000", sessionSecret: "synthetic-scale-order-secret-at-least-32", host: "127.0.0.1", port: 0, registration: true, fetchAllowHosts: [], webDir: join(dataDir, "no-web"), worker: false };
  const { app, store } = await createApp(config, db);
  const articles = new Articles(right), archives = new Archives(db, store, new Articles(db)), notes = new Annotations(right);
  const [{ pid }] = await right`SELECT pg_backend_pid() AS pid`;
  const owners: string[] = [];
  const owner = async () => {
    const id = randomUUID(); owners.push(id);
    await right`INSERT INTO users(id,email,name,password_hash) VALUES(${id},${id + '@example.invalid'},'Synthetic','not-a-password')`;
    return id;
  };
  const audit = async () => {
    const [row] = await right.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout='3s'`; await sql`SET LOCAL statement_timeout='20s'`;
      return sql`SELECT scale_audit_counts()::integer AS drift`;
    });
    assert.equal(row.drift, 0);
  };
  const race = async (first: () => Promise<unknown>, second: () => Promise<unknown>, install: (pause: (sql: SQL) => Promise<void>) => void) => {
    const reached = deferred(), release = deferred();
    let held: SQL | undefined, firstJob: Promise<unknown> | undefined, secondJob: Promise<unknown> | undefined;
    install(async (sql) => { held = sql; reached.resolve(); await release.promise; });
    try {
      firstJob = first(); void firstJob.catch(() => {});
      await bounded(Promise.race([reached.promise, firstJob.then(() => { throw new Error("Writer missed the barrier"); })]));
      secondJob = second(); void secondJob.catch(() => {});
      await blockedOnOwner(held!, pid);
      release.resolve();
      // No 40P01/40001 whitelist and no retries: both compatible requests succeed.
      return await bounded(Promise.all([firstJob, secondJob]));
    } finally {
      hooks.before = undefined; hooks.after = undefined; release.resolve();
      await bounded(Promise.allSettled([firstJob, secondJob])).catch(() => {});
    }
  };
  try {
    for (const annotated of [false, true]) for (const operation of ["state", "bulk"] as const) {
      await t.test(`mixed [duplicate A,new B], annotated=${annotated}, versus ${operation}`, async () => {
        const source = await owner(), target = await owner();
        const a = randomUUID(), b = randomUUID(), sourceTag = randomUUID();
        for (const [index, articleId] of [a, b].entries()) {
          const html = `<p>Synthetic ${index}</p>`;
          await right`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,archived_at,content_html,content_text,content_hash)
            VALUES(${articleId},${source},${articleId},'Synthetic','Synthetic',${'https://example.invalid/' + articleId},now(),${new Date(1700000000000 + index * 1000)},${html},${'Synthetic ' + index},${hash(html)})`;
        }
        await right`INSERT INTO tags(id,user_id,name) VALUES(${sourceTag},${source},'Synthetic')`;
        await right`INSERT INTO article_tags(article_id,tag_id) VALUES(${a},${sourceTag})`;
        if (annotated) {
          const doc = await notes.get(source, a, "feed");
          await notes.save(source, a, "feed", { schemaVersion: 1, contentHash: doc.contentHash, ink: null, marks: [{ id: "note", kind: "note", color: "yellow", anchor: null, text: "Synthetic retained note", createdAt: 1, updatedAt: 1 }] }, 0);
        }
        const full = await archives.export(source), files = await readZip(full);
        const manifest = JSON.parse(files.get("manifest.json")!.toString());
        assert.deepEqual(manifest.articles.map((row: any) => row.id), [a, b]);
        const initial = await makeZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ ...manifest, articles: [manifest.articles[0]] })) }]);
        assert.equal((await archives.import(target, initial)).imported, 1);
        const [existing] = await right`SELECT id,url,content_html,content_hash,state_version FROM articles WHERE user_id=${target}`;
        const beforeNotes = annotated ? await notes.get(target, existing.id, "feed") : null;
        const results = await race(
          () => archives.import(target, full),
          () => operation === "state" ? articles.patch(target, existing.id, { read: true, saved: true }, 0) : articles.bulk(target, true, undefined, { scope: "archive" }),
          (pause) => {
            hooks.before = async (sql, text) => {
              if (text.includes("71244005")) {
                const [lock] = await sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=0 AND objid=71244004 AND granted) AS blob_locked`;
                assert.equal(lock.blob_locked, true, "Blob lock must precede owner coordination");
              }
            };
            hooks.after = async (sql, text) => {
              if (text.startsWith("SELECT id,url FROM articles") && text.endsWith("FOR UPDATE")) {
                hooks.after = undefined;
                await pause(sql); // The production duplicate/source lock on A is held.
              }
            };
          },
        );
        assert.deepEqual(results[0], { imported: 1, skipped: 1, errors: [] });
        if (operation === "bulk") assert.deepEqual(results[1], { updated: 2 });
        const [after] = await right`SELECT id,url,content_html,content_hash,state_version,read FROM articles WHERE id=${existing.id}`;
        assert.equal(after.id, existing.id); assert.equal(after.url, existing.url);
        assert.equal(after.content_html, existing.content_html); assert.equal(after.content_hash, existing.content_hash);
        assert.equal(after.state_version, 1); assert.equal(after.read, true);
        if (annotated) {
          const afterNotes = await notes.get(target, existing.id, "feed");
          assert.equal(afterNotes.revision, beforeNotes!.revision);
          assert.deepEqual(afterNotes.marks, beforeNotes!.marks);
          assert.deepEqual(afterNotes.context, beforeNotes!.context);
        }
        await assert.rejects(articles.patch(target, existing.id, { saved: false }, 0), (error: any) => error.code === "STATE_CONFLICT");
        await audit();
      });
    }
    for (const operation of ["state", "tags"] as const) {
      await t.test(`tag deletion versus ${operation} patch`, async () => {
        const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `${randomUUID()}@example.invalid`, name: "Synthetic", password: "synthetic-password-long" } });
        assert.equal(response.statusCode, 201);
        const session = response.json(), userId = session.user.id; owners.push(userId);
        const articleId = randomUUID(), deletedTag = randomUUID(), retainedTag = randomUUID();
        await right`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) VALUES(${articleId},${userId},${articleId},'Synthetic','Synthetic','https://example.invalid/tag-race',now(),'<p>Stable source</p>','Stable source',${hash('<p>Stable source</p>')})`;
        await right`INSERT INTO tags(id,user_id,name) VALUES(${deletedTag},${userId},'Deleted'),(${retainedTag},${userId},'Retained')`;
        await right`INSERT INTO article_tags(article_id,tag_id) VALUES(${articleId},${deletedTag})`;
        const context = await notes.get(userId, articleId, "feed");
        await notes.save(userId, articleId, "feed", { schemaVersion: 1, contentHash: context.contentHash, ink: null, marks: [] }, 0);
        const results = await race(
          async () => app.inject({ method: "DELETE", url: `/api/tags/${deletedTag}`, headers: { cookie: String(response.headers["set-cookie"]).split(";")[0], "x-csrf-token": session.csrfToken } }),
          () => articles.patch(userId, articleId, operation === "tags" ? { tagIds: [retainedTag], read: true } : { read: true }, 0),
          (pause) => { hooks.before = async (sql, text) => {
            if (text.startsWith("DELETE FROM tags WHERE")) {
              hooks.before = undefined;
              // Hold the exact tag -> member-article row prefix that the delete
              // trigger takes, before its counter delta, on the route connection.
              await sql`SELECT id FROM tags WHERE id=${deletedTag} FOR UPDATE`;
              await sql`SELECT id FROM articles WHERE id=${articleId} FOR UPDATE`;
              await pause(sql);
            }
          }; },
        );
        assert.equal((results[0] as any).statusCode, 204);
        const detail = await articles.detail(userId, articleId);
        assert.equal(detail.stateVersion, 1); assert.equal(detail.read, true);
        assert.deepEqual(detail.tags.map((tag) => tag.id), operation === "tags" ? [retainedTag] : []);
        assert.equal(detail.contentHtml, "<p>Stable source</p>");
        const afterNotes = await notes.get(userId, articleId, "feed");
        assert.equal(afterNotes.revision, 1); assert.deepEqual(afterNotes.context, context.context);
        await audit();
      });
    }
    await t.test("portable archive eligibility stops at 1001 rows before body aggregation", async () => {
      const target = await owner();
      await right`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash)
        SELECT gen_random_uuid(),${target},i::text,'Synthetic','Synthetic','https://example.invalid/cap',now(),'<p>Body</p>','Body','synthetic' FROM generate_series(1,1001) i`;
      let boundedProbe = false, bodyProbe = false;
      hooks.before = async (_sql, text) => {
        if (text.includes("LIMIT 1001) eligible")) boundedProbe = true;
        if (text.includes("to_jsonb(a)")) bodyProbe = true;
      };
      try { await assert.rejects(archives.export(target), (error: any) => error.code === "ARCHIVE_LIMIT" && error.statusCode === 413 && error.message === "Archive supports at most 1000 articles"); }
      finally { hooks.before = undefined; }
      assert.equal(boundedProbe, true); assert.equal(bodyProbe, false);
      await audit();
    });
    await t.test("benchmark UUID mapping and deep cursor contract before seeding", async () => {
      const schema = `scale_seed_${randomUUID().replaceAll("-", "")}`;
      await right.begin(async (sql) => {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`SET LOCAL search_path=${schema},public`);
        await sql.unsafe(await readFile(new URL("../../../scripts/scale-seed-ids.sql", import.meta.url), "utf8"));
        const ids = new Set<string>();
        for (const tier of [10000, 100000, 1000000]) for (const i of [1, 997, Math.floor(tier * .9), tier]) {
          const [row] = await sql`SELECT scale_seed_uuid(${'article-1-' + i}) AS article_id,scale_seed_uuid(${'image-' + i}) AS image_id,scale_seed_uuid(${'article-1-' + i}) AS member_article_id`;
          assert.equal(row.article_id, row.member_article_id);
          for (const id of [row.article_id, row.image_id]) { uuid.parse(id); assert.equal(id[14], '8'); assert.equal(id[19], '8'); }
          ids.add(row.article_id);
          for (const sort of ["newest", "oldest"] as const) articles.selection(owners[0], { scope: "archive", sort, cursor: Buffer.from(JSON.stringify({ id: row.article_id, date: "2026-01-01T00:00:00.000123Z" })).toString("base64url") });
        }
        assert.equal(ids.size, 8);
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      });
    });
  } finally {
    hooks.before = undefined; hooks.after = undefined;
    if (owners.length) await right`DELETE FROM users WHERE id IN ${right(owners)}`;
    await app.close(); await left.end({ timeout: 5 }); await right.end({ timeout: 5 });
    await rm(dataDir, { recursive: true, force: true });
  }
});
