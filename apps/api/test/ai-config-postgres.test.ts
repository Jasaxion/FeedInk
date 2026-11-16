import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hash, migrate } from '../src/core.js';
import { AiService } from '../src/ai.js';
import { hostedAiTests, syntheticAiKey } from './ai-fixture.js';

test('ai config admission: expected revision is read after the owner lock and rejects before enqueue/provider/decryption', { skip: !hostedAiTests || !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  // SQL-only fixture; normal owner/article inserts exercise migration007 without manufactured counters.
  const db = postgres(process.env.TEST_DATABASE_URL!, { max: 3 });
  const applicationName = `ai-config-${randomUUID()}`, queries: string[] = [];
  const admissionDb = postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection: { application_name: applicationName }, debug: (_connection, text) => { queries.push(text); } });
  const owner = randomUUID(), article = randomUUID(), environment = { encryptionKey: randomBytes(32), allowHosts: [] };
  let calls = 0;
  const ai = new AiService(admissionDb, environment, { async complete() { calls++; throw new Error('Unexpected provider call'); } });
  let pending: ReturnType<AiService['enqueue']> | undefined;
  try {
    await migrate(db);
    await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},${`${owner}@example.invalid`},'Synthetic config reader','disabled')`;
    const html = '<p>Synthetic article</p>';
    await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash)
      VALUES(${article},${owner},${article},'Fixture',now(),'Title','https://example.invalid/config',${html},'Synthetic article',${hash(html)})`;
    const config = await ai.saveConfig(owner, { enabled: true, baseUrl: 'https://provider.example.invalid/v1', model: 'fixture', targetLanguage: 'en', apiKey: syntheticAiKey });
    const holder = await db.reserve();
    try {
      await holder`BEGIN`; await holder`SET LOCAL statement_timeout='10s'`;
      const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
      await holder`SELECT id FROM users WHERE id=${owner} FOR NO KEY UPDATE`;
      const start = queries.length;
      pending = ai.enqueue(owner, article, { operation: 'summary', mode: 'feed', configRevision: config.revision });
      void pending.catch(() => {});
      const deadline = Date.now() + 3000;
      while (true) {
        const [waiting] = await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${applicationName}
          AND wait_event_type='Lock' AND ${backend.pid}::integer=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (waiting.blocked) break;
        if (Date.now() >= deadline) throw new Error('AI admission did not reach the held owner lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Same atomic metadata/key-clear change as a disabled configuration save, while retaining the owner lock.
      await holder`UPDATE ai_configs SET revision=revision+1,enabled=false,encrypted_key=NULL,updated_at=now() WHERE user_id=${owner}`;
      await holder`COMMIT`;
      await assert.rejects(() => pending!, (error: any) => {
        assert.equal(error.statusCode, 409); assert.equal(error.code, 'AI_CONFIG_CHANGED');
        assert.ok(!error.message.includes(syntheticAiKey)); return true;
      });
      assert.ok(!queries.slice(start).some(text => /FROM articles|INSERT INTO ai_jobs|SELECT \* FROM ai_configs/i.test(text)), 'mismatch must precede snapshot, key decryption and insertion');
      assert.equal((await db`SELECT id FROM ai_jobs WHERE user_id=${owner}`).length, 0);
      assert.equal(calls, 0);
    } finally { await holder`ROLLBACK`; holder.release(); if (pending) await pending.catch(() => {}); }
  } finally {
    await ai.stop(); await admissionDb.end(); await db`DELETE FROM users WHERE id=${owner}`; await db.end();
  }
});
