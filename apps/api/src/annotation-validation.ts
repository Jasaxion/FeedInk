import { z } from 'zod';
import { ANNOTATION_LIMITS, type AnnotationPayload, type NotesBackup } from '@feedink/shared';
import { validatePage } from '@feedink/ink/validation';
import { ApiFailure } from './core.js';

export const annotationMode = z.enum(['feed', 'fulltext']);
export const contentHash = z.string().regex(/^[a-f0-9]{64}$/);
export const annotationPage = { offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(20) };
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const anchor = z.object({ kind: z.literal('text-quote-v1'), exact: z.string().min(1).max(ANNOTATION_LIMITS.quote), prefix: z.string().max(ANNOTATION_LIMITS.context), suffix: z.string().max(ANNOTATION_LIMITS.context), start: time, end: time }).strict().refine(a => a.end > a.start);
const mark = z.object({ id: z.string().min(1).max(128), kind: z.enum(['highlight', 'underline', 'wave', 'note']), color: z.enum(['yellow', 'green', 'blue', 'lilac']), anchor: anchor.nullable(), text: z.string().max(ANNOTATION_LIMITS.text), createdAt: time, updatedAt: time }).strict().refine(m => (m.kind === 'note' || m.anchor !== null) && m.updatedAt >= m.createdAt);
const payload = z.object({ schemaVersion: z.literal(1), contentHash, ink: z.unknown(), marks: z.array(mark).max(ANNOTATION_LIMITS.marks) }).strict();
const backup = z.object({ format: z.literal('feedink-notes'), version: z.literal(1), source: z.object({ url: z.string().min(1).max(8192), title: z.string().max(1000), mode: annotationMode, contentHash }).strict(), ink: z.unknown(), marks: z.array(mark).max(ANNOTATION_LIMITS.marks) }).strict();
function invalid(): never { throw new ApiFailure(422, 'INVALID_ANNOTATIONS', 'Notes must be bounded valid raw ink v1 and plain text marks'); }

/** Run before schema normalization: never silently discard unsafe/unknown ink fields. */
export function finiteJson(value: unknown, byteLimit = ANNOTATION_LIMITS.bytes): void {
  let nodes = 0;
  const seen = new Set<object>();
  const string = (s: string) => {
    if (s.includes('\u0000')) invalid(); // PostgreSQL jsonb cannot retain NUL.
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
    }
  };
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 750_000 || depth > 16) invalid();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') return string(v);
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid(); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) invalid();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid();
    seen.add(v);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) invalid();
      string(key); visit(descriptor.value, depth + 1);
    }
    seen.delete(v);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > byteLimit) throw new ApiFailure(413, 'ANNOTATION_LIMIT', 'Notes exceed the serialized size limit');
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) invalid();
}
export function validateAnnotations(value: unknown, sourceUrl: string): AnnotationPayload {
  finiteJson(value);
  const parsed = payload.safeParse(value);
  if (!parsed.success) invalid();
  const input = parsed.data;
  if (new Set(input.marks.map(m => m.id)).size !== input.marks.length) invalid();
  if (input.ink !== null) {
    try {
      const ink = validatePage(input.ink, sourceUrl);
      const raw = input.ink as Record<string, any>;
      keys(raw, ['version', 'url', 'title', 'updatedAt', 'layoutWidth', 'strokes']);
      for (const stroke of raw.strokes) {
        keys(stroke, ['id', 'createdAt', 'updatedAt', 'brush', 'tool', 'color', 'width', 'opacity', 'points', 'anchor']);
        for (const point of stroke.points) keys(point, ['x', 'y', 'p']);
        if (stroke.anchor?.kind === 'render-v1') invalid();
      }
      if (ink.url !== sourceUrl) invalid();
    } catch { invalid(); }
  }
  // Validation output is deliberately not persisted: preserve original ink metadata and color spelling.
  return value as AnnotationPayload;
}
export function validateNotesBackup(value: unknown): NotesBackup {
  finiteJson(value);
  const result = backup.safeParse(value);
  if (!result.success) invalid();
  validateAnnotations({ schemaVersion: 1, contentHash: result.data.source.contentHash, ink: result.data.ink, marks: result.data.marks }, result.data.source.url);
  return value as NotesBackup;
}
export function annotationPrecondition(header: string | string[] | undefined): number {
  if (header === undefined) throw new ApiFailure(428, 'PRECONDITION_REQUIRED', 'A quoted integer If-Match revision is required');
  if (typeof header !== 'string' || !/^"(0|[1-9]\d*)"$/.test(header) || !Number.isSafeInteger(Number(header.slice(1, -1)))) throw new ApiFailure(400, 'INVALID_PRECONDITION', 'If-Match must contain one quoted integer revision');
  return Number(header.slice(1, -1));
}
