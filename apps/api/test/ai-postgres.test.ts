import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import postgres from 'postgres';
import { Auth } from '../src/auth.js';
import { hash, migrate, type Config, type Row } from '../src/core.js';
import type { AiJob } from '@feedink/shared';
import type { AiMessage } from '../src/ai-provider.js';
import { Annotations } from '../src/annotations.js';
import { AiService, DEFAULT_AI_CONFIG } from '../src/ai.js';
import { installAiRoutes } from '../src/ai-routes.js';
import { decryptAiKey } from '../src/ai-security.js';
import { prepareAiDocument, segmentBatches, summaryMessages, validateSummary } from '../src/ai-content.js';
import { aiFixture, hostedAiTests, syntheticAiKey, englishAiParagraph } from './ai-fixture.js';
import { englishAiBoundedSentence, shortForeignAiFragments, supportedAiLanguageSamples } from './ai-language-fixture.js';

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Synthetic AI condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const hasCode = (code: string) => (error: any) => error.code === code;
test('ai PostgreSQL: config, isolation, durable jobs, completeness, fencing and immutability', { skip: !hostedAiTests || !process.env.TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const db = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
  await migrate(db);
  const fixture = await aiFixture(), key = randomBytes(32), logs: string[] = [];
  const app = Fastify({ logger: { stream: { write(line: string) { logs.push(line); } }, serializers: { req: (r: { method: string }) => ({ method: r.method }) } } });
  await app.register(cookie);
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir: '.', appUrl: 'http://localhost:3000', sessionSecret: 'synthetic-ai-session-secret-with-more-than-32-characters', host: '127.0.0.1', port: 0, registration: false, fetchAllowHosts: [], webDir: '.', worker: false };
  const auth = new Auth(db, config); auth.install(app, async () => {});
  const ai = new AiService(db, { encryptionKey: key, allowHosts: ['127.0.0.1'] });
  installAiRoutes(app, ai);
  const users: string[] = [];
  const account = async (demo = false) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'); users.push(id);
    await db`INSERT INTO users(id,email,name,password_hash,is_demo) VALUES(${id},${`${id}@example.invalid`},'Synthetic AI reader','disabled',${demo})`;
    await db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${id},now()+interval '1 day')`;
    return { id, cookie: `feedink_session=${token}`, csrf: auth.csrf(token) };
  };
  type Account = Awaited<ReturnType<typeof account>>;
  const request = (owner: Account, method: string, path: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method: method as any, url: path, payload, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, ...headers } });
  const input = { enabled: true, baseUrl: fixture.baseUrl, model: 'synthetic-model', targetLanguage: 'zh-CN' as const, apiKey: syntheticAiKey };
  const article = async (owner: Account, html = `<p>${englishAiParagraph}</p>`, title = 'Synthetic title') => {
    const id = randomUUID();
    await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${id},${owner.id},${id},'Synthetic feed',now(),${title},'https://example.invalid/ai-source',${html},'Synthetic text',${hash(html)})`;
    return id;
  };
  const run = async (jobId: string) => {
    const row = await ai.claim(); assert.equal(row?.id, jobId); await ai.runClaimed(row!);
    return (await db`SELECT * FROM ai_jobs WHERE id=${jobId}`)[0];
  };
  const sourceState = async (source: string) => JSON.stringify({
    article: await db`SELECT * FROM articles WHERE id=${source}`,
    images: await db`SELECT * FROM images WHERE article_id=${source} ORDER BY id`,
    annotations: await db`SELECT * FROM annotations WHERE article_id=${source} ORDER BY id`,
    contexts: await db`SELECT * FROM annotation_contexts WHERE article_id=${source} ORDER BY mode,content_hash`,
  });
  try {
    const a = await account(), b = await account(), demo = await account(true);
    await t.test('direct defaults, secret persistence/readback, retain/clear semantics and auth/CSRF/demo rejection', async () => {
      assert.deepEqual((await request(a, 'GET', '/api/ai/config')).json(), DEFAULT_AI_CONFIG);
      assert.equal((await app.inject({ method: 'GET', url: '/api/ai/config' })).statusCode, 401);
      assert.equal((await request(a, 'PUT', '/api/ai/config', input, { 'x-csrf-token': '' })).statusCode, 403);
      assert.equal((await request(a, 'PUT', '/api/ai/config', input, { origin: 'https://foreign.invalid' })).statusCode, 403);
      assert.equal((await request(demo, 'PUT', '/api/ai/config', input)).statusCode, 403);
      assert.equal((await request(demo, 'POST', '/api/ai/config/test')).statusCode, 403);
      const saved = await request(a, 'PUT', '/api/ai/config', input);
      assert.equal(saved.statusCode, 200); assert.equal(saved.json().hasKey, true); assert.equal(saved.json().revision, 1);
      assert.ok(!saved.body.includes(syntheticAiKey)); assert.ok(!('apiKey' in saved.json()));
      const [stored] = await db`SELECT * FROM ai_configs WHERE user_id=${a.id}`;
      assert.ok(!JSON.stringify(stored).includes(syntheticAiKey));
      assert.equal(decryptAiKey(key, a.id, stored.revision, stored.encrypted_key), syntheticAiKey);
      const { apiKey: _omitted, ...metadata } = input;
      assert.equal((await request(a, 'PUT', '/api/ai/config', metadata)).json().revision, 2);
      const [retained] = await db`SELECT * FROM ai_configs WHERE user_id=${a.id}`;
      assert.notEqual(stored.encrypted_key, retained.encrypted_key);
      assert.equal(decryptAiKey(key, a.id, 2, retained.encrypted_key), syntheticAiKey);
      assert.equal((await request(a, 'PUT', '/api/ai/config', { ...metadata, enabled: false, apiKey: null })).json().hasKey, false);
      await ai.saveConfig(a.id, input); await ai.saveConfig(b.id, input);
      assert.deepEqual((await request(a, 'POST', '/api/ai/config/test')).json(), { ok: true });
      assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].body.max_tokens, 16);
      fixture.setBehavior('error');
      const rejectedProvider = await request(a, 'POST', '/api/ai/config/test');
      assert.equal(rejectedProvider.statusCode, 502); assert.ok(!rejectedProvider.body.includes(syntheticAiKey));
      assert.ok(!rejectedProvider.body.includes('synthetic provider private error')); fixture.setBehavior('ok');
      const noKey = new AiService(db, { allowHosts: ['127.0.0.1'] });
      await assert.rejects(() => noKey.saveConfig(b.id, input), hasCode('AI_UNAVAILABLE'));
      assert.equal((await noKey.saveConfig(b.id, { ...metadata, enabled: false, apiKey: null })).hasKey, false);
      await ai.saveConfig(b.id, input);
      assert.equal((await request(a, 'PUT', '/api/ai/config', { ...input, apiKey: { secret: syntheticAiKey } })).statusCode, 400);
      const malformed = Buffer.concat([Buffer.from('{"apiKey":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
      assert.equal((await request(a, 'PUT', '/api/ai/config', malformed, { 'content-type': 'application/json' })).statusCode, 400);
    });
    await t.test('owner substitution and authenticated-encryption tampering fail closed before provider use', async () => {
      const [aConfig] = await db`SELECT * FROM ai_configs WHERE user_id=${a.id}`;
      const [bConfig] = await db`SELECT * FROM ai_configs WHERE user_id=${b.id}`;
      await db`UPDATE ai_configs SET encrypted_key=${aConfig.encrypted_key},revision=${aConfig.revision} WHERE user_id=${b.id}`;
      const calls = fixture.requests.length;
      await assert.rejects(() => ai.testConfig(b.id), hasCode('AI_SECRET'));
      assert.equal(fixture.requests.length, calls);
      await db`UPDATE ai_configs SET encrypted_key=${bConfig.encrypted_key},revision=${bConfig.revision} WHERE user_id=${b.id}`;
    });
    await t.test('HTTP config revision precondition has a safe 409 and rejects invalid/mismatched requests without work', async () => {
      const source = await article(a), current = await ai.getConfig(a.id), before = fixture.requests.length;
      const params = { operation: 'summary', mode: 'feed' };
      for (const configRevision of [-1, 1.5, 2147483648, '1', null]) {
        assert.equal((await request(a, 'POST', `/api/articles/${source}/ai`, { ...params, configRevision })).statusCode, 400);
      }
      const mismatch = await request(a, 'POST', `/api/articles/${source}/ai`, { ...params, configRevision: current.revision - 1 });
      assert.equal(mismatch.statusCode, 409); assert.equal(mismatch.json().error.code, 'AI_CONFIG_CHANGED');
      assert.ok(!mismatch.body.includes(syntheticAiKey));
      assert.equal((await db`SELECT id FROM ai_jobs WHERE article_id=${source}`).length, 0); assert.equal(fixture.requests.length, before);
      const response = await request(a, 'POST', `/api/articles/${source}/ai`, { ...params, configRevision: current.revision });
      assert.equal(response.statusCode, 202); assert.equal(response.json().job.configRevision, current.revision);
      assert.equal((await ai.getJob(a.id, response.json().job.id)).configRevision, current.revision);
      assert.equal((await ai.cancel(a.id, response.json().job.id)).configRevision, current.revision);
    });
    await t.test('canonical context precondition, source/mode ownership, missing fulltext and no browser body replacement', async () => {
      const source = await article(a), context = await new Annotations(db).get(a.id, source, 'feed');
      const before = fixture.requests.length;
      assert.equal((await request(b, 'POST', `/api/articles/${source}/ai`, { operation: 'translate', mode: 'feed' })).statusCode, 404);
      assert.equal((await request(a, 'POST', `/api/articles/${source}/ai`, { operation: 'summary', mode: 'fulltext' })).json().error.code, 'AI_FULLTEXT_MISSING');
      assert.equal((await request(a, 'POST', `/api/articles/${source}/ai`, { operation: 'summary', mode: 'feed', contentHash: 'f'.repeat(64) })).statusCode, 409);
      assert.equal((await request(a, 'POST', `/api/articles/${source}/ai`, { operation: 'summary', mode: 'feed', body: 'replacement' })).statusCode, 400);
      assert.equal(fixture.requests.length, before);
      const created = await request(a, 'POST', `/api/articles/${source}/ai`, { operation: 'summary', mode: 'feed', contentHash: context.contentHash });
      assert.equal(created.statusCode, 202); assert.equal(created.json().job.contentHash, context.contentHash);
      const job = created.json().job;
      await assert.rejects(() => db`INSERT INTO ai_jobs(id,user_id,article_id,mode,content_hash,snapshot_hash,cache_key,config_revision,model,prompt_version,operation,target_language,source_html,source_title,source_url)
        SELECT ${randomUUID()},${b.id},article_id,mode,content_hash,snapshot_hash,cache_key,config_revision,model,prompt_version,operation,target_language,source_html,source_title,source_url FROM ai_jobs WHERE id=${job.id}`, hasCode('23503'));
      assert.equal((await request(b, 'GET', `/api/ai/jobs/${job.id}`)).statusCode, 404);
      assert.equal((await request(b, 'DELETE', `/api/ai/jobs/${job.id}`)).statusCode, 404);
      assert.equal((await request(a, 'DELETE', `/api/ai/jobs/${job.id}`, undefined, { 'x-csrf-token': '' })).statusCode, 403);
      await ai.cancel(a.id, job.id);
    });
    await t.test('durable dedupe, forced regeneration, complete long translation, hierarchical summary and immutable notes/source', async () => {
      const imageId = randomUUID();
      const html = `<p>${englishAiParagraph.repeat(100)}</p><figure><img src="/api/assets/${imageId}" alt="Synthetic image caption"><figcaption>Final figure caption</figcaption></figure><pre><code>constant_value = 1</code></pre><p>TAIL-MARKER conclusion</p>`;
      const source = await article(a, html), notes = new Annotations(db);
      await db`INSERT INTO images(id,article_id,original_url) VALUES(${imageId},${source},'https://example.invalid/synthetic-image.png')`;
      const context = await notes.get(a.id, source, 'feed');
      await notes.save(a.id, source, 'feed', { schemaVersion: 1, contentHash: context.contentHash, ink: null, marks: [{ id: 'fixture-note', kind: 'note', color: 'yellow', anchor: null, text: 'Keep this private note unchanged', createdAt: 1, updatedAt: 1 }] }, 0);
      const beforeArticle = JSON.stringify((await db`SELECT * FROM articles WHERE id=${source}`)[0]);
      const beforeNotes = JSON.stringify(await db`SELECT * FROM annotations WHERE article_id=${source}`);
      const beforeImages = JSON.stringify(await db`SELECT * FROM images WHERE article_id=${source}`);
      const params = { operation: 'translate', mode: 'feed', contentHash: context.contentHash };
      const concurrent = await Promise.all([ai.enqueue(a.id, source, params), ai.enqueue(a.id, source, params)]);
      assert.equal(concurrent[0].job.id, concurrent[1].job.id);
      await assert.rejects(() => ai.enqueue(a.id, source, { ...params, force: true }), hasCode('AI_ACTIVE_JOB'));
      const start = fixture.requests.length, translated = await run(concurrent[0].job.id);
      assert.equal(translated.status, 'succeeded'); assert.equal(translated.completed_chunks, translated.total_chunks);
      assert.ok(translated.total_chunks > 14); assert.ok(translated.result.bilingualHtml.includes('TAIL-MARKER'));
      assert.ok(translated.result.bilingualHtml.includes('feedink-ai-pair'));
      const seen = fixture.requests.slice(start).flatMap(r => JSON.parse(r.body.messages[1].content).segments).map(s => s.text).join('');
      assert.ok(seen.includes(englishAiParagraph.repeat(100))); assert.ok(seen.includes('Final figure caption')); assert.ok(!seen.includes('constant_value'));
      assert.ok(!seen.includes('Keep this private note')); assert.ok(seen.includes('Synthetic image caption'));
      const cached = await request(a, 'POST', `/api/articles/${source}/ai`, params);
      assert.equal(cached.statusCode, 200); assert.equal(cached.json().job.id, translated.id); assert.equal(cached.json().job.configRevision, translated.config_revision);
      const forced = await ai.enqueue(a.id, source, { ...params, force: true }); assert.notEqual(forced.job.id, translated.id); await ai.cancel(a.id, forced.job.id);
      const summary = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' });
      const summarized = await run(summary.job.id);
      assert.equal(summarized.status, 'succeeded'); assert.ok(summarized.result.summaryText.includes('TAIL-MARKER'));
      assert.ok(summarized.provider_calls > 2); assert.equal(summarized.completed_chunks, summarized.total_chunks);
      assert.equal(JSON.stringify((await db`SELECT * FROM articles WHERE id=${source}`)[0]), beforeArticle);
      assert.equal(JSON.stringify(await db`SELECT * FROM annotations WHERE article_id=${source}`), beforeNotes);
      assert.equal(JSON.stringify(await db`SELECT * FROM images WHERE article_id=${source}`), beforeImages);
    });
    await t.test('same-language skip uses the entire eligible input; mixed-language article is processed', async () => {
      const source = await article(a, `<p>${englishAiParagraph}</p>`, englishAiParagraph), start = fixture.requests.length;
      const skipped = await ai.enqueue(a.id, source, { operation: 'translate', mode: 'feed', targetLanguage: 'en' });
      assert.equal((await run(skipped.job.id)).status, 'skipped'); assert.equal(fixture.requests.length, start);
      await db`UPDATE articles SET content_html=${`<p>${englishAiParagraph}</p><p>这是中文段落，不得静默跳过。</p>`} WHERE id=${source}`;
      const mixed = await ai.enqueue(a.id, source, { operation: 'translate', mode: 'feed', targetLanguage: 'en' });
      assert.equal((await run(mixed.job.id)).status, 'succeeded'); assert.ok(fixture.requests.length > start);
      const title = supportedAiLanguageSamples.find(sample => sample.language === 'en')!.title;
      const titled = await article(a, `<p>${englishAiBoundedSentence}</p>`, title), beforeTitle = fixture.requests.length;
      const titleJob = await ai.enqueue(a.id, titled, { operation: 'translate', mode: 'feed', targetLanguage: 'en' });
      const titleResult = await run(titleJob.job.id);
      assert.equal(titleResult.status, 'skipped'); assert.equal(titleResult.detected_language, 'en');
      assert.equal(fixture.requests.length, beforeTitle, 'agreeing short title and old 240-character remainder need no provider');
      const chinese = supportedAiLanguageSamples.find(sample => sample.language === 'zh-CN')!;
      const chineseSource = await article(a, `<p>${chinese.paragraph}</p>`, chinese.title), beforeChinese = fixture.requests.length;
      const chineseJob = await ai.enqueue(a.id, chineseSource, { operation: 'translate', mode: 'feed', targetLanguage: 'zh-CN' });
      const chineseResult = await run(chineseJob.job.id);
      assert.equal(chineseResult.status, 'skipped'); assert.equal(chineseResult.detected_language, 'zh-CN');
      assert.equal(fixture.requests.length, beforeChinese, 'Chinese title and body at the default target need no provider');
      for (const { name, text } of shortForeignAiFragments) {
        const foreign = await article(a, `<p>${englishAiParagraph}</p><p>${text}</p>`, title), beforeForeign = fixture.requests.length;
        const job = await ai.enqueue(a.id, foreign, { operation: 'translate', mode: 'feed', targetLanguage: 'en' });
        const result = await run(job.job.id);
        assert.equal(result.status, 'succeeded', `${name} short segment requires processing`);
        assert.notEqual(result.detected_language, 'en');
        assert.ok(fixture.requests.length > beforeForeign);
      }
    });
    await t.test('missing segment IDs and truncated output fail and are not successful cache entries', async () => {
      for (const behavior of ['missing', 'truncated'] as const) {
        const source = await article(a); fixture.setBehavior(behavior);
        const queued = await ai.enqueue(a.id, source, { operation: 'translate', mode: 'feed' });
        const failed = await run(queued.job.id);
        assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'AI_OUTPUT'); assert.equal(failed.result, null);
        assert.ok(failed.completed_chunks < failed.total_chunks);
        await assert.rejects(() => ai.enqueue(a.id, source, { operation: 'translate', mode: 'feed' }), hasCode('AI_INTERRUPTED'));
      }
      fixture.setBehavior('ok');
    });
    await t.test('escaped and reconstructed credentials fail without publication, logging or automatic retry', async () => {
      const cases = [
        { kind: 'escaped-summary', operation: 'summary' as const, html: '<p>Body</p>', title: 'Title' },
        { kind: 'escaped-translation', operation: 'translate' as const, html: '<p>Body</p>', title: 'Title' },
        { kind: 'text-segments', operation: 'translate' as const, html: `<p>${'x'.repeat(2400)}</p>`, title: '' },
        { kind: 'text-batches', operation: 'translate' as const, html: `<p>${'x'.repeat(7200)}</p>`, title: '' },
        { kind: 'inline-text', operation: 'translate' as const, html: '<p>First<strong>Second</strong></p>', title: '' },
        // Segmentation visits sibling text before nested text; only rendered visible order joins this key.
        { kind: 'visible-order', operation: 'translate' as const, html: '<p>First<strong>Second</strong>Third</p>', title: '' },
        { kind: 'translated-title', operation: 'translate' as const, html: '', title: 'x'.repeat(2400) },
        { kind: 'translated-alt', operation: 'translate' as const, html: `<img src="/api/assets/11111111-1111-4111-8111-111111111111" alt="${'x'.repeat(2400)}">`, title: '' },
        { kind: 'translated-attribute-title', operation: 'translate' as const, html: `<a href="https://example.invalid" title="${'x'.repeat(2400)}"></a>`, title: '' },
        { kind: 'summary-batches', operation: 'summary' as const, html: `<p>${'x'.repeat(7200)}</p>`, title: '' },
      ];
      try {
        for (const sample of cases) {
          const credential = sample.kind === 'escaped-summary' ? 'admitted&revision-fixture-key-not-real' : syntheticAiKey;
          const admitted = await ai.saveConfig(a.id, { ...input, apiKey: credential });
          const escaped = [...credential].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
          const prefix = credential.slice(0, 19), suffix = credential.slice(19);
          const source = await article(a, sample.html, sample.title), doc = prepareAiDocument(sample.html, sample.title, sample.operation);
          if (sample.kind === 'translated-alt') await db`INSERT INTO images(id,article_id,original_url)
            VALUES('11111111-1111-4111-8111-111111111111',${source},'https://example.invalid/credential-fixture.png')`;
          const batches = segmentBatches(doc.segments), boundary = sample.kind === 'text-batches' ? batches[0].length - 1 : 0;
          let responseCount = 0;
          fixture.setCompletion((segments, summary) => {
            responseCount++;
            const split = sample.kind === 'summary-batches';
            const text = split ? (responseCount === 1 ? prefix : suffix) : credential;
            const output = summary ? { coveredIds: segments.map(s => s.id), summaryText: text }
              : { segments: segments.map(s => ({ id: s.id, text: sample.kind === 'escaped-translation' ? credential
                : sample.kind === 'visible-order' ? (s.text === 'First' ? prefix : s.text === 'Second' ? suffix : 'Safe prose')
                : s.id === doc.segments[boundary].id ? prefix : s.id === doc.segments[boundary + 1].id ? suffix : 'Safe prose' })).reverse() };
            const json = JSON.stringify(output);
            return sample.kind.startsWith('escaped-') ? json.replaceAll(credential, escaped) : json;
          });
          const before = fixture.requests.length, params = { operation: sample.operation, mode: 'feed' };
          const queued = await ai.enqueue(a.id, source, params), failed = await run(queued.job.id);
          assert.equal(failed.status, 'failed', sample.kind); assert.equal(failed.error_code, 'AI_OUTPUT', sample.kind);
          assert.equal(failed.result, null); assert.ok(!JSON.stringify(failed).includes(credential));
          assert.equal(queued.job.configRevision, admitted.revision); assert.equal(failed.config_revision, admitted.revision);
          const expected = sample.kind.endsWith('-batches') ? 2 : 1;
          assert.equal(fixture.requests.length, before + expected, sample.kind);
          assert.ok(fixture.requests.slice(before).every(request => request.authorization === `Bearer ${credential}`));
          for (const path of [`/api/ai/jobs/${failed.id}`, `/api/ai/results/${failed.id}`, '/api/ai/results']) {
            const response = await request(a, 'GET', path);
            assert.equal(response.statusCode, 200); assert.ok(!response.body.includes(credential));
            if (path !== '/api/ai/results') assert.equal(response.json().job.result, undefined);
          }
          await assert.rejects(() => ai.enqueue(a.id, source, params), hasCode('AI_INTERRUPTED'));
          await ai.recoverExpired(); assert.equal(await ai.claim(), undefined);
          assert.equal(fixture.requests.length, before + expected);
          assert.ok(!logs.join('').includes(credential));
        }
      } finally { fixture.setCompletion(); await ai.saveConfig(a.id, input); }
    });
    await t.test('final source-lane rejection publishes no result and preserves source, notes and credentials without replay', async () => {
      const owner = await account(), admitted = await ai.saveConfig(owner.id, input);
      const prefix = syntheticAiKey.slice(0, 19), suffix = syntheticAiKey.slice(19);
      const source = await article(owner, `<p>${prefix}</p><p>${suffix}</p>`, ''), notes = new Annotations(db);
      const context = await notes.get(owner.id, source, 'feed');
      await notes.save(owner.id, source, 'feed', { schemaVersion: 1, contentHash: context.contentHash, ink: null,
        marks: [{ id: 'source-lane-note', kind: 'note', color: 'yellow', anchor: null, text: 'Preserve this note', createdAt: 1, updatedAt: 1 }] }, 0);
      const original = await sourceState(source), [credential] = await db`SELECT to_jsonb(c)::text AS fingerprint FROM ai_configs c WHERE user_id=${owner.id}`;
      const params = { operation: 'translate', mode: 'feed', contentHash: context.contentHash, configRevision: admitted.revision };
      assert.equal((await db`SELECT id FROM ai_jobs WHERE status IN ('queued','running')`).length, 0, 'claim must not consume unrelated work');
      const before = fixture.requests.length;
      fixture.setCompletion(segments => JSON.stringify({ segments: segments.map(segment => ({ id: segment.id, text: 'Target filler' })) }));
      try {
        const queued = await ai.enqueue(owner.id, source, params);
        const active = await db`SELECT id,user_id FROM ai_jobs WHERE status IN ('queued','running')`;
        assert.deepEqual([...active], [{ id: queued.job.id, user_id: owner.id }]);
        const failed = await run(queued.job.id);
        assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'AI_OUTPUT'); assert.equal(failed.result, null);
        assert.equal(failed.config_revision, admitted.revision); assert.equal(failed.content_hash, context.contentHash);
        assert.equal(failed.provider_calls, 1);
        assert.equal(failed.completed_chunks, failed.total_chunks, 'all earlier batch checks passed; final publication must reject');
        const [terminal] = await db`SELECT to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${queued.job.id}`;
        assert.ok(!terminal.fingerprint.includes(syntheticAiKey));
        for (const path of [`/api/ai/jobs/${queued.job.id}`, `/api/ai/results/${queued.job.id}`, '/api/ai/results']) {
          const response = await request(owner, 'GET', path);
          assert.equal(response.statusCode, 200); assert.ok(!response.body.includes(syntheticAiKey));
          if (path === '/api/ai/results') {
            assert.equal(response.json().total, 1); assert.equal(response.json().items[0].id, queued.job.id);
            assert.equal(response.json().items[0].status, 'failed'); assert.equal(response.json().items[0].result, undefined);
          } else {
            assert.equal(response.json().job.error.code, 'AI_OUTPUT'); assert.equal(response.json().job.result, undefined);
            assert.equal(response.json().job.configRevision, admitted.revision); assert.equal(response.json().job.contentHash, context.contentHash);
          }
        }
        await assert.rejects(() => ai.enqueue(owner.id, source, params), hasCode('AI_INTERRUPTED'));
        await ai.recoverExpired();
        assert.equal((await db`SELECT id FROM ai_jobs WHERE status IN ('queued','running')`).length, 0);
        assert.equal(await ai.claim(), undefined);
        assert.equal(fixture.requests.length, before + 1); assert.equal(fixture.requests[before].authorization, `Bearer ${syntheticAiKey}`);
        assert.equal((await db`SELECT to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${queued.job.id}`)[0].fingerprint, terminal.fingerprint);
        assert.equal(await sourceState(source), original);
        assert.equal((await db`SELECT to_jsonb(c)::text AS fingerprint FROM ai_configs c WHERE user_id=${owner.id}`)[0].fingerprint, credential.fingerprint);
        assert.ok(!logs.join('').includes(syntheticAiKey));
      } finally { fixture.setCompletion(); }
    });
    await t.test('held HTTP rotation: call/publication seams retain admitted key identity and cannot replay or rewrite terminal history', async () => {
      // Test-only observation of existing seams, not an end-to-end scheduler/heartbeat witness.
      type WorkSeams = {
        call<T>(row: Row, messages: AiMessage[], signal: AbortSignal, validate: (output: string, credential: string) => T): Promise<T>;
        publish(row: Row, status: 'succeeded' | 'skipped', result: NonNullable<AiJob['result']>): Promise<void>;
      };
      const seams = ai as unknown as WorkSeams, owner = await account();
      const keyA = 'synthetic-held-revision-A-credential', keyB = 'synthetic-held-revision-B-credential';
      const admitted = await ai.saveConfig(owner.id, { ...input, apiKey: keyA });
      const source = await article(owner), notes = new Annotations(db), context = await notes.get(owner.id, source, 'feed');
      await notes.save(owner.id, source, 'feed', { schemaVersion: 1, contentHash: context.contentHash, ink: null,
        marks: [{ id: 'held-revision-note', kind: 'note', color: 'yellow', anchor: null, text: 'Unchanged during rotation', createdAt: 1, updatedAt: 1 }] }, 0);
      const original = await sourceState(source), [configA] = await db`SELECT * FROM ai_configs WHERE user_id=${owner.id}`;
      assert.equal(decryptAiKey(key, owner.id, admitted.revision, configA.encrypted_key), keyA);
      assert.equal((await db`SELECT id FROM ai_jobs WHERE status IN ('queued','running')`).length, 0, 'claim must not consume unrelated work');
      const queued = await ai.enqueue(owner.id, source, { operation: 'summary', mode: 'feed', contentHash: context.contentHash, configRevision: admitted.revision });
      const active = await db`SELECT id,user_id FROM ai_jobs WHERE status IN ('queued','running')`;
      assert.deepEqual([...active], [{ id: queued.job.id, user_id: owner.id }]);
      const row = await ai.claim(); assert.ok(row); assert.equal(row.id, queued.job.id); assert.equal(row.user_id, owner.id);
      assert.equal(row.config_revision, admitted.revision);
      const doc = prepareAiDocument(row.source_html, row.source_title, 'summary');
      assert.equal(segmentBatches(doc.segments).length, 1);
      const escapedB = [...keyB].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      fixture.setCompletion(segments => JSON.stringify({ coveredIds: segments.map(segment => segment.id), summaryText: keyB }).replaceAll(keyB, escapedB));
      fixture.setBehavior('hold');
      const before = fixture.requests.length, push = fixture.requests.push, controller = new AbortController();
      // The fixture records a fully received HTTP request and installs its release callback before yielding.
      const accepted = new Promise<void>(resolve => {
        fixture.requests.push = (...requests) => { const length = push.apply(fixture.requests, requests); resolve(); return length; };
      });
      let validated = false;
      const pending = seams.call(row, summaryMessages(doc.segments, 'zh-CN'), controller.signal, (output, credential) => {
        validated = true;
        assert.ok(!output.includes(keyA)); assert.ok(!output.includes(keyB), 'B is Unicode-escaped on the wire');
        return { credential, summaryText: validateSummary(output, doc.segments) };
      });
      try {
        await Promise.race([accepted, pending.then(() => { throw new Error('Provider response was not held at the HTTP acceptance barrier'); })]);
        assert.equal(validated, false); assert.equal(fixture.requests.length, before + 1);
        assert.equal(fixture.requests[before].authorization, `Bearer ${keyA}`);
        const updated = await ai.saveConfig(owner.id, { ...input, apiKey: keyB });
        assert.equal(updated.revision, admitted.revision + 1);
        const [configB] = await db`SELECT *,to_jsonb(c)::text AS fingerprint FROM ai_configs c WHERE user_id=${owner.id}`;
        assert.notEqual(configB.encrypted_key, configA.encrypted_key);
        assert.equal(decryptAiKey(key, owner.id, updated.revision, configB.encrypted_key), keyB);
        const [terminal] = await db`SELECT *,to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${row.id}`;
        assert.equal(terminal.status, 'failed'); assert.equal(terminal.error_code, 'AI_STALE_SOURCE'); assert.equal(terminal.result, null);
        assert.equal(terminal.config_revision, admitted.revision); assert.equal(terminal.provider_calls, 1);
        assert.ok(!terminal.fingerprint.includes(keyA)); assert.ok(!terminal.fingerprint.includes(keyB));
        fixture.setBehavior('ok'); fixture.release();
        const response = await pending;
        assert.equal(validated, true); assert.equal(response.credential, keyA); assert.notEqual(response.credential, keyB);
        assert.equal(response.summaryText, keyB, 'escaped B must not be substituted as this admitted call’s reflection credential');
        await assert.rejects(() => seams.publish(row, 'succeeded', { summaryText: response.summaryText, sourceTitle: row.source_title, sourceUrl: row.source_url }), hasCode('AI_STALE_SOURCE'));
        await ai.runClaimed(row); await ai.recoverExpired();
        assert.equal((await db`SELECT id FROM ai_jobs WHERE status IN ('queued','running')`).length, 0);
        assert.equal(await ai.claim(), undefined);
        for (const path of [`/api/ai/jobs/${row.id}`, `/api/ai/results/${row.id}`, '/api/ai/results']) {
          const result = await request(owner, 'GET', path);
          assert.equal(result.statusCode, 200); assert.ok(!result.body.includes(keyA)); assert.ok(!result.body.includes(keyB));
          if (path === '/api/ai/results') {
            assert.equal(result.json().total, 1); assert.equal(result.json().items[0].id, row.id); assert.equal(result.json().items[0].status, 'failed');
            assert.equal(result.json().items[0].result, undefined);
          } else {
            assert.equal(result.json().job.configRevision, admitted.revision); assert.equal(result.json().job.contentHash, context.contentHash);
            assert.equal(result.json().job.error.code, 'AI_STALE_SOURCE'); assert.equal(result.json().job.result, undefined);
          }
        }
        assert.equal((await db`SELECT to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${row.id}`)[0].fingerprint, terminal.fingerprint);
        assert.equal((await db`SELECT to_jsonb(c)::text AS fingerprint FROM ai_configs c WHERE user_id=${owner.id}`)[0].fingerprint, configB.fingerprint);
        assert.equal(await sourceState(source), original);
        assert.equal(fixture.requests.length, before + 1);
        assert.ok(!logs.join('').includes(keyA)); assert.ok(!logs.join('').includes(keyB));
        assert.ok(!configB.fingerprint.includes(keyA)); assert.ok(!configB.fingerprint.includes(keyB));
      } finally {
        fixture.requests.push = push; fixture.setCompletion(); fixture.setBehavior('ok'); fixture.release(); controller.abort();
        await pending.catch(() => {});
      }
    });
    await t.test('source title/body, config revision and selected feed/fulltext identity invalidate cache', async () => {
      const source = await article(a), first = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' }); await run(first.job.id);
      await db`UPDATE articles SET title='Changed title' WHERE id=${source}`;
      const changed = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' });
      assert.notEqual(changed.job.id, first.job.id); assert.equal(changed.job.contentHash, first.job.contentHash);
      assert.equal((await ai.getJob(a.id, first.job.id)).result, undefined); await run(changed.job.id);
      await db`UPDATE articles SET fulltext_html=content_html WHERE id=${source}`;
      const full = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'fulltext' });
      assert.notEqual(full.job.contentHash, changed.job.contentHash); await run(full.job.id);
      await ai.saveConfig(a.id, { ...input, model: 'different-synthetic-model' });
      assert.equal((await ai.getJob(a.id, changed.job.id)).result, undefined);
      const newConfig = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' }); assert.notEqual(newConfig.job.id, changed.job.id); await ai.cancel(a.id, newConfig.job.id);
    });
    await t.test('cancellation and source changes while a provider request is in flight prevent publication', async () => {
      for (const mode of ['cancel', 'source', 'config'] as const) {
        const source = await article(a), queued = await ai.enqueue(a.id, source, { operation: 'translate', mode: 'feed' }), row = await ai.claim();
        assert.equal(row?.id, queued.job.id);
        fixture.setBehavior('hold'); const start = fixture.requests.length, work = ai.runClaimed(row!);
        await eventually(() => fixture.requests.length > start);
        assert.equal((await ai.getJob(a.id, queued.job.id)).status, 'running');
        if (mode === 'cancel') await ai.cancel(a.id, queued.job.id);
        else if (mode === 'source') await db`UPDATE articles SET content_html='<p>Updated context</p>' WHERE id=${source}`;
        else await ai.saveConfig(a.id, input);
        fixture.setBehavior('ok'); fixture.release(); await work;
        const result = await ai.getJob(a.id, queued.job.id);
        assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed'); assert.equal(result.result, undefined);
      }
    });
    await t.test('lost provider outcome and expired claimed leases require explicit force, never blind paid retry', async () => {
      const source = await article(a); fixture.setBehavior('drop'); const before = fixture.requests.length;
      const queued = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed' });
      assert.equal((await run(queued.job.id)).error_code, 'AI_INTERRUPTED'); assert.equal(fixture.requests.length, before + 1);
      await ai.recoverExpired(); assert.equal(await ai.claim(), undefined);
      const retry = await ai.enqueue(a.id, source, { operation: 'summary', mode: 'feed', force: true });
      const lease = await ai.claim(); assert.equal(lease?.id, retry.job.id);
      await db`UPDATE ai_jobs SET call_in_flight=true,lease_until=now()-interval '1 second' WHERE id=${retry.job.id}`;
      await ai.recoverExpired(); assert.equal((await ai.getJob(a.id, retry.job.id)).error?.code, 'AI_INTERRUPTED');
      assert.equal(await ai.claim(), undefined); assert.equal(fixture.requests.length, before + 1);
      fixture.setBehavior('ok'); await ai.runClaimed(lease!);
      assert.equal(fixture.requests.length, before + 1, 'stale worker cannot issue a paid call or publish');
      assert.equal((await ai.getJob(a.id, retry.job.id)).status, 'failed');
    });
    await t.test('bounded owner admission, globally shared claims, no age eviction and lifecycle drain', async () => {
      const queued: string[] = [];
      for (let i = 0; i < 8; i++) queued.push((await ai.enqueue(a.id, await article(a), { operation: 'summary', mode: 'feed' })).job.id);
      const ninth = await article(a); await assert.rejects(() => ai.enqueue(a.id, ninth, { operation: 'summary', mode: 'feed' }), hasCode('AI_QUEUE_FULL'));
      const other = await ai.enqueue(b.id, await article(b), { operation: 'summary', mode: 'feed' });
      const peer = new AiService(db, { encryptionKey: key, allowHosts: ['127.0.0.1'] });
      const claimed = await Promise.all([ai.claim(), peer.claim()]); assert.equal(new Set(claimed.map(r => r?.id)).size, 2);
      assert.equal(new Set(claimed.map(r => r?.user_id)).size, 2); assert.equal(await peer.claim(), undefined);
      for (const job of queued) await ai.cancel(a.id, job); await ai.cancel(b.id, other.job.id);
      await db`UPDATE ai_jobs SET updated_at=now()-interval '8 days' WHERE id=${other.job.id}`; await ai.recoverExpired();
      assert.equal((await db`SELECT id FROM ai_jobs WHERE id=${other.job.id}`).length, 1);
      const source = await article(b), pending = await peer.enqueue(b.id, source, { operation: 'summary', mode: 'feed' });
      fixture.setBehavior('hold'); const start = fixture.requests.length; await peer.tick();
      await eventually(() => fixture.requests.length > start);
      await assert.rejects(() => peer.cancel(a.id, pending.job.id), hasCode('AI_NOT_FOUND'));
      assert.equal((await ai.getJob(b.id, pending.job.id)).status, 'running');
      await peer.stop();
      assert.equal((await ai.getJob(b.id, pending.job.id)).status, 'failed'); fixture.setBehavior('ok');
    });
    assert.ok(!logs.join('').includes(syntheticAiKey), 'no plaintext credential may appear in request/error logs');
    assert.ok(!logs.join('').includes('synthetic provider private error'));
  } finally {
    await app.close(); await fixture.close();
    await db`DELETE FROM users WHERE id IN ${db(users)}`;
    await db.end();
  }
});
