import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiJobDto, aiJobInput } from '../src/ai.js';

test('ai job schema: optional configRevision is a bounded integer precondition, never coerced', () => {
  const input = { operation: 'summary', mode: 'feed' };
  assert.equal(aiJobInput.parse(input).configRevision, undefined);
  for (const configRevision of [0, 1, 2147483647]) assert.equal(aiJobInput.parse({ ...input, configRevision }).configRevision, configRevision);
  for (const configRevision of [-1, 1.5, 2147483648, '1', null, true]) assert.equal(aiJobInput.safeParse({ ...input, configRevision }).success, false);
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
