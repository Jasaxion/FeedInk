import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { NotesBackup } from '@feedink/shared';
import { type SQL, ApiFailure } from './core.js';
import { ARTICLE_HTML_MAX_LENGTH, cleanHtml } from './content.js';
import { Annotations, canonicalAnnotationHash } from './annotations.js';
import { finiteJson, validateNotesBackup } from './annotation-validation.js';

export const archivedAnnotationSchema = z.object({ backup: z.unknown(), contentHtml: z.string().max(ARTICLE_HTML_MAX_LENGTH), revision: z.number().int().min(1).max(2147483647), updatedAt: z.iso.datetime() }).strict();
export type ArchivedAnnotation = z.infer<typeof archivedAnnotationSchema>;
export function validateArchivedAnnotations(records: ArchivedAnnotation[], sourceUrl: string, images: ReadonlyMap<string, string>): void {
  const contexts = new Set<string>();
  for (const record of records) {
    finiteJson(record.contentHtml);
    const backup = validateNotesBackup(record.backup), key = `${backup.source.mode}:${backup.source.contentHash}`;
    if (contexts.has(key) || backup.source.url !== sourceUrl || cleanHtml(record.contentHtml) !== record.contentHtml || canonicalAnnotationHash(record.contentHtml, sourceUrl, backup.source.mode, images) !== backup.source.contentHash) throw new ApiFailure(422, 'INVALID_ARCHIVE', 'Annotation snapshot identity does not match its article');
    contexts.add(key);
  }
}
/** Runs inside the caller's reserved connection + Store.writeTransaction.
 * Archive restore is insert-only: it cannot overwrite a live revision/tombstone. */
export async function restoreArchivedAnnotations(sql: SQL, notes: Annotations, userId: string, articleId: string, sourceUrl: string, records: ArchivedAnnotation[], rewrite: (html: string) => string): Promise<void> {
  if (!records.length) return;
  const images = await sql`SELECT id,original_url FROM images WHERE article_id=${articleId}`;
  for (const record of records) {
    finiteJson(record.contentHtml);
    const backup = record.backup as NotesBackup;
    const html = rewrite(record.contentHtml);
    if (backup.source.url !== sourceUrl || canonicalAnnotationHash(html, sourceUrl, backup.source.mode, new Map(images.map(i => [i.id, i.original_url]))) !== backup.source.contentHash) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Restored snapshot does not match the owned article');
    const [existing] = await sql`SELECT ink,marks FROM annotations WHERE user_id=${userId} AND article_id=${articleId} AND mode=${backup.source.mode} AND content_hash=${backup.source.contentHash}`;
    if (existing) {
      if (!isDeepStrictEqual(existing.ink, backup.ink) || !isDeepStrictEqual(existing.marks, backup.marks)) throw new ApiFailure(409, 'ANNOTATION_CONFLICT', 'Archive notes differ from an existing revision; use JSON import with If-Match to resolve explicitly');
      continue;
    }
    await notes.persist(sql, userId, { articleId, mode: backup.source.mode, contentHash: backup.source.contentHash, sourceUrl, title: backup.source.title, contentHtml: html }, { schemaVersion: 1, contentHash: backup.source.contentHash, ink: backup.ink, marks: backup.marks }, record.revision);
    await sql`UPDATE annotations SET updated_at=${record.updatedAt} WHERE user_id=${userId} AND article_id=${articleId} AND mode=${backup.source.mode} AND content_hash=${backup.source.contentHash}`;
  }
}
