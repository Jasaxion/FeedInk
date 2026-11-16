import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hash, migrate } from '../src/core.js';
import { Annotations } from '../src/annotations.js';
import { AiService } from '../src/ai.js';
import { hostedAiTests, syntheticAiKey, englishAiParagraph } from './ai-fixture.js';

const hasCode = (code: string) => (error: any) => error.code === code;
test('ai owner locks: first tag-counter and retained-context FKs coexist with blocked enqueue', { skip: !hostedAiTests || !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const db = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
  const applicationName = `ai-lock-${randomUUID()}`;
  const aiDb = postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection: { application_name: applicationName } });
  const users: string[] = [];
  let calls = 0;
  const ai = new AiService(aiDb, { encryptionKey: randomBytes(32), allowHosts: [] }, { async complete() { calls++; throw new Error('No provider call is expected'); } });
  try {
    await migrate(db);
    const [schema] = await db`SELECT to_regclass('article_counts') IS NOT NULL AS counters,to_regclass('article_counts_authoritative') IS NOT NULL AS authoritative,
      EXISTS(SELECT 1 FROM schema_migrations WHERE name='007_scale_queries.sql') AS migration`;
    assert.ok(schema.counters && schema.authoritative && schema.migration, 'Integrated hosted acceptance must include migration007; this regression must not silently skip it');
    for (const kind of ['tag-counter', 'annotation-context'] as const) await t.test(kind, async () => {
      const owner = randomUUID(), articleId = randomUUID(), tagId = randomUUID(), body = `<p>${englishAiParagraph}</p>`;
      users.push(owner);
      await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},${`${owner}@example.invalid`},'Synthetic lock reader','disabled')`;
      await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash)
        VALUES(${articleId},${owner},${articleId},'Fixture feed',now(),'Fixture title','https://example.invalid/lock-source',${body},${englishAiParagraph},${hash(body)})`;
      await db`INSERT INTO tags(id,user_id,name) VALUES(${tagId},${owner},'First fixture tag')`;
      await ai.saveConfig(owner, { enabled: true, baseUrl: 'https://provider.example.invalid/v1', model: 'fixture-model', targetLanguage: 'en', apiKey: syntheticAiKey });
      const before = (await db`SELECT to_jsonb(a)::text AS value FROM articles a WHERE id=${articleId}`)[0].value;
      const beforeConfig = (await db`SELECT to_jsonb(c)::text AS value FROM ai_configs c WHERE user_id=${owner}`)[0].value;
      const holder = await db.reserve();
      let enqueue: ReturnType<AiService['enqueue']> | undefined;
      try {
        await holder`BEGIN`; await holder`SET LOCAL lock_timeout='4s'`; await holder`SET LOCAL statement_timeout='8s'`;
        const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
        const [locked] = await holder`SELECT * FROM articles WHERE id=${articleId} AND user_id=${owner} FOR UPDATE`;
        const notes = new Annotations(db), context = await notes.currentContext(holder, locked, 'feed');
        assert.equal((await holder`SELECT 1 FROM article_counts WHERE user_id=${owner} AND tag_key=${tagId}`).length, 0);
        assert.equal((await holder`SELECT 1 FROM annotation_contexts WHERE article_id=${articleId}`).length, 0);
        enqueue = ai.enqueue(owner, articleId, { operation: 'summary', mode: 'feed', contentHash: context.contentHash });
        // Observe rejection later as well, so an incorrect lock mode fails assertions rather than leaking a promise.
        void enqueue.catch(() => {});
        const deadline = Date.now() + 3000;
        while (true) {
          const [waiting] = await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName}
            AND wait_event_type='Lock' AND ${backend.pid}::integer=ANY(pg_blocking_pids(pid))) AS blocked`;
          if (waiting.blocked) break;
          if (Date.now() >= deadline) throw new Error('AI enqueue did not reach the deterministic article-lock barrier');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        // NO KEY UPDATE still excludes deletion and other AI/account mutations, but admits child FK checks.
        await assert.rejects(() => db`SELECT id FROM users WHERE id=${owner} FOR UPDATE NOWAIT`, hasCode('55P03'));
        await assert.rejects(() => db`SELECT id FROM users WHERE id=${owner} FOR NO KEY UPDATE NOWAIT`, hasCode('55P03'));
        assert.equal((await db`SELECT id FROM users WHERE id=${owner} FOR KEY SHARE NOWAIT`).length, 1);
        if (kind === 'tag-counter') await holder`INSERT INTO article_tags(article_id,tag_id) VALUES(${articleId},${tagId})`;
        else await notes.retainContext(holder, owner, context);
        await holder`COMMIT`;
        const result = await enqueue;
        assert.equal(result.job.status, 'queued'); assert.equal(result.job.contentHash, context.contentHash);
        assert.equal(calls, 0);
        assert.equal((await db`SELECT to_jsonb(a)::text AS value FROM articles a WHERE id=${articleId}`)[0].value, before);
        assert.equal((await db`SELECT to_jsonb(c)::text AS value FROM ai_configs c WHERE user_id=${owner}`)[0].value, beforeConfig);
        assert.equal((await db`SELECT id FROM annotations WHERE article_id=${articleId}`).length, 0);
        if (kind === 'tag-counter') {
          const actual = await db`SELECT tag_key,feed_key,total::text,unread::text,saved::text FROM article_counts WHERE user_id=${owner} ORDER BY tag_key,feed_key`;
          const expected = await db`SELECT tag_key,feed_key,total::text,unread::text,saved::text FROM article_counts_authoritative WHERE user_id=${owner} ORDER BY tag_key,feed_key`;
          assert.deepEqual(actual, expected);
          assert.deepEqual(actual.filter(row => row.tag_key === tagId).map(row => [row.feed_key,row.total,row.unread,row.saved]), [['','1','1','0'],['*','1','1','0']]);
          assert.equal((await db`SELECT 1 FROM article_tags WHERE article_id=${articleId} AND tag_id=${tagId}`).length, 1);
        } else {
          const [retained] = await db`SELECT content_hash,content_html,title,source_url FROM annotation_contexts WHERE article_id=${articleId} AND user_id=${owner}`;
          assert.deepEqual(retained, { content_hash: context.contentHash, content_html: body, title: 'Fixture title', source_url: 'https://example.invalid/lock-source' });
        }
        await ai.cancel(owner, result.job.id);
      } finally {
        await holder`ROLLBACK`; holder.release();
        if (enqueue) await enqueue.catch(() => {});
      }
      // The audit runs only after both compatible operations commit. No 40P01 retry/allowance.
      await db.begin(async sql => {
        const [audit] = await sql`SELECT scale_audit_counts()::text AS invalidated`;
        assert.equal(audit.invalidated, '0');
      });
    });
  } finally {
    await ai.stop(); await aiDb.end();
    if (users.length) await db`DELETE FROM users WHERE id IN ${db(users)}`;
    await db.end();
  }
});
