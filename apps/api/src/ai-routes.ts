import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AiService } from './ai.js';
import { aiFailure, safeAiError } from './ai-security.js';

/** Install AFTER Auth.install so every endpoint inherits session, Origin and CSRF checks. */
export function installAiRoutes(root: FastifyInstance, ai: AiService, options: { worker?: boolean } = {}): void {
  // preClose drains/aborts AI before the existing parent onClose hook can close PostgreSQL.
  root.addHook('preClose', async () => { await ai.stop(); });
  if (options.worker) root.addHook('onReady', async () => { ai.start(); });
  void root.register(async app => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      try { done(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body as Buffer))); }
      catch { done(aiFailure('AI_REQUEST')); }
    });
    app.setErrorHandler((error, _request, reply) => {
      // Do not pass provider, SQL or validation exceptions to log serializers or expose their input values.
      const authErrors: Record<string, { status: number; message: string }> = {
        UNAUTHENTICATED: { status: 401, message: 'Sign in to continue' },
        FOREIGN_ORIGIN: { status: 403, message: 'Requests must originate from this application' },
        CSRF: { status: 403, message: 'Missing or invalid CSRF token' },
        RATE_LIMIT: { status: 429, message: 'Too many requests; retry later' },
      };
      const auth = authErrors[error.code];
      if (auth) return reply.code(auth.status).send({ error: { code: error.code, message: auth.message } });
      const safe = safeAiError(error);
      if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: { code: 'AI_LIMIT', message: 'The AI request exceeds the size limit' } });
      return reply.code(safe.statusCode).send({ error: { code: safe.code, message: safe.message } });
    });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
      // Fail closed if this plugin is mistakenly registered without the parent authentication hook.
      if (!request.account || !request.sessionHash) {
        reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } });
      }
    });
    const owner = (request: FastifyRequest) => request.account!.id as string;
    const resource = (request: FastifyRequest): string => {
      const parsed = z.uuid().safeParse((request.params as { id?: unknown }).id);
      if (!parsed.success) throw aiFailure('AI_REQUEST'); return parsed.data;
    };
    const outbound = { bodyLimit: 16384, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
    app.get('/api/ai/config', request => ai.getConfig(owner(request)));
    app.put('/api/ai/config', outbound, request => ai.saveConfig(owner(request), request.body));
    app.post('/api/ai/config/test', { ...outbound, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async request => {
      if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length)) throw aiFailure('AI_REQUEST');
      await ai.testConfig(owner(request)); return { ok: true };
    });
    app.post('/api/articles/:id/ai', outbound, async (request, reply) => {
      const result = await ai.enqueue(owner(request), resource(request), request.body);
      reply.code(result.cached ? 200 : 202); return { job: result.job };
    });
    app.get('/api/ai/jobs/:id', async request => ({ job: await ai.getJob(owner(request), resource(request)) }));
    app.delete('/api/ai/jobs/:id', async (request, reply) => {
      const job = await ai.cancel(owner(request), resource(request));
      reply.code(202); return { job };
    });
  });
}
