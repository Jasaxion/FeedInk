import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aiResultIds, aiResultsCursor, aiResultsQuery, aiResultSummary } from '../src/ai-results.js';

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const hasCode = (code: string) => (error: any) => error.code === code;
test('ai-results: bounded, owner-bound microsecond cursor and exact metadata shape', () => {
  const date = '2026-01-02T03:04:05.123456Z', cursor = aiResultsCursor(owner, date, other);
  assert.deepEqual(aiResultsQuery(owner, {}), { limit: 20 });
  assert.deepEqual(aiResultsQuery(owner, { cursor, limit: '100' }), { limit: 100, cursor: { date, id: other } });
  assert.throws(() => aiResultsQuery(other, { cursor }), hasCode('AI_REQUEST'));
  for (const value of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }, { cursor: '***' }, { cursor: 'a'.repeat(1025) }, { body: 'override' }]) {
    assert.throws(() => aiResultsQuery(owner, value), hasCode('AI_REQUEST'));
  }
  for (const invalid of ['2026-02-30T03:04:05.123456Z', '2026-01-02T03:04:05.123Z', 'not-a-date']) {
    assert.throws(() => aiResultsQuery(owner, { cursor: aiResultsCursor(owner, invalid, other) }), hasCode('AI_REQUEST'));
  }
  const row = { id: other, article_id: owner, source_title: 'Original title', mode: 'feed', content_hash: 'a'.repeat(64), operation: 'summary', target_language: 'en', status: 'succeeded', model: 'captured-model', created_at_text: date, updated_at_text: date,
    source_html: '<p>must not be listed</p>', result: { summaryText: 'must not be listed' }, encrypted_key: 'must not be listed', source_url: 'https://example.invalid' };
  assert.deepEqual(Object.keys(aiResultSummary(row)).sort(), ['id', 'articleId', 'sourceTitle', 'mode', 'contentHash', 'operation', 'targetLanguage', 'status', 'model', 'createdAt', 'updatedAt'].sort());
  assert.equal(aiResultSummary(row).createdAt, date);
});
test('ai-results: explicit cleanup requires 1..100 unique canonical UUIDs', () => {
  assert.deepEqual(aiResultIds({ ids: [owner, other] }), [owner, other]);
  const mixedCase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  assert.equal(aiResultIds({ ids: ids.slice(0, 100) }).length, 100);
  for (const value of [{ ids: [] }, { ids }, { ids: [owner, owner] }, { ids: ['invalid'] }, { ids: [mixedCase, mixedCase.toLowerCase()] }, { ids: [owner], all: true }, {}]) {
    assert.throws(() => aiResultIds(value), hasCode('AI_REQUEST'));
  }
});
test('ai-results: maintenance/admission never evict or count retained history; selective indexes remain', async () => {
  const source = await readFile(new URL('../src/ai.ts', import.meta.url), 'utf8');
  const admission = source.slice(source.indexOf('  async enqueue('), source.indexOf('  private async assertFresh('));
  const maintenance = source.slice(source.indexOf('  async recoverExpired('), source.indexOf('  async claim('));
  assert.ok(!/DELETE FROM ai_jobs|OFFSET|interval '7 days'|retained\.total/i.test(admission + maintenance));
  const admissionCounts = admission.match(/SELECT count\(\*\)[^`]+/g) ?? [];
  assert.equal(admissionCounts.length, 1);
  assert.ok(admissionCounts.every(query => query.includes("WHERE status IN ('queued','running')")));
  assert.ok(maintenance.includes("WHERE status='running' AND lease_until<=now()"));
  const schema = await readFile(new URL('../migrations/009_ai.sql', import.meta.url), 'utf8');
  assert.match(schema, /ai_jobs_key_history ON ai_jobs\(user_id,cache_key,created_at DESC,id DESC\)/);
  assert.match(schema, /ai_jobs_owner_results ON ai_jobs\(user_id,created_at DESC,id DESC\) WHERE status NOT IN \('queued','running'\)/);
});
