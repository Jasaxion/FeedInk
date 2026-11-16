import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiJob, AnnotationDocument, ArticleDetail } from '@feedink/shared';
import { activeAiJob, aiDisplayMatches, assertAiJob, verifiedAiSource, type AiJobIdentity } from '../src/aiJobs';

const article: ArticleDetail = {
  id: 'one', stateVersion: 0, feedId: null, subscriptionId: null, feedTitle: '', title: 'Synthetic source', url: 'https://example.test/source', author: null,
  publishedAt: '2026-01-01T00:00:00Z', summary: '', thumbnailUrl: null, read: true, saved: false, tags: [], wordCount: 4, archivedAt: '2026-01-01T00:00:00Z', progress: 0, enclosures: [],
  contentHtml: '<p>Original source</p>', contentText: 'Original source', fulltextHtml: '<p>Full source tail</p>', fetchedAt: '2026-01-01T00:00:00Z', contentHash: 'c'.repeat(64), images: [], fulltextError: null,
};
const document: AnnotationDocument = { schemaVersion: 1, id: null, revision: 0, updatedAt: null, versions: [], ink: null, marks: [], contentHash: 'a'.repeat(64), context: { articleId: 'one', mode: 'feed', contentHash: 'a'.repeat(64), sourceUrl: article.url, title: article.title, contentHtml: article.contentHtml } };
const identity: AiJobIdentity = { configRevision: 1, articleId: 'one', mode: 'feed', contentHash: document.contentHash, sourceTitle: article.title, sourceUrl: article.url, operation: 'summary', targetLanguage: 'zh-CN' };
const job: AiJob = { configRevision: 1, id: 'job-one', articleId: 'one', mode: 'feed', contentHash: document.contentHash, operation: 'summary', targetLanguage: 'zh-CN', status: 'succeeded', stage: 'complete', completedChunks: 3, totalChunks: 3, detectedLanguage: 'en', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', result: { summaryText: 'Summary including tail', sourceTitle: article.title, sourceUrl: article.url } };

test('verifiedAiSource uses the canonical selected context, not ArticleDetail.contentHash', () => {
  assert.notEqual(verifiedAiSource(document, article, 'feed'), article.contentHash);
  const full = { ...document, contentHash: 'b'.repeat(64), context: { ...document.context, mode: 'fulltext' as const, contentHash: 'b'.repeat(64), contentHtml: article.fulltextHtml! } };
  assert.equal(verifiedAiSource(full, article, 'fulltext'), 'b'.repeat(64));
  assert.throws(() => verifiedAiSource(document, article, 'fulltext'));
  assert.throws(() => verifiedAiSource(full, { ...article, fulltextHtml: null }, 'fulltext'));
});
test('verifiedAiSource refuses owner-substituted article identity, source/mode/body/title drift', () => {
  for (const patch of [{ articleId: 'two' }, { mode: 'fulltext' as const }, { sourceUrl: 'https://example.test/other' }, { title: 'Other title' }, { contentHtml: '<p>changed source</p>' }, { contentHash: 'd'.repeat(64) }]) {
    assert.throws(() => verifiedAiSource({ ...document, context: { ...document.context, ...patch } }, article, 'feed'));
  }
});
test('aiDisplayMatches refuses unknown or retained historical annotation context', () => {
  assert.equal(aiDisplayMatches(null, article, 'feed'), false);
  assert.equal(aiDisplayMatches(document.context, article, 'feed'), true);
  assert.equal(aiDisplayMatches({ ...document.context, contentHtml: '<p>retained historical source</p>' }, article, 'feed'), false);
  assert.equal(aiDisplayMatches(document.context, article, 'fulltext'), false);
});
test('assertAiJob binds owned completion to requested config revision/article/source/mode/operation/target/job', () => {
  assert.doesNotThrow(() => assertAiJob(job, identity, job.id));
  for (const patch of [{ configRevision: 2 }, { configRevision: 0 }, { configRevision: undefined }, { configRevision: NaN }, { id: '../other' }, { articleId: 'two' }, { mode: 'fulltext' as const }, { contentHash: 'd'.repeat(64) }, { operation: 'translate' as const }, { targetLanguage: 'en' as const }]) assert.throws(() => assertAiJob({ ...job, ...patch } as AiJob, identity));
  assert.throws(() => assertAiJob(job, identity, 'new-job'));
  assert.throws(() => assertAiJob({ ...job, result: { ...job.result!, sourceUrl: 'https://example.test/other' } }, identity));
});
test('assertAiJob never promotes missing/partial translation or summary to completion', () => {
  for (const patch of [{ completedChunks: 2 }, { completedChunks: 4 }, { totalChunks: 0 }, { totalChunks: -1 }, { completedChunks: 1.5 }, { result: undefined }]) assert.throws(() => assertAiJob({ ...job, ...patch }, identity));
  assert.throws(() => assertAiJob({ ...job, operation: 'translate' }, { ...identity, operation: 'translate' }));
  assert.doesNotThrow(() => assertAiJob({ ...job, status: 'failed', completedChunks: 2, result: undefined }, identity));
});
test('activeAiJob polls queued/running only, never completed, skipped, failed or cancelled', () => {
  for (const status of ['queued', 'running', 'succeeded', 'skipped', 'failed', 'cancelled'] as const) assert.equal(activeAiJob({ ...job, status }), status === 'queued' || status === 'running');
});
