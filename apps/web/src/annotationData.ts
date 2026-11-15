import type { AnnotationContext, AnnotationDocument, AnnotationPayload, NotesBackup, TextAnnotation } from '@feedink/shared';
import { encodedBytes, validatePage } from '@feedink/ink/validation';

export interface StoredAnnotations {
  document: AnnotationDocument;
  localVersion: string;
  pending: boolean;
  conflict?: AnnotationDocument;
}
export const annotationKey = (context: AnnotationContext) => `${context.articleId}:${context.mode}:${context.contentHash}`;
export function validText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const low = value.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
export function validateAnnotations(document: AnnotationDocument): AnnotationDocument {
  const c = document.context;
  if (document.schemaVersion !== 1 || !c || !['feed', 'fulltext'].includes(c.mode) || !/^[a-f0-9]{64}$/.test(document.contentHash) || c.contentHash !== document.contentHash || !Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error('不支持的批注版本或上下文');
  const url = new URL(c.sourceUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('无效的批注来源');
  if (!Array.isArray(document.marks) || document.marks.length > 5000) throw new Error('批注数量超出限制');
  const ids = new Set<string>();
  for (const mark of document.marks) {
    if (!mark || !validText(mark.id, 128) || !mark.id || ids.has(mark.id) || !['highlight', 'underline', 'wave', 'note'].includes(mark.kind) || !['yellow', 'green', 'blue', 'lilac'].includes(mark.color) || !validText(mark.text, 32768) || !Number.isSafeInteger(mark.createdAt) || !Number.isSafeInteger(mark.updatedAt) || mark.createdAt < 0 || mark.updatedAt < mark.createdAt) throw new Error('无效的文字批注');
    ids.add(mark.id);
    const a = mark.anchor;
    if (!a) { if (mark.kind !== 'note') throw new Error('此批注需要选区'); }
    else if (a.kind !== 'text-quote-v1' || !validText(a.exact, 8192) || !a.exact || !validText(a.prefix, 64) || !validText(a.suffix, 64) || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end - a.start !== a.exact.length) throw new Error('无效的引用锚点');
  }
  if (document.ink) {
    if (document.ink.strokes.some(s => s.anchor?.kind === 'render-v1')) throw new Error('展示投影不能作为原始笔迹恢复');
    validatePage(document.ink, c.sourceUrl);
  }
  if (encodedBytes(payloadOf(document)) > 8 * 1024 * 1024) throw new Error('笔记超过 8 MiB，未截断或覆盖原数据');
  return structuredClone(document);
}
export function payloadOf(document: AnnotationDocument): AnnotationPayload {
  return { schemaVersion: 1, contentHash: document.contentHash, ink: document.ink, marks: document.marks };
}
export function backupOf(document: AnnotationDocument): NotesBackup {
  validateAnnotations(document);
  const { sourceUrl: url, title, mode, contentHash } = document.context;
  return { format: 'feedink-notes', version: 1, source: { url, title, mode, contentHash }, ink: document.ink, marks: document.marks };
}
export function assertContext(document: AnnotationDocument, context: Pick<AnnotationContext, 'articleId' | 'mode'> & Partial<AnnotationContext>) {
  validateAnnotations(document);
  for (const key of ['articleId', 'mode', 'sourceUrl', 'contentHash'] as const) if (context[key] !== undefined && context[key] !== document.context[key]) throw new Error('笔记与当前文章上下文不匹配，未恢复');
}
export const markLabels: Record<TextAnnotation['kind'], string> = { highlight: '高亮', underline: '下划线', wave: '波浪线', note: '备注' };
export const markColors = { yellow: '#e9bb37', green: '#4ba879', blue: '#4a8ccf', lilac: '#a576cf' } as const;
