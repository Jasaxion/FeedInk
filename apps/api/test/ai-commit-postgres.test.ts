import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hash, migrate, type DB } from '../src/core.js';
import { AiService } from '../src/ai.js';
import { hostedAiTests, syntheticAiKey } from './ai-fixture.js';

type CommitPhase = 'call-intent' | 'final-publication';
/** Model a lost client COMMIT response only AFTER real PostgreSQL commits and an independent read witnesses it. */
function loseCommitResponse(db: DB, phase: CommitPhase, witness: () => Promise<void>) {
  let losses = 0;
  const faultDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'reserve') return Reflect.get(target, property, receiver);
      return async () => {
        const sql = await target.reserve(); let selected = false;
        return new Proxy(sql, {
          apply(connection, thisArg, args) {
            const text = Array.isArray(args[0]) ? args[0].join('?') : '';
            if (text === 'BEGIN') selected = false;
            if (phase === 'call-intent' ? text.includes('SET call_in_flight=true,provider_calls=provider_calls+1') : text.includes("stage='complete',result=")) selected = true;
            if (text === 'COMMIT' && selected && !losses) return (async () => {
              await Reflect.apply(connection, thisArg, args);
              losses++;
              await witness();
              throw new Error('Synthetic lost COMMIT acknowledgement');
            })();
            return Reflect.apply(connection, thisArg, args);
          },
        });
      };
    },
  });
  return { db: faultDb, losses: () => losses };
}

test('ai commits: lost call-intent/final-publication responses never replay or overwrite a committed terminal result', { skip: !hostedAiTests || !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  // SQL-only fixture: no DATA_DIR, Store or application filesystem startup.
  const db = postgres(process.env.TEST_DATABASE_URL!, { max: 4 }), owner = randomUUID();
  const environment = { encryptionKey: randomBytes(32), allowHosts: [] };
  let providerCalls = 0;
  const provider = { async complete(_config: unknown, messages: { content: string }[]) {
    providerCalls++;
    const segments = JSON.parse(messages[1].content).segments as { id: string }[];
    return JSON.stringify({ coveredIds: segments.map(s => s.id), summaryText: 'Synthetic complete summary' });
  } };
  const ai = new AiService(db, environment, provider);
  try {
    await migrate(db);
    await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},${`${owner}@example.invalid`},'Synthetic commit reader','disabled')`;
    await ai.saveConfig(owner, { enabled: true, baseUrl: 'https://provider.example.invalid/v1', model: 'fixture', targetLanguage: 'en', apiKey: syntheticAiKey });
    for (const phase of ['call-intent', 'final-publication'] as const) await t.test(phase, async () => {
      const article = randomUUID(), html = '<p>Synthetic complete source</p>';
      await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash)
        VALUES(${article},${owner},${article},'Fixture',now(),'Title','https://example.invalid/commit',${html},'Synthetic source',${hash(html)})`;
      const params = { operation: 'summary', mode: 'feed' }, job = (await ai.enqueue(owner, article, params)).job;
      const row = await ai.claim(); assert.equal(row?.id, job.id);
      let committed = '', witnessed = false, witnessFailure: unknown;
      const fault = loseCommitResponse(db, phase, async () => {
        // Capture assertion failures outside runClaimed's deliberately safe error handling.
        try {
          const [saved] = await db`SELECT *,to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${job.id}`;
          assert.equal(saved.provider_calls, 1);
          assert.equal(saved.status, phase === 'call-intent' ? 'running' : 'succeeded');
          assert.equal(saved.call_in_flight, phase === 'call-intent');
          if (phase === 'final-publication') assert.equal(saved.result.summaryText, 'Synthetic complete summary');
          committed = saved.fingerprint; witnessed = true;
        } catch (error) { witnessFailure = error; }
      });
      const worker = new AiService(fault.db, environment, provider), before = providerCalls;
      try {
        await worker.runClaimed(row!);
        if (witnessFailure) throw witnessFailure;
        assert.equal(fault.losses(), 1); assert.equal(witnessed, true);
        const [saved] = await db`SELECT *,to_jsonb(j)::text AS fingerprint FROM ai_jobs j WHERE id=${job.id}`;
        if (phase === 'call-intent') {
          assert.equal(saved.status, 'failed'); assert.equal(saved.error_code, 'AI_INTERRUPTED'); assert.equal(saved.result, null);
          assert.equal(providerCalls, before, 'unacknowledged call intent must not send the provider POST');
          await assert.rejects(() => ai.enqueue(owner, article, params), (error: any) => error.code === 'AI_INTERRUPTED');
        } else {
          assert.equal(saved.fingerprint, committed, 'failure handling must leave a committed terminal row byte/status/timestamp-identical');
          assert.equal(providerCalls, before + 1);
          const cached = await ai.enqueue(owner, article, params);
          assert.equal(cached.cached, true); assert.equal(cached.job.id, job.id);
          assert.equal(cached.job.configRevision, saved.config_revision);
          assert.equal((await ai.getResult(owner, job.id)).result?.summaryText, 'Synthetic complete summary');
        }
        await ai.recoverExpired(); await ai.tick();
        assert.equal(await ai.claim(), undefined);
        assert.equal(providerCalls, before + (phase === 'call-intent' ? 0 : 1));
        assert.ok(!JSON.stringify(saved).includes(syntheticAiKey));
      } finally { await worker.stop(); }
    });
  } finally {
    await ai.stop(); await db`DELETE FROM users WHERE id=${owner}`; await db.end();
  }
});
