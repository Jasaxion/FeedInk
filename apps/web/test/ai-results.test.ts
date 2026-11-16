import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiResultSummary } from '@feedink/shared';
import { AI_RESULT_PAGE_SIZE, AI_RESULT_SELECTION_LIMIT, aiResultsPath, assertAiResultsDeleted, readAiResultsPage, toggleAiResultSelection } from '../src/aiResultData';

const result: AiResultSummary = { id: 'result-one', articleId: 'one', sourceTitle: 'Synthetic retained source', mode: 'feed', contentHash: 'a'.repeat(64), operation: 'summary', targetLanguage: 'zh-CN', status: 'succeeded', model: 'synthetic-model', createdAt: '2010-01-01T00:00:00.000001Z', updatedAt: '2010-01-01T00:00:00.000002Z' };

test('aiResultsPath forwards opaque microsecond-safe cursors without decoding or date conversion', () => {
  const cursor = 'opaque+/2026-11-14T12:00:00.123456Z==&owner-key';
  const query = new URL(aiResultsPath(cursor), 'https://example.test').searchParams;
  assert.equal(query.get('cursor'), cursor);
  assert.equal(query.get('limit'), String(AI_RESULT_PAGE_SIZE));
  assert.equal(new URL(aiResultsPath(), 'https://example.test').searchParams.has('cursor'), false);
});
test('readAiResultsPage preserves old terminal metadata and exact server totals, not result bodies or keys', () => {
  const extra = { ...result, result: { summaryText: 'not part of management metadata' }, apiKey: 'synthetic-not-a-key' };
  const page = readAiResultsPage({ items: [extra], total: 12_345, nextCursor: 'opaque-next' });
  assert.deepEqual(page, { items: [result], total: 12_345, nextCursor: 'opaque-next' });
  assert.equal(page.items[0].createdAt, result.createdAt);
  assert.notEqual(page.items[0], extra);
  for (const status of ['succeeded', 'skipped', 'failed', 'cancelled'] as const) assert.equal(readAiResultsPage({ items: [{ ...result, status }], total: 1, nextCursor: null }).items[0].status, status);
});
test('readAiResultsPage rejects active/duplicate/malformed metadata rather than offering cleanup', () => {
  for (const status of ['queued', 'running']) assert.throws(() => readAiResultsPage({ items: [{ ...result, status } as AiResultSummary], total: 1, nextCursor: null }));
  assert.throws(() => readAiResultsPage({ items: [result, result], total: 2, nextCursor: null }));
  for (const total of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => readAiResultsPage({ items: [result], total, nextCursor: null }));
  assert.throws(() => readAiResultsPage({ items: [result], total: 1, nextCursor: '' }));
  assert.throws(() => readAiResultsPage({ items: Array.from({ length: AI_RESULT_PAGE_SIZE + 1 }, (_, index) => ({ ...result, id: String(index) })), total: 21, nextCursor: null }));
});
test('toggleAiResultSelection preserves cross-page selection, uniqueness and immutable inputs', () => {
  const first = toggleAiResultSelection([], 'first-page', true);
  const second = toggleAiResultSelection(first, 'next-page', true);
  assert.deepEqual(first, ['first-page']);
  assert.deepEqual(second, ['first-page', 'next-page']);
  assert.deepEqual(toggleAiResultSelection(second, 'next-page', true), second);
  assert.deepEqual(toggleAiResultSelection(second, 'first-page', false), ['next-page']);
});
test('toggleAiResultSelection caps selected IDs at100 without evicting previous choices', () => {
  const ids = Array.from({ length: AI_RESULT_SELECTION_LIMIT }, (_, index) => `result-${index}`);
  assert.throws(() => toggleAiResultSelection(ids, 'one-too-many', true));
  assert.equal(ids.length, AI_RESULT_SELECTION_LIMIT);
  assert.deepEqual(toggleAiResultSelection(ids, ids[0], true), ids);
  assert.equal(toggleAiResultSelection(ids, ids[0], false).length, AI_RESULT_SELECTION_LIMIT - 1);
});
test('assertAiResultsDeleted accepts only a full acknowledgement for the unique selected IDs', () => {
  assert.doesNotThrow(() => assertAiResultsDeleted({ deleted: 2 }, ['one', 'two']));
  for (const deleted of [0, 1, 3, -1, 1.5]) assert.throws(() => assertAiResultsDeleted({ deleted }, ['one', 'two']));
  assert.throws(() => assertAiResultsDeleted({ deleted: 0 }, []));
  assert.throws(() => assertAiResultsDeleted({ deleted: 2 }, ['one', 'one']));
  const tooMany = Array.from({ length: 101 }, (_, index) => String(index));
  assert.throws(() => assertAiResultsDeleted({ deleted: 101 }, tooMany));
});
