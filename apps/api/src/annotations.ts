import * as cheerio from 'cheerio';
import type { AnnotationContext, AnnotationDocument, AnnotationMode, AnnotationPayload, AnnotationSummary, AnnotationVersion, NotesBackup } from '@feedink/shared';
import { type DB, type SQL, type Row, ApiFailure, hash, id, iso, withConnection } from './core.js';
import { cleanHtml } from './content.js';
import { contentHash, finiteJson, validateAnnotations, validateNotesBackup } from './annotation-validation.js';

export interface OffsetPage<T> { items: T[]; total: number; nextOffset: number | null }
export const pageResult = <T>(items: T[], total: number, offset: number): OffsetPage<T> => ({ items, total, nextOffset: offset + items.length < total ? offset + items.length : null });

/** Installation-independent identity. Unknown/foreign asset IDs fail closed. */
export function canonicalAnnotationHash(html: string, sourceUrl: string, mode: AnnotationMode, images: ReadonlyMap<string, string>): string {
  const $ = cheerio.load(cleanHtml(html), {}, false);
  $('img').each((_, el) => {
    const asset = $(el).attr('src')?.match(/^\/api\/assets\/([a-f0-9-]{36})$/)?.[1];
    const original = asset && images.get(asset);
    if (!original) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Content refers to an unavailable owned image');
    $(el).attr('src', original);
  });
  return hash(JSON.stringify([1, sourceUrl, mode, $.html()]));
}
export const notesBackup = (doc: AnnotationDocument): NotesBackup => ({ format: 'feedink-notes', version: 1, source: { url: doc.context.sourceUrl, title: doc.context.title, mode: doc.context.mode, contentHash: doc.contentHash }, ink: doc.ink, marks: doc.marks });
export const annotationVersion = (r: Row): AnnotationVersion => ({ contentHash: r.content_hash, revision: r.revision, updatedAt: iso(r.updated_at), markCount: r.mark_count, strokeCount: r.stroke_count });
export function annotationDocument(row: Row, versions: AnnotationVersion[] = []): AnnotationDocument {
  return { schemaVersion: 1, id: row.id, contentHash: row.content_hash, revision: row.revision, updatedAt: iso(row.updated_at), ink: row.ink, marks: row.marks, context: { articleId: row.article_id, mode: row.mode, contentHash: row.content_hash, sourceUrl: row.source_url, title: row.title, contentHtml: row.content_html }, versions };
}
export class Annotations {
  constructor(readonly db: DB) {}
  async owned(sql: SQL, userId: string, articleId: string, lock = false): Promise<Row> {
    const rows = lock
      ? await sql`SELECT * FROM articles WHERE id=${articleId} AND user_id=${userId} FOR UPDATE`
      : await sql`SELECT * FROM articles WHERE id=${articleId} AND user_id=${userId}`;
    if (!rows.length) throw new ApiFailure(404, 'NOT_FOUND', 'Article not found');
    return rows[0];
  }
  async currentContext(sql: SQL, article: Row, mode: AnnotationMode): Promise<AnnotationContext> {
    const html = mode === 'feed' ? article.content_html : article.fulltext_html;
    if (html === null) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Full text has not been captured');
    const images = await sql`SELECT id,original_url FROM images WHERE article_id=${article.id}`;
    return { articleId: article.id, mode, contentHash: canonicalAnnotationHash(html, article.url, mode, new Map(images.map(i => [i.id, i.original_url]))), sourceUrl: article.url, title: article.title, contentHtml: html };
  }
  async retainContext(sql: SQL, userId: string, context: AnnotationContext): Promise<void> {
    await sql`INSERT INTO annotation_contexts(user_id,article_id,mode,content_hash,source_url,title,content_html) VALUES(${userId},${context.articleId},${context.mode},${context.contentHash},${context.sourceUrl},${context.title},${context.contentHtml}) ON CONFLICT DO NOTHING`;
  }
  async read(sql: SQL, userId: string, articleId: string, mode: AnnotationMode, requestedHash?: string, retainCurrent = true): Promise<AnnotationDocument> {
    // Editor reads serialize capture with article changes; MCP stays read-only.
    const article = await this.owned(sql, userId, articleId, retainCurrent);
    let context: AnnotationContext | undefined;
    if (!requestedHash) {
      context = await this.currentContext(sql, article, mode); requestedHash = context.contentHash;
      if (retainCurrent) await this.retainContext(sql, userId, context);
    }
    const [row] = await sql`SELECT * FROM annotations WHERE user_id=${userId} AND article_id=${articleId} AND mode=${mode} AND content_hash=${requestedHash}`;
    const versions = (await sql`SELECT content_hash,revision,updated_at,mark_count,stroke_count FROM annotations WHERE user_id=${userId} AND article_id=${articleId} AND mode=${mode} ORDER BY updated_at DESC,id LIMIT 20`).map(annotationVersion);
    if (row) return annotationDocument(row, versions);
    const [retained] = await sql`SELECT * FROM annotation_contexts WHERE user_id=${userId} AND article_id=${articleId} AND mode=${mode} AND content_hash=${requestedHash}`;
    if (retained) context = { articleId, mode, contentHash: retained.content_hash, sourceUrl: retained.source_url, title: retained.title, contentHtml: retained.content_html };
    else {
      context ??= await this.currentContext(sql, article, mode);
      if (context.contentHash !== requestedHash) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'No owned snapshot matches this content hash');
      if (retainCurrent) await this.retainContext(sql, userId, context);
    }
    return { id: null, schemaVersion: 1, contentHash: requestedHash, ink: null, marks: [], revision: 0, updatedAt: null, context, versions };
  }
  async get(userId: string, articleId: string, mode: AnnotationMode, requestedHash?: string, retainCurrent = true): Promise<AnnotationDocument> {
    return withConnection(this.db, async sql => {
      if (retainCurrent) await sql`BEGIN`;
      else await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      try { const doc = await this.read(sql, userId, articleId, mode, requestedHash, retainCurrent); await sql`COMMIT`; return doc; }
      catch (error) { await sql`ROLLBACK`; throw error; }
    });
  }
  async versions(userId: string, articleId: string, mode: AnnotationMode, offset: number, limit: number): Promise<OffsetPage<AnnotationVersion>> {
    return withConnection(this.db, async sql => {
      await this.owned(sql, userId, articleId);
      const rows = await sql`SELECT content_hash,revision,updated_at,mark_count,stroke_count,count(*) OVER()::integer AS total FROM annotations WHERE user_id=${userId} AND article_id=${articleId} AND mode=${mode} ORDER BY updated_at DESC,id OFFSET ${offset} LIMIT ${limit}`;
      const total = rows.length ? rows[0].total : (await sql`SELECT count(*)::integer AS total FROM annotations WHERE user_id=${userId} AND article_id=${articleId} AND mode=${mode}`)[0].total;
      return pageResult(rows.map(annotationVersion), total, offset);
    });
  }
  async list(userId: string, { q = '', articleId, offset = 0, limit = 20 }: { q?: string; articleId?: string; offset?: number; limit?: number }): Promise<OffsetPage<AnnotationSummary>> {
    return withConnection(this.db, async sql => {
      if (articleId) await this.owned(sql, userId, articleId);
      const terms = q.trim().split(/\s+/u).filter(Boolean);
      if (terms.length > 20) throw new ApiFailure(400, 'SEARCH_LIMIT', 'Use at most 20 search terms');
      let where = sql`user_id=${userId} AND (mark_count>0 OR stroke_count>0) AND (${articleId ?? null}::uuid IS NULL OR article_id=${articleId ?? null})`;
      if (terms.length) {
        let literal = sql`TRUE`;
        for (const term of terms) literal = sql`${literal} AND search_text ILIKE ${`%${term.replace(/[\\%_]/g, '\\$&')}%`}`;
        where = sql`${where} AND (to_tsvector('simple',left(search_text,65536)) @@ plainto_tsquery('simple',${q}) OR (${literal}))`;
      }
      const rows = await sql`SELECT id,article_id,mode,content_hash,title,source_url,revision,updated_at,mark_count,stroke_count,left(search_text,240) AS excerpt,count(*) OVER()::integer AS total FROM annotations WHERE ${where} ORDER BY updated_at DESC,id OFFSET ${offset} LIMIT ${limit}`;
      const total = rows.length ? rows[0].total : (await sql`SELECT count(*)::integer AS total FROM annotations WHERE ${where}`)[0].total;
      return pageResult(rows.map(r => ({ id: r.id, articleId: r.article_id, mode: r.mode, contentHash: r.content_hash, title: r.title, sourceUrl: r.source_url, revision: r.revision, updatedAt: iso(r.updated_at), markCount: r.mark_count, strokeCount: r.stroke_count, excerpt: r.excerpt })), total, offset);
    });
  }
  async persist(sql: SQL, userId: string, context: AnnotationContext, payload: AnnotationPayload, revision: number): Promise<void> {
    await this.retainContext(sql, userId, context);
    const [retained] = await sql`SELECT source_url,title,content_html FROM annotation_contexts WHERE user_id=${userId} AND article_id=${context.articleId} AND mode=${context.mode} AND content_hash=${context.contentHash}`;
    const searchText = payload.marks.map(m => `${m.anchor?.exact ?? ''}\n${m.text}`).join('\n');
    await sql`INSERT INTO annotations(id,user_id,article_id,mode,content_hash,source_url,title,content_html,revision,ink,marks,mark_count,stroke_count,search_text)
      VALUES(${id()},${userId},${context.articleId},${context.mode},${context.contentHash},${retained.source_url},${retained.title},${retained.content_html},${revision},${payload.ink === null ? null : sql.json(payload.ink as any)},${sql.json(payload.marks as any)},${payload.marks.length},${payload.ink?.strokes.length ?? 0},${searchText})
      ON CONFLICT(user_id,article_id,mode,content_hash) DO UPDATE SET revision=EXCLUDED.revision,ink=EXCLUDED.ink,marks=EXCLUDED.marks,mark_count=EXCLUDED.mark_count,stroke_count=EXCLUDED.stroke_count,search_text=EXCLUDED.search_text,updated_at=now()`;
  }
  async save(userId: string, articleId: string, mode: AnnotationMode, value: unknown, expected: number, options: { clearHash?: string; backup?: boolean } = {}): Promise<AnnotationDocument> {
    return withConnection(this.db, async sql => {
      await sql`BEGIN`;
      try {
        // The article lock serializes absent-context creates as well as updates and content changes.
        await this.owned(sql, userId, articleId, true);
        if (!options.clearHash) finiteJson(value);
        const restored = options.backup ? validateNotesBackup(value) : undefined;
        if (restored && restored.source.mode !== mode) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Backup mode does not match the requested context');
        const requestedHash = contentHash.parse(restored?.source.contentHash ?? options.clearHash ?? (value as AnnotationPayload)?.contentHash);
        const doc = await this.read(sql, userId, articleId, mode, requestedHash);
        if (restored && restored.source.url !== doc.context.sourceUrl) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Backup source does not match the owned article');
        const payload = validateAnnotations(restored ? { schemaVersion: 1, contentHash: restored.source.contentHash, ink: restored.ink, marks: restored.marks } : options.clearHash ? { schemaVersion: 1, contentHash: doc.contentHash, ink: null, marks: [] } : value, doc.context.sourceUrl);
        // A save must remain representable by the same bounded, restorable JSON format.
        validateNotesBackup({ format: 'feedink-notes', version: 1, source: { url: doc.context.sourceUrl, title: doc.context.title, mode, contentHash: doc.contentHash }, ink: payload.ink, marks: payload.marks });
        if (doc.revision !== expected) throw new ApiFailure(412, 'ANNOTATION_CONFLICT', 'Notes changed; preserve your draft and reload before resolving the conflict');
        if (doc.revision >= 2147483647) throw new ApiFailure(409, 'ANNOTATION_LIMIT', 'Revision limit reached');
        await this.persist(sql, userId, doc.context, payload, doc.revision + 1);
        const saved = await this.read(sql, userId, articleId, mode, doc.contentHash);
        await sql`COMMIT`;
        return saved;
      } catch (error) { await sql`ROLLBACK`; throw error; }
    });
  }
}
