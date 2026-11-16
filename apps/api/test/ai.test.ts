import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { aiJobDto, aiJobInput } from '../src/ai.js';
import { ApiFailure } from '../src/core.js';
import { prepareAiDocument, assertAiResultCredentialAbsent } from '../src/ai-content.js';
import { syntheticAiKey } from './ai-fixture.js';

test('ai job schema: optional configRevision is a bounded integer precondition, never coerced', () => {
  const input = { operation: 'summary', mode: 'feed' };
  assert.equal(aiJobInput.parse(input).configRevision, undefined);
  for (const configRevision of [0, 1, 2147483647]) assert.equal(aiJobInput.parse({ ...input, configRevision }).configRevision, configRevision);
  for (const configRevision of [-1, 1.5, 2147483648, '1', null, true]) assert.equal(aiJobInput.safeParse({ ...input, configRevision }).success, false);
});
test('ai final result guard: source-lane joins reject a credential hidden by target filler in combined text', () => {
  const prefix = syntheticAiKey.slice(0, 19), suffix = syntheticAiKey.slice(19);
  const doc = prepareAiDocument(`<p>${prefix}</p><p>${suffix}</p>`, '', 'translate');
  const bilingualHtml = doc.render(new Map(doc.segments.map(segment => [segment.id, 'Target filler'])), 'zh-CN');
  const result = { sourceTitle: '', sourceUrl: 'https://example.invalid/source-lane', bilingualHtml };
  const $ = cheerio.load(bilingualHtml, {}, false);
  assert.ok(!JSON.stringify(result).includes(syntheticAiKey));
  assert.equal($.root().text(), `${prefix}Target filler${suffix}Target filler`);
  assert.ok(!$.root().text().includes(syntheticAiKey), 'combined visible text must not trigger the guard');
  assert.equal($('.feedink-ai-source').toArray().map(node => $(node).text()).join(''), syntheticAiKey);
  assert.equal($('.feedink-ai-target').toArray().map(node => $(node).text()).join(''), 'Target fillerTarget filler');
  assert.throws(() => assertAiResultCredentialAbsent(result, syntheticAiKey), (error: unknown) => {
    assert.ok(error instanceof ApiFailure);
    assert.equal(error.code, 'AI_OUTPUT'); assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'The provider returned incomplete or invalid output');
    assert.ok(!JSON.stringify(error).includes(syntheticAiKey)); return true;
  });
});
test('ai job DTO: every status carries the stored admitted revision, not a current-config fallback', () => {
  const date = '2026-01-02T03:04:05.000Z';
  const row = { id: 'job', article_id: 'article', mode: 'feed', content_hash: 'a'.repeat(64), config_revision: 7,
    operation: 'summary', target_language: 'en', stage: 'complete', completed_chunks: 1, total_chunks: 1, detected_language: 'en', created_at: date, updated_at: date };
  for (const status of ['queued', 'running', 'succeeded', 'skipped', 'failed', 'cancelled']) {
    const dto = aiJobDto({ ...row, status });
    assert.equal(dto.configRevision, 7); assert.equal(dto.status, status);
    assert.deepEqual(Object.keys(dto).sort(), ['id', 'articleId', 'mode', 'contentHash', 'configRevision', 'operation', 'targetLanguage', 'status', 'stage', 'completedChunks', 'totalChunks', 'detectedLanguage', 'createdAt', 'updatedAt'].sort());
  }
});
