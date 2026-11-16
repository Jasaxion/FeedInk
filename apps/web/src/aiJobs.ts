import type { AiJob, AiLanguage, AiOperation, AnnotationContext, AnnotationDocument, ArticleDetail } from '@feedink/shared';

export type AiSourceMode = 'feed' | 'fulltext';
export interface AiJobIdentity { configRevision: number; articleId: string; mode: AiSourceMode; contentHash: string; operation: AiOperation; targetLanguage: AiLanguage; sourceUrl: string; sourceTitle: string }

export function aiDisplayMatches(context: AnnotationContext | null, article: ArticleDetail, mode: AiSourceMode): boolean {
  return !!context && context.articleId === article.id && context.mode === mode && context.sourceUrl === article.url && context.title === article.title && context.contentHtml === (mode === 'fulltext' ? article.fulltextHtml : article.contentHtml);
}

/** ArticleDetail.contentHash is NOT the canonical annotation/fulltext snapshot hash. */
export function verifiedAiSource(document: AnnotationDocument, article: ArticleDetail, mode: AiSourceMode): string {
  const context = document.context;
  const html = mode === 'fulltext' ? article.fulltextHtml : article.contentHtml;
  if (!html || context.articleId !== article.id || context.mode !== mode || context.sourceUrl !== article.url || context.title !== article.title || context.contentHtml !== html || context.contentHash !== document.contentHash || !/^[a-f0-9]{64}$/.test(context.contentHash)) throw new Error('AI_SOURCE_CHANGED');
  return context.contentHash;
}
export function activeAiJob(job: AiJob): boolean { return job.status === 'queued' || job.status === 'running'; }
export function assertAiJob(job: AiJob, expected: AiJobIdentity, id?: string): void {
  if (!job || !/^[a-zA-Z0-9_-]+$/.test(job.id) || id && job.id !== id || !Number.isSafeInteger(job.configRevision) || job.configRevision < 1 || job.configRevision !== expected.configRevision || job.articleId !== expected.articleId || job.mode !== expected.mode || job.contentHash !== expected.contentHash || job.operation !== expected.operation || job.targetLanguage !== expected.targetLanguage) throw new Error('AI_JOB_CONTEXT');
  if (!['queued', 'running', 'succeeded', 'skipped', 'failed', 'cancelled'].includes(job.status) || !Number.isSafeInteger(job.completedChunks) || !Number.isSafeInteger(job.totalChunks) || job.completedChunks < 0 || job.totalChunks < job.completedChunks) throw new Error('AI_JOB_COVERAGE');
  if (job.result && (job.result.sourceUrl !== expected.sourceUrl || job.result.sourceTitle !== expected.sourceTitle)) throw new Error('AI_JOB_SOURCE');
  if (job.status === 'succeeded' && (!job.totalChunks || job.completedChunks !== job.totalChunks || !(job.operation === 'summary' ? job.result?.summaryText : job.result?.bilingualHtml))) throw new Error('AI_JOB_INCOMPLETE');
}
