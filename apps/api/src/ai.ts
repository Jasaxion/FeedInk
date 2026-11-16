import { z } from 'zod';
import type { AiConfig, AiJob, AiLanguage } from '@feedink/shared';
import { type DB, type SQL, type Row, hash, id, iso, withConnection } from './core.js';
import { Annotations } from './annotations.js';
import { aiFailure, aiErrorFromCode, safeAiError, encryptAiKey, decryptAiKey, type AiEnvironment } from './ai-security.js';
import { PinnedAiProvider, type AiProvider, type AiMessage, type AiProviderConfig } from './ai-provider.js';
import { AI_PROMPT_VERSION, AI_MAX_CALLS, prepareAiDocument, detectAiLanguage, segmentBatches, splitAiText,
  translationMessages, validateTranslations, summaryMessages, validateSummary, type AiSegment } from './ai-content.js';

export const aiLanguage = z.enum(['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es']);
export const aiConfigInput = z.object({ enabled: z.boolean(), baseUrl: z.string().max(2048), model: z.string().trim().max(200),
  targetLanguage: aiLanguage, apiKey: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).nullable().optional() }).strict();
export const aiJobInput = z.object({ operation: z.enum(['summary', 'translate']), mode: z.enum(['feed', 'fulltext']),
  targetLanguage: aiLanguage.optional(), force: z.boolean().default(false), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const DEFAULT_AI_CONFIG: AiConfig = { enabled: false, baseUrl: '', model: '', hasKey: false, targetLanguage: 'zh-CN', revision: 0, updatedAt: null };
const configDto = (row?: Row): AiConfig => row ? ({ enabled: row.enabled, baseUrl: row.base_url, model: row.model, hasKey: !!row.encrypted_key,
  targetLanguage: row.target_language, revision: row.revision, updatedAt: row.updated_at ? iso(row.updated_at) : null }) : { ...DEFAULT_AI_CONFIG };
export function aiJobDto(row: Row): AiJob {
  return { id: row.id, articleId: row.article_id, mode: row.mode, contentHash: row.content_hash, operation: row.operation,
    targetLanguage: row.target_language, status: row.status, stage: row.stage, completedChunks: row.completed_chunks,
    totalChunks: row.total_chunks, detectedLanguage: row.detected_language, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.result ? { result: row.result } : {}), ...(row.error_code ? { error: (() => { const e = aiErrorFromCode(row.error_code); return { code: e.code, message: e.message }; })() } : {}) };
}
async function transaction<T>(db: DB, task: (sql: SQL) => Promise<T>): Promise<T> {
  return withConnection(db, async sql => {
    await sql`BEGIN`;
    try { await sql`SET LOCAL lock_timeout='5s'`; await sql`SET LOCAL statement_timeout='15s'`; const result = await task(sql); await sql`COMMIT`; return result; }
    catch (error) { await sql`ROLLBACK`; throw error; }
  });
}
interface Snapshot { contentHash: string; snapshotHash: string; html: string; title: string; url: string }
export const AI_JOB_DEADLINE_MS = 30 * 60 * 1000;
export class AiService {
  readonly provider: AiProvider;
  readonly destinations: PinnedAiProvider;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly probes = new Set<{ controller: AbortController; promise: Promise<{ ok: true; revision: number }> }>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private stopped = false;
  constructor(readonly db: DB, readonly environment: AiEnvironment, provider?: AiProvider) {
    this.destinations = new PinnedAiProvider(environment); this.provider = provider ?? this.destinations;
  }
  private async account(sql: SQL, owner: string, lock = false): Promise<void> {
    const rows = lock ? await sql`SELECT is_demo,disabled FROM users WHERE id=${owner} FOR UPDATE`
      : await sql`SELECT is_demo,disabled FROM users WHERE id=${owner}`;
    if (!rows.length || rows[0].disabled) throw aiFailure('AI_NOT_FOUND');
    if (rows[0].is_demo) throw aiFailure('AI_DEMO');
  }
  private async snapshot(sql: SQL, owner: string, articleId: string, mode: 'feed' | 'fulltext'): Promise<Snapshot> {
    const [article] = await sql`SELECT id,user_id,title,url,content_html,fulltext_html FROM articles WHERE id=${articleId} AND user_id=${owner} FOR UPDATE`;
    if (!article) throw aiFailure('AI_NOT_FOUND');
    if (mode === 'fulltext' && article.fulltext_html === null) throw aiFailure('AI_FULLTEXT_MISSING');
    const context = await new Annotations(this.db).currentContext(sql, article, mode);
    return { contentHash: context.contentHash, snapshotHash: hash(JSON.stringify([context.contentHash, article.title, context.contentHtml])),
      html: context.contentHtml, title: article.title, url: article.url };
  }
  async getConfig(owner: string): Promise<AiConfig> {
    const [row] = await this.db`SELECT enabled,base_url,model,encrypted_key IS NOT NULL AS has_key,target_language,revision,updated_at FROM ai_configs WHERE user_id=${owner}`;
    return row ? { ...configDto(row), hasKey: row.has_key } : { ...DEFAULT_AI_CONFIG };
  }
  async saveConfig(owner: string, value: unknown): Promise<AiConfig> {
    const input = aiConfigInput.safeParse(value); if (!input.success) throw aiFailure('AI_REQUEST');
    const data = input.data;
    const baseUrl = data.baseUrl ? this.destinations.validate(data.baseUrl).href.replace(/\/$/, '') : '';
    return transaction(this.db, async sql => {
      await this.account(sql, owner, true);
      const [previous] = await sql`SELECT * FROM ai_configs WHERE user_id=${owner}`;
      if ((previous?.revision ?? 0) >= 2147483647) throw aiFailure('AI_LIMIT');
      const revision = (previous?.revision ?? 0) + 1;
      let encrypted: string | null = null;
      if (data.apiKey !== null) {
        const secret = data.apiKey ?? (previous?.encrypted_key ? decryptAiKey(this.environment.encryptionKey, owner, previous.revision, previous.encrypted_key) : null);
        if (secret) encrypted = encryptAiKey(this.environment.encryptionKey, owner, revision, secret);
      }
      if (data.enabled && (!baseUrl || !data.model || !encrypted)) throw aiFailure('AI_CONFIG');
      const [row] = await sql`INSERT INTO ai_configs(user_id,enabled,base_url,model,encrypted_key,target_language,revision,updated_at)
        VALUES(${owner},${data.enabled},${baseUrl},${data.model},${encrypted},${data.targetLanguage},${revision},now())
        ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,base_url=EXCLUDED.base_url,model=EXCLUDED.model,
          encrypted_key=EXCLUDED.encrypted_key,target_language=EXCLUDED.target_language,revision=EXCLUDED.revision,updated_at=now() RETURNING *`;
      await sql`UPDATE ai_jobs SET status='failed',stage='stale',error_code='AI_STALE_SOURCE',result=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
        WHERE user_id=${owner} AND status IN ('queued','running')`;
      return configDto(row);
    });
  }
  private async providerConfig(sql: SQL, owner: string, revision?: number, allowDisabled = false): Promise<AiProviderConfig> {
    await this.account(sql, owner);
    const [row] = await sql`SELECT * FROM ai_configs WHERE user_id=${owner}`;
    if (!row || !allowDisabled && !row.enabled || !row.base_url || !row.model || !row.encrypted_key) throw aiFailure('AI_CONFIG');
    if (revision !== undefined && row.revision !== revision) throw aiFailure('AI_STALE_SOURCE');
    return { baseUrl: row.base_url, model: row.model, apiKey: decryptAiKey(this.environment.encryptionKey, owner, row.revision, row.encrypted_key) };
  }
  async testConfig(owner: string): Promise<{ ok: true; revision: number }> {
    if (this.stopped) throw aiFailure('AI_INTERRUPTED');
    if (this.probes.size) throw aiFailure('AI_QUEUE_FULL');
    const controller = new AbortController();
    const promise = this.probe(owner, controller), probe = { controller, promise };
    this.probes.add(probe);
    try { return await promise; } finally { this.probes.delete(probe); }
  }
  private async probe(owner: string, controller: AbortController): Promise<{ ok: true; revision: number }> {
    // One global connectivity probe at a time, including across API processes. Never retried.
    return withConnection(this.db, async sql => {
      const [lock] = await sql`SELECT pg_try_advisory_lock(71244010) AS acquired`;
      if (!lock.acquired) throw aiFailure('AI_QUEUE_FULL');
      try {
        const config = await this.providerConfig(sql, owner, undefined, true);
        const [row] = await sql`SELECT revision FROM ai_configs WHERE user_id=${owner}`;
        const output = await this.provider.complete(config, [{ role: 'system', content: 'Return only the JSON object {"ok":true}.' }, { role: 'user', content: 'Connectivity test.' }], controller.signal, { maxTokens: 16 });
        try { if (JSON.stringify(JSON.parse(output)) !== '{"ok":true}') throw new Error(); } catch { throw aiFailure('AI_OUTPUT'); }
        return { ok: true as const, revision: row.revision };
      } catch (error) { throw safeAiError(error); }
      finally { controller.abort(); await sql`SELECT pg_advisory_unlock(71244010)`; }
    });
  }
  async enqueue(owner: string, articleId: string, value: unknown): Promise<{ job: AiJob; cached: boolean }> {
    const parsed = aiJobInput.safeParse(value); if (!parsed.success) throw aiFailure('AI_REQUEST');
    const input = parsed.data;
    return transaction(this.db, async sql => {
      // Short admission/claim critical section bounds the queue globally without scanning articles.
      await sql`SELECT pg_advisory_xact_lock(71244009)`;
      await this.account(sql, owner, true);
      await this.providerConfig(sql, owner);
      const [config] = await sql`SELECT revision,target_language FROM ai_configs WHERE user_id=${owner}`;
      const snapshot = await this.snapshot(sql, owner, articleId, input.mode);
      if (input.contentHash !== undefined && input.contentHash !== snapshot.contentHash) throw aiFailure('AI_STALE_SOURCE');
      const document = prepareAiDocument(snapshot.html, snapshot.title, input.operation);
      if (!document.segments.length) throw aiFailure('AI_LIMIT');
      const language: AiLanguage = input.targetLanguage ?? config.target_language;
      const key = hash(JSON.stringify([owner, articleId, input.mode, snapshot.snapshotHash, input.operation, language, config.revision, AI_PROMPT_VERSION]));
      const [active] = await sql`SELECT * FROM ai_jobs WHERE user_id=${owner} AND cache_key=${key} AND status IN ('queued','running') LIMIT 1`;
      if (active) {
        if (input.force) throw aiFailure('AI_ACTIVE_JOB');
        return { job: aiJobDto(active), cached: false };
      }
      const [previous] = await sql`SELECT * FROM ai_jobs WHERE user_id=${owner} AND cache_key=${key} ORDER BY created_at DESC,id DESC LIMIT 1`;
      if (!input.force && previous) {
        if (['succeeded', 'skipped'].includes(previous.status) && new Date(previous.updated_at).getTime() > Date.now() - 7 * 86400000) return { job: aiJobDto(previous), cached: true };
        if (['failed', 'cancelled'].includes(previous.status)) throw aiFailure('AI_INTERRUPTED');
      }
      const [counts] = await sql`SELECT count(*)::integer AS total,count(*) FILTER(WHERE user_id=${owner})::integer AS owned FROM ai_jobs WHERE status IN ('queued','running')`;
      if (counts.total >= 128 || counts.owned >= 8) throw aiFailure('AI_QUEUE_FULL');
      // Cap retained jobs as well as active work. Cleanup never touches the source or notes.
      await sql`DELETE FROM ai_jobs WHERE id IN (SELECT id FROM ai_jobs WHERE user_id=${owner} AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC OFFSET 127)`;
      const [retained] = await sql`SELECT count(*)::integer AS total FROM ai_jobs`;
      if (retained.total >= 4096) await sql`DELETE FROM ai_jobs WHERE id IN (SELECT id FROM ai_jobs WHERE status NOT IN ('queued','running') ORDER BY updated_at,id LIMIT 128)`;
      const [row] = await sql`INSERT INTO ai_jobs(id,user_id,article_id,mode,content_hash,snapshot_hash,cache_key,config_revision,prompt_version,operation,target_language,source_html,source_title,source_url,total_chunks)
        VALUES(${id()},${owner},${articleId},${input.mode},${snapshot.contentHash},${snapshot.snapshotHash},${key},${config.revision},${AI_PROMPT_VERSION},${input.operation},${language},${snapshot.html},${snapshot.title},${snapshot.url},${document.segments.length}) RETURNING *`;
      return { job: aiJobDto(row), cached: false };
    });
  }
  private async assertFresh(sql: SQL, row: Row): Promise<void> {
    await this.account(sql, row.user_id, true);
    const [config] = await sql`SELECT enabled,revision FROM ai_configs WHERE user_id=${row.user_id}`;
    const snapshot = await this.snapshot(sql, row.user_id, row.article_id, row.mode);
    if (!config?.enabled || config.revision !== row.config_revision || snapshot.snapshotHash !== row.snapshot_hash || row.prompt_version !== AI_PROMPT_VERSION) throw aiFailure('AI_STALE_SOURCE');
  }
  async getJob(owner: string, jobId: string): Promise<AiJob> {
    return transaction(this.db, async sql => {
      const [row] = await sql`SELECT * FROM ai_jobs WHERE id=${jobId} AND user_id=${owner}`;
      if (!row) throw aiFailure('AI_NOT_FOUND');
      try { await this.assertFresh(sql, row); }
      catch (error) {
        if (row.status !== 'cancelled') {
          const safe = safeAiError(error);
          const [updated] = await sql`UPDATE ai_jobs SET status='failed',stage='stale',result=NULL,error_code=${safe.code},lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=${jobId} AND user_id=${owner} AND status<>'cancelled' RETURNING *`;
          if (updated) return aiJobDto(updated);
        }
      }
      // Cancellation/config writes can race the initial read; return the latest fenced row, not a stale result.
      const [latest] = await sql`SELECT * FROM ai_jobs WHERE id=${jobId} AND user_id=${owner}`;
      if (!latest) throw aiFailure('AI_NOT_FOUND');
      return aiJobDto(latest);
    });
  }
  async cancel(owner: string, jobId: string): Promise<AiJob> {
    const rows = await this.db`UPDATE ai_jobs SET status='cancelled',stage='cancelled',result=NULL,error_code='AI_CANCELLED',lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE id=${jobId} AND user_id=${owner} AND status IN ('queued','running') RETURNING *`;
    if (rows.length) { this.active.get(jobId)?.controller.abort(); return aiJobDto(rows[0]); }
    return this.getJob(owner, jobId);
  }
  async recoverExpired(): Promise<void> {
    await this.db`UPDATE ai_jobs SET status='failed',stage='interrupted',result=NULL,error_code='AI_INTERRUPTED',lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE status='running' AND lease_until<=now() AND id IN (SELECT id FROM ai_jobs WHERE status='running' AND lease_until<=now() ORDER BY lease_until,id LIMIT 128)`;
    await this.db`DELETE FROM ai_jobs WHERE id IN (SELECT id FROM ai_jobs WHERE status NOT IN ('queued','running') AND updated_at<now()-interval '7 days' ORDER BY updated_at,id LIMIT 128)`;
  }
  async claim(): Promise<Row | undefined> {
    return transaction(this.db, async sql => {
      await sql`SELECT pg_advisory_xact_lock(71244009)`;
      const [count] = await sql`SELECT count(*)::integer AS total FROM ai_jobs WHERE status='running'`;
      if (count.total >= 2) return undefined;
      const [row] = await sql`SELECT * FROM ai_jobs j WHERE j.status='queued' AND NOT EXISTS(SELECT 1 FROM ai_jobs r WHERE r.user_id=j.user_id AND r.status='running')
        ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
      if (!row) return undefined;
      const [claimed] = await sql`UPDATE ai_jobs SET status='running',stage='preparing',lease_token=${id()},lease_until=now()+interval '120 seconds',started_at=now(),updated_at=now() WHERE id=${row.id} RETURNING *`;
      return claimed;
    });
  }
  private async checkpoint(row: Row, stage: string, completed: number, total: number, detected: AiJob['detectedLanguage']): Promise<void> {
    const updated = await this.db`UPDATE ai_jobs SET stage=${stage},completed_chunks=${completed},total_chunks=${total},detected_language=${detected},call_in_flight=false,updated_at=now()
      WHERE id=${row.id} AND status='running' AND lease_token=${row.lease_token} AND lease_until>now() RETURNING id`;
    if (!updated.length) throw aiFailure('AI_INTERRUPTED');
  }
  private async call(row: Row, messages: AiMessage[], signal: AbortSignal): Promise<string> {
    if (signal.aborted || Date.now() - new Date(row.started_at).getTime() >= AI_JOB_DEADLINE_MS) throw aiFailure('AI_INTERRUPTED');
    const config = await transaction(this.db, async sql => {
      await this.assertFresh(sql, row);
      const config = await this.providerConfig(sql, row.user_id, row.config_revision);
      // Commit call intent BEFORE sending. An expired lease is never requeued, even if this was the last write.
      const updated = await sql`UPDATE ai_jobs SET call_in_flight=true,provider_calls=provider_calls+1,updated_at=now()
        WHERE id=${row.id} AND status='running' AND lease_token=${row.lease_token} AND lease_until>now() AND NOT call_in_flight AND provider_calls<${AI_MAX_CALLS} RETURNING id`;
      if (!updated.length) throw aiFailure('AI_INTERRUPTED');
      return config;
    });
    if (signal.aborted) throw aiFailure('AI_INTERRUPTED');
    const output = await this.provider.complete(config, messages, signal);
    if (signal.aborted) throw aiFailure('AI_INTERRUPTED');
    if (output.includes(config.apiKey)) throw aiFailure('AI_OUTPUT');
    return output;
  }
  private async publish(row: Row, status: 'succeeded' | 'skipped', result: NonNullable<AiJob['result']>): Promise<void> {
    await transaction(this.db, async sql => {
      await this.assertFresh(sql, row);
      const updated = await sql`UPDATE ai_jobs SET status=${status},stage='complete',result=${sql.json(result)},error_code=NULL,completed_chunks=total_chunks,
        call_in_flight=false,lease_token=NULL,lease_until=NULL,updated_at=now()
        WHERE id=${row.id} AND status='running' AND lease_token=${row.lease_token} AND lease_until>now() RETURNING id`;
      if (!updated.length) throw aiFailure('AI_INTERRUPTED');
    });
  }
  async runClaimed(row: Row, controller = new AbortController()): Promise<void> {
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = (async () => {
        const updated = await this.db`UPDATE ai_jobs SET lease_until=now()+interval '120 seconds'
          WHERE id=${row.id} AND status='running' AND lease_token=${row.lease_token} AND lease_until>now()
          AND started_at>now()-interval '30 minutes' RETURNING id`;
        if (!updated.length) controller.abort();
      })().catch(() => { controller.abort(); }).finally(() => { heartbeat = undefined; });
    }, 2000);
    timer.unref();
    try {
      const doc = prepareAiDocument(row.source_html, row.source_title, row.operation);
      const detected = detectAiLanguage(doc.segments);
      const source = { sourceTitle: row.source_title as string, sourceUrl: row.source_url as string };
      await this.checkpoint(row, 'detecting', 0, doc.segments.length, detected);
      if (row.operation === 'translate' && detected === row.target_language) {
        await this.publish(row, 'skipped', source); return;
      }
      let completed = 0, total = doc.segments.length;
      if (row.operation === 'translate') {
        const values = new Map<string, string>();
        for (const batch of segmentBatches(doc.segments)) {
          const translated = validateTranslations(await this.call(row, translationMessages(batch, row.target_language), controller.signal), batch);
          for (const [id, text] of translated) values.set(id, text);
          completed += batch.length;
          await this.checkpoint(row, 'translating', completed, total, detected);
        }
        await this.publish(row, 'succeeded', { ...source, bilingualHtml: doc.render(values, row.target_language) });
      } else {
        let segments = doc.segments, level = 0;
        while (true) {
          const summaries: string[] = [];
          for (const batch of segmentBatches(segments)) {
            summaries.push(validateSummary(await this.call(row, summaryMessages(batch, row.target_language), controller.signal), batch));
            completed += batch.length;
            await this.checkpoint(row, level ? 'reducing' : 'summarizing', completed, total, detected);
          }
          if (summaries.length === 1) { await this.publish(row, 'succeeded', { ...source, summaryText: summaries[0] }); break; }
          if (++level > 8) throw aiFailure('AI_LIMIT');
          segments = summaries.flatMap((text, i) => splitAiText(text).map((text, part): AiSegment => ({ id: `r${level}-${i}-${part}`, text })));
          total += segments.length;
          await this.checkpoint(row, 'reducing', completed, total, detected);
        }
      }
    } catch (error) {
      const safe = safeAiError(error);
      // A lost final commit may already have succeeded. Never overwrite terminal/cancelled work or retry it.
      await this.db`UPDATE ai_jobs SET status='failed',stage='failed',result=NULL,error_code=${safe.code},lease_token=NULL,lease_until=NULL,updated_at=now()
        WHERE id=${row.id} AND status='running' AND lease_token=${row.lease_token}`.catch(() => {});
    } finally { clearInterval(timer); controller.abort(); await heartbeat; }
  }
  /** Exposed for a hosted deterministic worker harness; production uses start/stop. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.recoverExpired();
    while (!this.stopped && this.active.size < 2) {
      const row = await this.claim(); if (!row) break;
      const controller = new AbortController();
      const promise = this.runClaimed(row, controller).finally(() => { this.active.delete(row.id); });
      this.active.set(row.id, { controller, promise });
    }
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const poll = () => { if (!this.polling) this.polling = this.tick().catch(() => {}).finally(() => { this.polling = undefined; }); };
    this.timer = setInterval(poll, 1000); this.timer.unref(); poll();
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await this.polling;
    for (const job of this.active.values()) job.controller.abort();
    for (const probe of this.probes) probe.controller.abort();
    await Promise.all([...this.active.values()].map(job => job.promise));
    await Promise.allSettled([...this.probes].map(probe => probe.promise));
  }
}
