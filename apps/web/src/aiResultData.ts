import type { AiResultSummary } from '@feedink/shared';

export const AI_RESULT_PAGE_SIZE = 20;
export const AI_RESULT_SELECTION_LIMIT = 100;
export const AI_RESULT_RETIRE_EVENT = 'feedink:ai-results-retired';
export interface AiResultRetirement { owner: string; epoch: number; ids: string[] }
export interface AiResultsPage { items: AiResultSummary[]; total: number; nextCursor: string | null }
export const aiResultStatusLabels = { succeeded: '已完成', skipped: '已跳过', failed: '失败', cancelled: '已取消' };

/** Cursors are server-issued opaque keys: never parse their microsecond timestamps as JS dates. */
export function aiResultsPath(cursor: string | null = null): string {
  return `/ai/results?${new URLSearchParams({ limit: String(AI_RESULT_PAGE_SIZE), ...(cursor !== null ? { cursor } : {}) })}`;
}
export function toggleAiResultSelection(ids: string[], id: string, checked: boolean): string[] {
  if (!checked) return ids.filter(value => value !== id);
  if (ids.includes(id)) return ids;
  if (ids.length >= AI_RESULT_SELECTION_LIMIT) throw new Error('AI_RESULT_SELECTION_LIMIT');
  return [...ids, id];
}
/** Keep metadata only, and refuse a malformed/active row instead of offering it for cleanup. */
export function readAiResultsPage(page: AiResultsPage): AiResultsPage {
  if (!page || !Array.isArray(page.items) || page.items.length > AI_RESULT_PAGE_SIZE || !Number.isSafeInteger(page.total) || page.total < page.items.length || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)) throw new Error('AI_RESULT_PAGE');
  const ids = new Set<string>();
  const items = page.items.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Object.hasOwn(aiResultStatusLabels, item.status) || !['feed', 'fulltext'].includes(item.mode) || !['summary', 'translate'].includes(item.operation) || !['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es'].includes(item.targetLanguage) || ['articleId', 'sourceTitle', 'contentHash', 'model', 'createdAt', 'updatedAt'].some(key => typeof item[key as keyof AiResultSummary] !== 'string')) throw new Error('AI_RESULT_METADATA');
    ids.add(item.id);
    const { id, articleId, sourceTitle, mode, contentHash, operation, targetLanguage, status, model, createdAt, updatedAt } = item;
    return { id, articleId, sourceTitle, mode, contentHash, operation, targetLanguage, status, model, createdAt, updatedAt };
  });
  return { items, total: page.total, nextCursor: page.nextCursor };
}
export function assertAiResultsDeleted(response: { deleted: number }, ids: string[]): void {
  if (!ids.length || ids.length > AI_RESULT_SELECTION_LIMIT || new Set(ids).size !== ids.length || response?.deleted !== ids.length) throw new Error('AI_RESULT_DELETE_UNCONFIRMED');
}
