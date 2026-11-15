import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ANNOTATION_LIMITS, type AnnotationDocument } from '@feedink/shared';
import { Annotations, notesBackup } from './annotations.js';
import { annotationMode, contentHash, annotationPage, annotationPrecondition, validateNotesBackup } from './annotation-validation.js';
import { markdownNotes, notePreview } from './annotation-exports.js';
import { uuid } from './validation.js';
import { ApiFailure } from './core.js';

export function installAnnotationRoutes(root: FastifyInstance, notes: Annotations): void {
  void root.register(async app => {
  // The default UTF-8 decoder substitutes malformed bytes. Notes must reject them, not rewrite them.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    try { done(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body as Buffer))); }
    catch { done(new ApiFailure(400, 'INVALID_JSON', 'Notes require valid UTF-8 JSON')); }
  });
  const article = (r: FastifyRequest) => uuid.parse((r.params as { id: string }).id);
  const user = (r: FastifyRequest) => r.account!.id as string;
  const query = z.object({ mode: annotationMode.default('feed'), contentHash: contentHash.optional() }).strict();
  const send = (reply: FastifyReply, doc: AnnotationDocument) => { reply.header('ETag', `"${doc.revision}"`); return doc; };
  app.get('/api/articles/:id/annotations', async (r, reply) => {
    const q = query.parse(r.query);
    return send(reply, await notes.get(user(r), article(r), q.mode, q.contentHash));
  });
  app.put('/api/articles/:id/annotations', { bodyLimit: ANNOTATION_LIMITS.bytes }, async (r, reply) => {
    const q = query.parse(r.query);
    if (q.contentHash !== undefined && q.contentHash !== (r.body as { contentHash?: unknown } | null)?.contentHash) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Query and document contexts differ');
    return send(reply, await notes.save(user(r), article(r), q.mode, r.body, annotationPrecondition(r.headers['if-match'])));
  });
  app.delete('/api/articles/:id/annotations', async (r, reply) => {
    const expected = annotationPrecondition(r.headers['if-match']), q = query.parse(r.query);
    const doc = await notes.get(user(r), article(r), q.mode, q.contentHash);
    return send(reply, await notes.save(user(r), article(r), q.mode, null, expected, { clearHash: doc.contentHash }));
  });
  app.get('/api/articles/:id/annotation-versions', async r => {
    const q = z.object({ mode: annotationMode.default('feed'), ...annotationPage }).strict().parse(r.query);
    return notes.versions(user(r), article(r), q.mode, q.offset, q.limit);
  });
  app.get('/api/annotations', async r => {
    const q = z.object({ q: z.string().max(200).default(''), articleId: uuid.optional(), ...annotationPage }).strict().parse(r.query);
    return notes.list(user(r), q);
  });
  app.post('/api/articles/:id/annotations/import', { bodyLimit: ANNOTATION_LIMITS.bytes }, async (r, reply) => {
    const expected = annotationPrecondition(r.headers['if-match']);
    const q = z.object({ mode: annotationMode.optional(), contentHash: contentHash.optional() }).strict().parse(r.query);
    const backup = validateNotesBackup(r.body);
    if (q.mode !== undefined && q.mode !== backup.source.mode || q.contentHash !== undefined && q.contentHash !== backup.source.contentHash) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Query and backup contexts differ');
    return send(reply, await notes.save(user(r), article(r), backup.source.mode, backup, expected, { backup: true }));
  });
  app.get('/api/articles/:id/annotations/export', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (r, reply) => {
    const q = query.extend({ format: z.enum(['json', 'markdown']).default('json') }).parse(r.query);
    const doc = await notes.get(user(r), article(r), q.mode, q.contentHash);
    reply.header('ETag', `"${doc.revision}"`).header('Content-Disposition', `attachment; filename="feedink-notes.${q.format === 'json' ? 'json' : 'zip'}"`);
    if (q.format === 'json') return reply.type('application/json').send(notesBackup(doc));
    return reply.type('application/zip').send(await markdownNotes(doc));
  });
  app.get('/api/articles/:id/annotations/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (r, reply) => {
    const q = query.extend({ group: z.coerce.number().int().min(0).max(4999).default(0) }).parse(r.query);
    const doc = await notes.get(user(r), article(r), q.mode, q.contentHash), preview = await notePreview(doc, q.group);
    return reply.type('image/png').header('ETag', `"${doc.revision}"`).header('Content-Security-Policy', "default-src 'none'")
      .header('X-Ink-Placement', 'raw-unlocated').header('X-Ink-Total-Groups', preview.totalGroups)
      .header('X-Ink-Next-Group', preview.nextGroupOffset === null ? '' : String(preview.nextGroupOffset)).send(preview.bytes);
  });
  });
}
