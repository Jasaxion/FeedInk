import { z } from 'zod';
import type { AiResultSummary } from '@feedink/shared';
import type { Row } from './core.js';
import { aiFailure } from './ai-security.js';

const resultsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(1024).optional() }).strict();
const cursorValue = z.object({ version: z.literal(1), owner: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.uuid() }).strict();
const resultSelection = z.object({ ids: z.array(z.uuid().transform(id => id.toLowerCase())).min(1).max(100) }).strict();
export function aiResultsQuery(owner: string, value: unknown): { limit: number; cursor?: { date: string; id: string } } {
  const parsed = resultsQuery.safeParse(value);
  if (!parsed.success) throw aiFailure('AI_REQUEST');
  if (!parsed.data.cursor) return { limit: parsed.data.limit };
  try {
    const encoded = parsed.data.cursor;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const cursor = cursorValue.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (cursor.owner !== owner || cursor.date.startsWith('0000-') || !Number.isFinite(Date.parse(cursor.date))
      || new Date(cursor.date).toISOString() !== cursor.date.slice(0, 23) + 'Z') throw new Error();
    // Keep all six fractional digits: never use the millisecond Date value as a SQL bound.
    return { limit: parsed.data.limit, cursor: { date: cursor.date, id: cursor.id } };
  } catch { throw aiFailure('AI_REQUEST'); }
}
export function aiResultsCursor(owner: string, date: string, id: string): string {
  return Buffer.from(JSON.stringify({ version: 1, owner, date, id })).toString('base64url');
}
export function aiResultIds(value: unknown): string[] {
  const parsed = resultSelection.safeParse(value);
  if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) throw aiFailure('AI_REQUEST');
  return parsed.data.ids;
}
export function aiResultSummary(row: Row): AiResultSummary {
  return { id: row.id, articleId: row.article_id, sourceTitle: row.source_title, mode: row.mode, contentHash: row.content_hash,
    operation: row.operation, targetLanguage: row.target_language, status: row.status, model: row.model,
    createdAt: row.created_at_text, updatedAt: row.updated_at_text };
}
