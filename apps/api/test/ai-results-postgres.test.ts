import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import postgres from 'postgres';
import { Auth } from '../src/auth.js';
import { hash, migrate, type Config, type Row } from '../src/core.js';
import { Annotations } from '../src/annotations.js';
import { AiService } from '../src/ai.js';
import { installAiRoutes } from '../src/ai-routes.js';
import { aiResultsCursor } from '../src/ai-results.js';
import { aiJobDto } from '../src/ai.js';
import type { AiProvider } from '../src/ai-provider.js';
import { hostedAiTests, syntheticAiKey, englishAiParagraph } from './ai-fixture.js';

const hasCode = (code: string) => (error: any) => error.code === code;
test('ai-results PostgreSQL: permanent history, exact keysets, selected cleanup and immutable historical retrieval', { skip: !hostedAiTests || !process.env.TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const queries: string[] = [], db = postgres(process.env.TEST_DATABASE_URL!, { max: 4, debug: (_connection, query) => { queries.push(query); } });
  await migrate(db);
  const app = Fastify({ logger: false }); await app.register(cookie);
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir: '.', appUrl: 'http://localhost:3000', sessionSecret: 'synthetic-ai-results-session-secret-at-least-32-characters', host: '127.0.0.1', port: 0, registration: false, fetchAllowHosts: [], webDir: '.', worker: false };
  const auth = new Auth(db, config); auth.install(app, async () => {});
  let calls = 0, hold: Promise<void> | undefined;
  const provider: AiProvider = { async complete(_config, messages) {
    calls++; if (hold) await hold;
    const segments = JSON.parse(messages[1].content).segments as { id: string; text: string }[];
    return JSON.stringify(messages[0].content.startsWith('Translate')
      ? { segments: segments.map(segment => ({ id: segment.id, text: 'Saved synthetic translation.' })) }
      : { coveredIds: segments.map(segment => segment.id), summaryText: 'Saved complete synthetic summary.' });
  } };
  const ai = new AiService(db, { encryptionKey: randomBytes(32), allowHosts: [] }, provider);
  installAiRoutes(app, ai);
  const users: string[] = [];
  const account = async (demo = false) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'); users.push(id);
    await db`INSERT INTO users(id,email,name,password_hash,is_demo) VALUES(${id},${`${id}@example.invalid`},'Synthetic history reader','disabled',${demo})`;
    await db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${id},now()+interval '1 day')`;
    return { id, cookie: `feedink_session=${token}`, csrf: auth.csrf(token) };
  };
  type Account = Awaited<ReturnType<typeof account>>;
  const request = (owner: Account, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: method as any, url: path, payload: payload as any, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, ...headers } });
  const settings = { enabled: true, baseUrl: 'https://provider.example.invalid/v1', model: 'captured-synthetic-model', targetLanguage: 'en', apiKey: syntheticAiKey };
  const article = async (owner: Account) => {
    const id = randomUUID(), imageId = randomUUID(), html = `<p>${englishAiParagraph}</p><img src="/api/assets/${imageId}">`;
    await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${id},${owner.id},${id},'Fixture feed',now(),'Original title','https://example.invalid/history',${html},${englishAiParagraph},${hash(html)})`;
    await db`INSERT INTO images(id,article_id,original_url) VALUES(${imageId},${id},'https://example.invalid/image.png')`;
    return id;
  };
  const queued = async (owner: Account, source: string, operation: 'summary' | 'translate' = 'summary') => (await ai.enqueue(owner.id, source, { operation, mode: 'feed' })).job;
  const complete = async (owner: Account, source: string, operation: 'summary' | 'translate' = 'summary') => {
    const job = await queued(owner, source, operation), claimed = await ai.claim();
    assert.equal(claimed?.id, job.id); await ai.runClaimed(claimed!);
    const [row] = await db`SELECT * FROM ai_jobs WHERE id=${job.id}`; assert.equal(row.status, 'succeeded'); return row;
  };
  const copies = async (template: Row, owner: Account, source: string, count: number, status = 'succeeded') => {
    const prefix = randomUUID().slice(0, 24), key = hash(prefix);
    return db`INSERT INTO ai_jobs(id,user_id,article_id,mode,content_hash,snapshot_hash,cache_key,config_revision,model,prompt_version,operation,target_language,status,stage,source_html,source_title,source_url,result,created_at,updated_at)
      SELECT (${prefix} || lpad(to_hex(g),12,'0'))::uuid,${owner.id},${source},mode,content_hash,snapshot_hash,${key},config_revision,model,prompt_version,operation,target_language,${status},'complete',source_html,source_title,source_url,
        CASE WHEN ${status} IN ('succeeded','skipped') THEN result ELSE NULL END,
        '2000-01-01T00:00:00Z'::timestamptz+g*interval '1 microsecond','2000-01-01T00:00:00Z'::timestamptz+g*interval '1 microsecond'
      FROM ai_jobs CROSS JOIN generate_series(1,${count}) g WHERE id=${template.id} RETURNING id`;
  };
  const unchangedSource = async (owner: Account, source: string) => JSON.stringify({
    articles: await db`SELECT * FROM articles WHERE id=${source}`,
    images: await db`SELECT * FROM images WHERE article_id=${source} ORDER BY id`,
    notes: await db`SELECT * FROM annotations WHERE article_id=${source} ORDER BY id`,
    contexts: await db`SELECT * FROM annotation_contexts WHERE article_id=${source} ORDER BY mode,content_hash`,
    config: await db`SELECT * FROM ai_configs WHERE user_id=${owner.id}`,
  });
  try {
    await t.test('old and large terminal histories survive maintenance/admission without retained-count scans', async () => {
      const a = await account(), b = await account(); await ai.saveConfig(a.id, settings); await ai.saveConfig(b.id, settings);
      const source = await article(a), otherSource = await article(b), template = await complete(a, source);
      await db`UPDATE ai_jobs SET created_at='1999-01-01T00:00:00Z',updated_at='1999-01-01T00:00:00Z' WHERE id=${template.id}`;
      const owned = await copies(template, a, source, 160), foreign = await copies(template, b, otherSource, 4200);
      assert.equal(owned.length, 160); assert.equal(foreign.length, 4200);
      const before = await db`SELECT id,created_at,updated_at,status,result FROM ai_jobs WHERE user_id IN ${db([a.id,b.id])} ORDER BY id`;
      const countBefore = calls, start = queries.length;
      await ai.recoverExpired();
      const freshSource = await article(a), fresh = await queued(a, freshSource);
      const admission = queries.slice(start).filter(query => /ai_jobs/i.test(query));
      assert.ok(!admission.some(query => /DELETE FROM ai_jobs|OFFSET/i.test(query)));
      assert.ok(admission.filter(query => /count\(\*\)/i.test(query)).every(query => /WHERE status IN \('queued','running'\)/.test(query)));
      assert.equal(calls, countBefore);
      await ai.cancel(a.id, fresh.id);
      const after = await db`SELECT id,created_at,updated_at,status,result FROM ai_jobs WHERE user_id IN ${db([a.id,b.id])} AND id<>${fresh.id} ORDER BY id`;
      assert.deepEqual(after, before);
      const cached = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' });
      assert.equal(cached.cached, true); assert.equal(cached.job.id, template.id); assert.equal(calls, countBefore);
      assert.equal((await ai.listResults(a.id, {})).total, 162); assert.equal((await ai.listResults(b.id, {})).total, 4200);
      await db`ANALYZE ai_jobs`;
      const [activePlan] = await db`EXPLAIN (FORMAT JSON) SELECT count(*) FROM ai_jobs WHERE status IN ('queued','running')`;
      const [cachePlan] = await db`EXPLAIN (FORMAT JSON) SELECT id FROM ai_jobs WHERE user_id=${a.id} AND cache_key=${template.cache_key} ORDER BY created_at DESC,id DESC LIMIT 1`;
      assert.match(JSON.stringify(activePlan), /ai_jobs_(owner_active|active_key)/, 'active counts use a partial index, not retained history');
      assert.ok(JSON.stringify(cachePlan).includes('ai_jobs_key_history'), 'cache lookup remains selective with permanent history');
    });
    await t.test('active-only owner/global admission and claim limits do not count historical rows', async () => {
      const a = await account(); await ai.saveConfig(a.id, settings); const active: { owner: Account; id: string }[] = [];
      for (let i = 0; i < 8; i++) active.push({ owner: a, id: (await queued(a, await article(a))).id });
      const extra = await article(a); await assert.rejects(() => queued(a, extra), hasCode('AI_QUEUE_FULL'));
      const template = (await db`SELECT * FROM ai_jobs WHERE id=${active[0].id}`)[0];
      // Populate only synthetic active rows across 15 additional owners to reach the existing 128 cap.
      for (let ownerIndex = 0; ownerIndex < 15; ownerIndex++) {
        const owner = await account(), source = await article(owner); await ai.saveConfig(owner.id, settings);
        for (let i = 0; i < 8; i++) {
          const jobId = randomUUID();
          await db`INSERT INTO ai_jobs(id,user_id,article_id,mode,content_hash,snapshot_hash,cache_key,config_revision,model,prompt_version,operation,target_language,source_html,source_title,source_url)
            VALUES(${jobId},${owner.id},${source},'feed',${template.content_hash},${template.snapshot_hash},${hash(jobId)},1,${settings.model},${template.prompt_version},'summary','en',${template.source_html},'Fixture','https://example.invalid/history')`;
          active.push({ owner, id: jobId });
        }
      }
      const freshOwner = await account(); await ai.saveConfig(freshOwner.id, settings);
      const freshSource = await article(freshOwner); await assert.rejects(() => queued(freshOwner, freshSource), hasCode('AI_QUEUE_FULL'));
      const claims = await Promise.all([ai.claim(), ai.claim()]); assert.ok(claims.every(Boolean));
      assert.notEqual(claims[0]!.user_id, claims[1]!.user_id); assert.equal(await ai.claim(), undefined);
      for (const item of active) await ai.cancel(item.owner.id, item.id);
    });
    await t.test('metadata listing has exact owner totals, microsecond ties, stable ordering and no provider/body reads', async () => {
      const owner = await account(), foreign = await account(), demo = await account(true); await ai.saveConfig(owner.id, settings);
      const source = await article(owner), template = await complete(owner, source);
      const other = await copies(template, owner, source, 5), all = [template.id, ...other.map(row => row.id)];
      const timestamps = ['2026-01-01T00:00:00.123999Z', '2026-01-01T00:00:00.123999Z', '2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123001Z', '2026-01-01T00:00:00.123000Z'];
      for (let i = 0; i < all.length; i++) await db`UPDATE ai_jobs SET created_at=${timestamps[i]}::text::timestamptz,updated_at=${timestamps[i]}::text::timestamptz WHERE id=${all[i]}`;
      const active = await queued(owner, await article(owner)), countBefore = calls, start = queries.length;
      const expected = await db`SELECT id FROM ai_jobs WHERE user_id=${owner.id} AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC`;
      const seen: string[] = []; let cursor: string | null = null;
      do {
        const response = await request(owner, 'GET', `/api/ai/results?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        assert.equal(response.statusCode, 200);
        const page = response.json(); assert.equal(page.total, 6); assert.ok(page.items.length <= 2);
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item).sort(), ['id','articleId','sourceTitle','mode','contentHash','operation','targetLanguage','status','model','createdAt','updatedAt'].sort());
          assert.equal(item.model, settings.model); assert.match(item.createdAt, /\.\d{6}Z$/);
        }
        seen.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, expected.map(row => row.id)); assert.equal(new Set(seen).size, 6);
      assert.equal(calls, countBefore);
      const listQueries = queries.slice(start).filter(query => /FROM ai_jobs/i.test(query));
      assert.ok(!listQueries.some(query => /SELECT \*|source_html|snapshot_hash|encrypted_key|\bresult\b/i.test(query)));
      const empty = await ai.listResults(owner.id, { cursor: aiResultsCursor(owner.id, '1900-01-01T00:00:00.000000Z', randomUUID()) });
      assert.equal(empty.total, 6); assert.deepEqual(empty.items, []); assert.equal(empty.nextCursor, null);
      assert.equal((await ai.listResults(foreign.id, {})).total, 0);
      assert.equal((await request(demo, 'GET', '/api/ai/results')).statusCode, 403);
      assert.equal((await app.inject({ method: 'GET', url: '/api/ai/results' })).statusCode, 401);
      await ai.cancel(owner.id, active.id);
    });
    await t.test('unknown error payloads cannot impersonate auth failures or leak arbitrary messages', async () => {
      const owner = await account(), original = ai.listResults;
      ai.listResults = async () => { throw { code: 'CSRF', message: syntheticAiKey }; };
      try {
        const response = await request(owner, 'GET', '/api/ai/results');
        assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'AI_INTERRUPTED');
        assert.ok(!response.body.includes(syntheticAiKey));
      } finally { ai.listResults = original; }
    });
    await t.test('explicit historical retrieval survives source/model/key changes; current polling never rewrites terminal rows', async () => {
      const owner = await account(), foreign = await account(), demo = await account(true); await ai.saveConfig(owner.id, settings);
      const source = await article(owner), summary = await complete(owner, source), translation = await complete(owner, source, 'translate'), countBefore = calls;
      const stored = await db`SELECT id,to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id IN ${db([summary.id,translation.id])} ORDER BY id`;
      await db`UPDATE articles SET title='New title',content_html='<p>Changed body</p>',content_text='Changed body',content_hash=${hash('changed')} WHERE id=${source}`;
      await ai.saveConfig(owner.id, { ...settings, model: 'new-model', apiKey: 'synthetic-replacement-key-not-real' });
      await ai.saveConfig(owner.id, { ...settings, enabled: false, model: 'new-model', apiKey: null });
      for (const saved of [summary, translation]) {
        const current = await request(owner, 'GET', `/api/ai/jobs/${saved.id}`);
        assert.equal(current.json().job.status, 'failed'); assert.equal(current.json().job.result, undefined); assert.equal(current.json().job.stage, 'stale');
        const history = await request(owner, 'GET', `/api/ai/results/${saved.id}`);
        assert.equal(history.statusCode, 200); assert.deepEqual(history.json().job, aiJobDto(saved));
        assert.equal(history.json().job.result.sourceTitle, 'Original title'); assert.equal(history.json().job.contentHash, saved.content_hash);
        assert.equal((await request(foreign, 'GET', `/api/ai/results/${saved.id}`)).statusCode, 404);
        assert.equal((await request(demo, 'GET', `/api/ai/results/${saved.id}`)).statusCode, 403);
      }
      assert.deepEqual(await db`SELECT id,to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id IN ${db([summary.id,translation.id])} ORDER BY id`, stored);
      assert.ok((await ai.listResults(owner.id, {})).items.every(item => item.model === settings.model));
      assert.equal((await request(owner, 'GET', `/api/ai/results/${randomUUID()}`)).statusCode, 404);
      assert.equal(calls, countBefore);
    });
    await t.test('atomic selected cleanup rejects missing/foreign/active sets, preserves raw data/keys and causes only an explicit cache miss', async () => {
      const owner = await account(), foreign = await account(), demo = await account(true); await ai.saveConfig(owner.id, settings); await ai.saveConfig(foreign.id, settings);
      const source = await article(owner), saved = await complete(owner, source), other = await complete(foreign, await article(foreign));
      const notes = new Annotations(db), context = await notes.get(owner.id, source, 'feed');
      await notes.save(owner.id, source, 'feed', { schemaVersion: 1, contentHash: context.contentHash, ink: null, marks: [{ id: 'history-note', kind: 'note', color: 'yellow', anchor: null, text: 'Synthetic note must remain unchanged', createdAt: 1, updatedAt: 1 }] }, 0);
      const failed = (await copies(saved, owner, source, 1, 'failed'))[0].id, cancelled = (await copies(saved, owner, source, 1, 'cancelled'))[0].id, skipped = (await copies(saved, owner, source, 1, 'skipped'))[0].id;
      const active = await queued(owner, await article(owner)), countBefore = calls, beforeSource = await unchangedSource(owner, source);
      const beforeJobs = await db`SELECT * FROM ai_jobs WHERE user_id=${owner.id} ORDER BY id`;
      assert.equal((await request(owner, 'GET', `/api/ai/results/${active.id}`)).statusCode, 404);
      for (const invalidId of [randomUUID(), other.id, active.id]) {
        const response = await request(owner, 'DELETE', '/api/ai/results', { ids: [saved.id, invalidId] });
        assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'AI_RESULT_SELECTION');
        assert.deepEqual(await db`SELECT * FROM ai_jobs WHERE user_id=${owner.id} ORDER BY id`, beforeJobs);
      }
      assert.equal((await request(owner, 'DELETE', '/api/ai/results', { ids: [saved.id] }, { 'x-csrf-token': '' })).statusCode, 403);
      assert.equal((await request(owner, 'DELETE', '/api/ai/results', { ids: [saved.id] }, { origin: 'https://foreign.invalid' })).statusCode, 403);
      assert.equal((await request(demo, 'DELETE', '/api/ai/results', { ids: [saved.id] })).statusCode, 403);
      for (const ids of [[], [saved.id,saved.id], Array(101).fill(saved.id)]) assert.equal((await request(owner, 'DELETE', '/api/ai/results', { ids })).statusCode, 400);
      const selection = [saved.id, failed, cancelled, skipped];
      const deleted = await request(owner, 'DELETE', '/api/ai/results', { ids: selection });
      assert.equal(deleted.statusCode, 200); assert.deepEqual(deleted.json(), { deleted: 4 });
      assert.equal((await ai.listResults(owner.id, {})).total, 0);
      assert.equal((await ai.getJob(owner.id, active.id)).status, 'queued');
      assert.equal(await unchangedSource(owner, source), beforeSource); assert.equal(calls, countBefore);
      assert.equal((await request(owner, 'GET', `/api/ai/results/${saved.id}`)).statusCode, 404);
      const regenerated = await ai.enqueue(owner.id, source, { operation: 'summary', mode: 'feed' });
      assert.equal(regenerated.cached, false); assert.notEqual(regenerated.job.id, saved.id); assert.equal(calls, countBefore, 'cleanup/enqueue do not make a provider call');
      await ai.cancel(owner.id, active.id); await ai.cancel(owner.id, regenerated.job.id);
    });
    await t.test('a terminal record deleted during an outstanding provider outcome cannot be resurrected', async () => {
      const owner = await account(); await ai.saveConfig(owner.id, settings);
      const source = await article(owner), job = await queued(owner, source), row = await ai.claim(); assert.equal(row?.id, job.id);
      let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; });
      const start = calls, work = ai.runClaimed(row!);
      try {
        const deadline = Date.now() + 10000;
        while (calls === start) { if (Date.now() > deadline) throw new Error('Synthetic provider did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
        await assert.rejects(() => ai.deleteResults(owner.id, { ids: [job.id] }), hasCode('AI_RESULT_SELECTION'));
        await ai.cancel(owner.id, job.id);
        assert.deepEqual(await ai.deleteResults(owner.id, { ids: [job.id] }), { deleted: 1 });
      } finally { release(); hold = undefined; await work; }
      assert.equal((await db`SELECT id FROM ai_jobs WHERE id=${job.id}`).length, 0);
      await ai.recoverExpired(); assert.equal((await ai.listResults(owner.id, {})).total, 0);
      assert.equal(calls, start + 1);
    });
  } finally {
    await app.close();
    await db`DELETE FROM users WHERE id IN ${db(users)}`;
    await db.end();
  }
});
