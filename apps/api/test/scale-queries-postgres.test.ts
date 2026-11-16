import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type { ArticleQuery } from "@feedink/shared";
import { Articles } from "../src/articles.js";
import { Feeds } from "../src/feeds.js";
import type { Content } from "../src/content.js";
import type { SafeFetcher } from "../src/network.js";
import { countSnapshot, commonArticleTotal } from "../src/scale-counts.js";

const hosted = process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";

// Independent schema exercises an actual 006 -> 007 maintenance backfill, not
// merely an empty install. Never connects outside the approved hosted runner.
test("scale queries: backfill, exact snapshots, DML counters, CAS and reconciliation", {
  skip: !hosted || !process.env.TEST_DATABASE_URL, timeout: 180000,
}, async (t) => {
  const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  const schema = `scale_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const db = postgres(process.env.TEST_DATABASE_URL!, { max: 6, connection: { search_path: schema }, onnotice: () => {} });
  const articles = new Articles(db);
  const feeds = new Feeds(db, {} as SafeFetcher, {} as Content);
  const owner = randomUUID(), other = randomUUID(), feed = randomUUID(), dormant = randomUUID();
  const folder = randomUUID(), subscription = randomUUID(), tag = randomUUID(), otherTag = randomUUID();
  const ids = Array.from({ length: 12 }, () => randomUUID());
  const insert = async (articleId: string, userId = owner, feedId: string | null = feed) => {
    await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash,read,saved)
      VALUES(${articleId},${userId},${feedId},${articleId},'Synthetic','Literal 中文 100%_\\ value','https://example.invalid/scale',
      '2026-01-01T00:00:00.000123Z','<p>Synthetic</p>','Literal 中文 100%_\\ value','synthetic',false,true)`;
  };
  const reconcile = async () => {
    const [row] = await db.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout='2s'`;
      await sql`SET LOCAL statement_timeout='20s'`;
      return sql`SELECT scale_audit_counts()::integer AS drift`;
    });
    assert.equal(row.drift, 0);
  };
  const rebuild = () => db.begin(async (sql) => {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='20s'`;
    await sql`SELECT scale_rebuild_counts()`;
  });
  try {
    for (const name of ["001_initial", "002_demo_usage", "003_audit_safety", "004_state_version", "005_annotations_mcp", "006_annotation_context_retention"])
      await db.unsafe(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8"));
    for (const userId of [owner, other])
      await db`INSERT INTO users(id,email,name,password_hash) VALUES(${userId},${userId + '@example.invalid'},'Synthetic','not-a-password')`;
    await db`INSERT INTO folders(id,user_id,name) VALUES(${folder},${owner},'Synthetic')`;
    for (const feedId of [feed, dormant])
      await db`INSERT INTO feeds(id,user_id,url,title) VALUES(${feedId},${owner},${'https://example.invalid/' + feedId},'Synthetic')`;
    await db`INSERT INTO subscriptions(id,user_id,feed_id,folder_id,title) VALUES(${subscription},${owner},${feed},${folder},'Synthetic')`;
    await db`INSERT INTO tags(id,user_id,name) VALUES(${tag},${owner},'Synthetic'),(${otherTag},${other},'Other')`;
    await insert(ids[0]); await insert(ids[1], owner, null); await insert(ids[2], owner, dormant); await insert(ids[3], other, null);
    await db`INSERT INTO article_tags(article_id,tag_id) VALUES(${ids[0]},${tag}),(${ids[2]},${tag})`;
    await db.begin(async (sql) => sql.unsafe(await readFile(new URL("../migrations/007_scale_queries.sql", import.meta.url), "utf8")));

    await t.test("backfilled feedless/subscribed/archive/saved/tag/folder totals match authoritative selection", async () => {
      for (const scope of ["all", "unread", "saved", "archive"] as const) {
        for (const filter of [{}, { tagId: tag }, { folderId: folder }, { subscriptionId: subscription }, { tagId: tag, subscriptionId: subscription }, { tagId: otherTag }]) {
          const query: ArticleQuery = { scope, ...filter, limit: 1 };
          const { condition } = articles.selection(owner, query, false);
          const [{ count }] = await db`SELECT count(*)::integer AS count FROM articles a WHERE ${condition}`;
          const page = await articles.page(owner, query);
          assert.equal(page.total, count, JSON.stringify(query));
          assert.ok(page.items.every((a) => a.id !== ids[3]));
        }
      }
      assert.equal((await feeds.subscriptions(owner))[0].totalCount, 1);
      assert.equal((await feeds.subscriptions(owner, subscription)).length, 1);
      assert.equal((await articles.tags(owner))[0].count, 2);
      await reconcile();
    });
    await t.test("inserts/import SQL, skipped conflicts, tag replacement, progress and rollback", async () => {
      await insert(ids[4]);
      await db`INSERT INTO article_tags(article_id,tag_id) VALUES(${ids[4]},${tag}) ON CONFLICT DO NOTHING`;
      await db`INSERT INTO article_tags(article_id,tag_id) VALUES(${ids[4]},${tag}) ON CONFLICT DO NOTHING`;
      await db`INSERT INTO articles SELECT * FROM articles WHERE id=${ids[4]} ON CONFLICT DO NOTHING`;
      const before = await db`SELECT *,xmin::text AS version FROM article_counts ORDER BY user_id,tag_key,feed_key`;
      const patched = await articles.patch(owner, ids[4], { progress: 0.5 }, 0);
      assert.equal(patched.stateVersion, 1);
      const after = await db`SELECT *,xmin::text AS version FROM article_counts ORDER BY user_id,tag_key,feed_key`;
      assert.deepEqual([...after], [...before], "progress-only does not even rewrite a counter tuple");
      await articles.patch(owner, ids[4], { read: true, saved: false, tagIds: [tag, tag] }, 1);
      await db`UPDATE articles SET feed_id=null WHERE id=${ids[4]}`;
      await reconcile();
      await db`UPDATE articles SET feed_id=${feed} WHERE id=${ids[4]}`;
      const replacementTag = randomUUID();
      await db`INSERT INTO tags(id,user_id,name) VALUES(${replacementTag},${owner},'Replacement')`;
      await db`UPDATE article_tags SET tag_id=${replacementTag} WHERE article_id=${ids[4]} AND tag_id=${tag}`;
      await reconcile();
      await db`UPDATE article_tags SET tag_id=${tag} WHERE article_id=${ids[4]} AND tag_id=${replacementTag}`;
      await db`DELETE FROM tags WHERE id=${replacementTag}`;
      await assert.rejects(articles.patch(owner, ids[4], { read: false }, 1), (e: any) => e.code === "STATE_CONFLICT");
      await assert.rejects(articles.patch(owner, ids[4], { tagIds: [otherTag] }), (e: any) => e.code === "NOT_FOUND");
      await assert.rejects(db.begin(async (sql) => {
        await sql`UPDATE articles SET read=NOT read,saved=NOT saved WHERE id=${ids[4]}`;
        await sql`DELETE FROM article_tags WHERE article_id=${ids[4]}`;
        throw new Error("synthetic rollback");
      }), /synthetic rollback/);
      await reconcile();
    });
    await t.test("bulk acknowledgement counts matches, not transitions, and increments every version", async () => {
      const first = await articles.bulk(owner, true, [ids[0], ids[1], ids[3]]);
      const second = await articles.bulk(owner, true, [ids[0], ids[1], ids[3]]);
      assert.deepEqual(first, { updated: 2 }); assert.deepEqual(second, first);
      const [row] = await db`SELECT state_version FROM articles WHERE id=${ids[0]}`;
      assert.equal(row.state_version, 2);
      assert.deepEqual(await articles.bulk(owner, true, []), { updated: 0 });
      const selection = { scope: "archive" as const, tagId: tag };
      const total = (await articles.page(owner, selection)).total;
      assert.equal((await articles.bulk(owner, false, undefined, selection)).updated, total);
      await reconcile();
    });
    await t.test("subscribe/unsubscribe/folder changes use current metadata without recounting history", async () => {
      const archived = (await articles.page(owner, { scope: "archive" })).total;
      await db`DELETE FROM subscriptions WHERE id=${subscription}`;
      assert.equal((await articles.page(owner, { scope: "all" })).total, 1);
      assert.equal((await articles.page(owner, { tagId: tag })).total, 0);
      assert.equal((await articles.page(owner, { scope: "archive" })).total, archived);
      await db`INSERT INTO subscriptions(id,user_id,feed_id,folder_id,title) VALUES(${subscription},${owner},${feed},${folder},'Again')`;
      await db`UPDATE subscriptions SET feed_id=${dormant},folder_id=null WHERE id=${subscription}`;
      assert.equal((await articles.page(owner, { folderId: folder })).total, 0);
      assert.equal((await feeds.subscriptions(owner))[0].totalCount, 1);
      await db`UPDATE subscriptions SET feed_id=${feed},folder_id=${folder} WHERE id=${subscription}`;
      await db`UPDATE tags SET name='Renamed',color='#123456' WHERE id=${tag}`;
      await reconcile();
    });
    await t.test("literal multilingual search and microsecond tie keysets keep exact totals", async () => {
      for (let i = 5; i < 9; i++) await insert(ids[i]);
      await db`UPDATE articles SET published_at='2026-01-01T00:00:00.000124Z' WHERE id=${ids[5]}`;
      for (const sort of ["newest", "oldest"] as const) {
        const seen: string[] = []; let cursor: string | undefined;
        do {
          const page = await articles.page(owner, { scope: "archive", sort, limit: 1, cursor });
          assert.equal(page.total, 8); seen.push(...page.items.map((a) => a.id)); cursor = page.nextCursor || undefined;
        } while (cursor);
        assert.equal(new Set(seen).size, 8);
      }
      for (const q of ["中文", "100%_\\", "不存在", "%"]) {
        const query: ArticleQuery = { scope: "archive", q };
        const { condition } = articles.selection(owner, query, false);
        const [{ total }] = await db`SELECT count(*)::integer AS total FROM articles a WHERE ${condition}`;
        assert.equal((await articles.page(owner, query)).total, total);
      }
    });
    await t.test("rows and totals share a snapshot across commits; hydrated tags do too", async () => {
      await countSnapshot(db, owner, async (sql) => {
        const total = await commonArticleTotal(sql, owner, { scope: "archive" });
        await insert(ids[9]);
        const [{ count }] = await sql`SELECT count(*)::integer AS count FROM articles WHERE user_id=${owner}`;
        assert.equal(total, count);
      });
      class InterleavedArticles extends Articles {
        override async summaries(rows: any[], sql: postgres.ISql = this.db) {
          await db`INSERT INTO article_tags(article_id,tag_id) VALUES(${ids[9]},${tag})`;
          return super.summaries(rows, sql);
        }
      }
      const previous = (await articles.tags(owner))[0].count;
      const page = await new InterleavedArticles(db).page(owner, { scope: "archive", limit: 100 });
      for (const item of page.items) for (const value of item.tags) assert.equal(value.count, previous);
      await reconcile();
    });
    await t.test("concurrent disjoint read/saved/tag writes, CAS races and rollback cannot drift", async () => {
      await Promise.all([articles.patch(owner, ids[0], { read: true }), articles.patch(owner, ids[1], { saved: false }), articles.patch(owner, ids[9], { tagIds: [] })]);
      await Promise.all([articles.bulk(owner, true, [ids[0], ids[1]]), articles.patch(owner, ids[1], { saved: true })]);
      const version = (await articles.detail(owner, ids[0])).stateVersion;
      const raced = await Promise.allSettled([articles.patch(owner, ids[0], { read: false }, version), articles.patch(owner, ids[0], { read: false }, version)]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((raced.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "STATE_CONFLICT");
      await reconcile();
    });
    await t.test("concurrent parent deletion and tag/state writes cannot recreate owner counters", async () => {
      const transientOwner = randomUUID(), transientArticle = randomUUID(), transientTag = randomUUID();
      await db`INSERT INTO users(id,email,name,password_hash) VALUES(${transientOwner},${transientOwner + '@example.invalid'},'Transient','not-a-password')`;
      await insert(transientArticle, transientOwner, null);
      await db`INSERT INTO tags(id,user_id,name) VALUES(${transientTag},${transientOwner},'Transient')`;
      const raced = await Promise.allSettled([
        db`DELETE FROM users WHERE id=${transientOwner}`,
        articles.patch(transientOwner, transientArticle, { read: true, tagIds: [transientTag] }),
      ]);
      for (const result of raced) if (result.status === "rejected")
        assert.ok(["40P01", "40001", "23503", "23514", "NOT_FOUND", "COUNTS_UNAVAILABLE"].includes(result.reason.code));
      // Either legal winner may force a complete transaction retry; never retry
      // just a counter delta. Finish deletion and compare authoritative state.
      await db`DELETE FROM users WHERE id=${transientOwner}`;
      assert.equal((await db`SELECT * FROM article_counts WHERE user_id=${transientOwner}`).length, 0);
      await reconcile();
    });
    await t.test("deleted article/tag/feed/owner parents and ownership transfer leave no stale counters", async () => {
      await db`DELETE FROM articles WHERE id=${ids[0]}`;
      await db`DELETE FROM tags WHERE id=${tag}`;
      await db`DELETE FROM articles WHERE feed_id=${dormant}`;
      await db`DELETE FROM feeds WHERE id=${dormant}`;
      await db`UPDATE articles SET user_id=${other} WHERE id=${ids[1]}`;
      await db`DELETE FROM users WHERE id=${other}`;
      assert.equal((await db`SELECT * FROM article_counts WHERE user_id=${other}`).length, 0);
      await reconcile();
    });
    await t.test("positive drift invalidates; missing/invalid markers fail closed; locked rebuild repairs", async () => {
      await db`UPDATE article_counts SET total=total+7 WHERE user_id=${owner} AND tag_key='' AND feed_key='*'`;
      const [{ drift }] = await db.begin(async (sql) => {
        await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL statement_timeout='20s'`;
        return sql`SELECT scale_audit_counts()::integer AS drift`;
      });
      assert.equal(drift, 1);
      await assert.rejects(articles.page(owner, {}), (e: any) => e.code === "COUNTS_UNAVAILABLE");
      await assert.rejects(feeds.subscriptions(owner), (e: any) => e.code === "COUNTS_UNAVAILABLE");
      assert.ok((await articles.owned(owner, ids[4])).content_html, "body ownership path remains usable");
      await db`DELETE FROM article_count_state WHERE user_id=${owner}`;
      await assert.rejects(articles.tags(owner), (e: any) => e.code === "COUNTS_UNAVAILABLE");
      const blocker = await db.reserve();
      try {
        await blocker`BEGIN`; await blocker`SELECT id FROM articles LIMIT 1`;
        await assert.rejects(db.begin(async (sql) => {
          await sql`SET LOCAL lock_timeout='100ms'`; await sql`SELECT scale_rebuild_counts()`;
        }), (e: any) => e.code === "55P03");
      } finally { await blocker`ROLLBACK`; blocker.release(); }
      await rebuild(); await reconcile();
      await db`TRUNCATE article_tags`;
      await assert.rejects(articles.page(owner, {}), (e: any) => e.code === "COUNTS_UNAVAILABLE");
      await rebuild(); await reconcile();
      await assert.rejects(db`UPDATE article_counts SET unread=total+1 WHERE user_id=${owner}`, (e: any) => e.code === "23514");
      await db`DELETE FROM users WHERE id=${owner}`;
      await reconcile();
    });
  } finally {
    await db.end({ timeout: 5 });
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end({ timeout: 5 });
  }
});
