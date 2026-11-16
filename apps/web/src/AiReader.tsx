import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, Sparkles } from 'lucide-react';
import type { AiConfig, AiJob, AiLanguage, AiOperation, AnnotationContext, AnnotationDocument, ArticleDetail, ArticleMode } from '@feedink/shared';
import { api } from './api';
import { useApp } from './context';
import { Field } from './components';
import { aiRequestError, useAiIdentity } from './aiIdentity';
import { activeAiJob, aiDisplayMatches, assertAiJob, verifiedAiSource, type AiJobIdentity } from './aiJobs';
import { AiLanguageOptions } from './AiSettings';
import { AiBilingual } from './AiBilingual';
import './ai.css';

const POLL_INTERVAL = 2_000, POLL_WINDOW = 5 * 60_000, MAX_POLLS = 120;
export function AiReader({ article, mode, displayedContext, toolbarHost, bodyHost, returnToOriginal }: {
  article: ArticleDetail; mode: ArticleMode; displayedContext: AnnotationContext | null; toolbarHost: HTMLElement | null; bodyHost: HTMLElement | null; returnToOriginal: () => void;
}) {
  const app = useApp();
  const { locked, isCurrent } = useAiIdentity(app.session.user.id);
  const panelId = useId();
  const displayedSourceMatches = mode !== 'webpage' && aiDisplayMatches(displayedContext, article, mode);
  const [operation, setOperation] = useState<AiOperation | null>(null), [config, setConfig] = useState<AiConfig | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<AiLanguage>('zh-CN');
  const [job, setJob] = useState<AiJob | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(true), [cancelRequested, setCancelRequested] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const task = useRef<{ identity: AiJobIdentity; id: string } | null>(null);
  const online = useRef(app.online); online.current = app.online;
  const current = (run: number) => isCurrent() && generation.current === run;
  function stop() { generation.current++; controller.current?.abort(); controller.current = null; if (timer.current) clearTimeout(timer.current); timer.current = null; }
  useEffect(() => {
    const retireConfiguration = () => { stop(); task.current = null; setOperation(null); setJob(null); setConfig(null); setBusy(false); };
    window.addEventListener('feedink:ai-config-changed', retireConfiguration);
    return () => { stop(); window.removeEventListener('feedink:ai-config-changed', retireConfiguration); };
  }, []);
  useEffect(() => { if (operation) bodyHost?.querySelector<HTMLElement>('.ai-card')?.focus(); }, [operation, bodyHost]);
  useEffect(() => {
    if (!app.online || locked) { stop(); setBusy(false); if (task.current) setPaused(true); }
    if (locked) { setJob(null); setConfig(null); setOperation(null); }
  }, [app.online, locked]);
  async function request<T>(path: string, options: RequestInit, run: number): Promise<T> {
    if (!current(run) || !online.current) throw new Error('AI_RETIRED');
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 20_000);
    try { return await api<T>(path, { ...options, signal: abort.signal }); }
    finally { clearTimeout(timeout); if (controller.current === abort) controller.current = null; }
  }
  function report(reason: unknown, run: number) { if (current(run)) { setError(aiRequestError(reason)); setBusy(false); } }
  async function choose(next: AiOperation) {
    stop(); const run = generation.current;
    task.current = null; setJob(null); setError(''); setPaused(false); setCancelRequested(false); setConfig(null); setTargetLanguage('zh-CN'); setExpanded(true);
    setOperation(next); setBusy(false);
    if (!isCurrent() || !online.current || !displayedSourceMatches || app.session.user.isDemo || mode === 'webpage' || mode === 'fulltext' && !article.fulltextHtml) return;
    setBusy(true);
    try { const saved = await request<AiConfig>('/ai/config', {}, run); if (current(run)) { setConfig(saved); setTargetLanguage(saved.targetLanguage || 'zh-CN'); setBusy(false); } }
    catch (reason) { report(reason, run); }
  }
  function close() { stop(); task.current = null; setOperation(null); setJob(null); setConfig(null); setBusy(false); toolbarHost?.querySelector<HTMLButtonElement>(`[data-ai-operation="${operation}"]`)?.focus({ preventScroll: true }); }
  function poll(identity: AiJobIdentity, id: string, run: number, started = Date.now(), count = 0) {
    if (!current(run)) return;
    if (!online.current || count >= MAX_POLLS || Date.now() - started >= POLL_WINDOW) { setPaused(true); return; }
    timer.current = setTimeout(() => {
      timer.current = null;
      void (async () => {
        try {
          const response = await request<{ job: AiJob }>(`/ai/jobs/${encodeURIComponent(id)}`, {}, run);
          if (!current(run)) return;
          assertAiJob(response.job, identity, id); setJob(response.job);
          if (activeAiJob(response.job)) poll(identity, id, run, started, count + 1);
        } catch (reason) { if (current(run)) setPaused(true); report(reason, run); }
      })();
    }, POLL_INTERVAL);
  }
  async function start(force = false) {
    if (!displayedSourceMatches || !operation || !config?.enabled || !config.hasKey || busy || controller.current || job && activeAiJob(job) || !online.current || app.session.user.isDemo || mode === 'webpage' || mode === 'fulltext' && !article.fulltextHtml || !isCurrent()) return;
    stop(); const run = generation.current;
    setBusy(true); setError(''); setJob(null); setPaused(false); setExpanded(true); setCancelRequested(false); task.current = null;
    try {
      // Verify the exact displayed source only on explicit action, BEFORE a paid POST.
      const document = await request<AnnotationDocument>(`/articles/${encodeURIComponent(article.id)}/annotations?${new URLSearchParams({ mode })}`, {}, run);
      if (!current(run)) return;
      const contentHash = verifiedAiSource(document, article, mode);
      if (contentHash !== displayedContext?.contentHash) throw new Error('AI_DISPLAY_CHANGED');
      const identity: AiJobIdentity = { articleId: article.id, mode, contentHash, operation, targetLanguage, sourceUrl: article.url, sourceTitle: article.title };
      const response = await request<{ job: AiJob }>(`/articles/${encodeURIComponent(article.id)}/ai`, { method: 'POST', body: JSON.stringify({ operation, mode, targetLanguage, contentHash, ...(force ? { force: true } : {}) }) }, run);
      if (!current(run)) return;
      assertAiJob(response.job, identity); task.current = { identity, id: response.job.id }; setJob(response.job); setBusy(false);
      if (activeAiJob(response.job)) poll(identity, response.job.id, run);
    } catch (reason) { report(reason, run); }
  }
  async function cancel() {
    const selected = task.current;
    if (!selected || !job || !activeAiJob(job) || !online.current || !isCurrent() || busy) return;
    stop(); const run = generation.current; setBusy(true); setError(''); setPaused(false);
    try {
      await request(`/ai/jobs/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }, run);
      if (!current(run)) return;
      setCancelRequested(true); setBusy(false); poll(selected.identity, selected.id, run);
    } catch (reason) { if (current(run)) setPaused(true); report(reason, run); }
  }
  function resume() { const selected = task.current; if (!selected || !online.current || !isCurrent()) return; stop(); setPaused(false); setError(''); poll(selected.identity, selected.id, generation.current); }
  const unavailable = app.session.user.isDemo ? '演示账号不能调用 AI。' : !app.online ? '离线时无法请求 AI；原文与批注仍可阅读。' : mode === 'webpage' ? 'AI 只处理已归档正文，请先切换至 RSS 正文或归档全文。' : mode === 'fulltext' && !article.fulltextHtml ? '尚无归档全文。请先提取全文，或切换至 RSS 正文。' : !displayedSourceMatches ? '返回最新正文后使用 AI（正在验证或正在查看历史批注正文）。' : '';
  if (locked || !isCurrent()) return null;
  const title = operation === 'summary' ? 'AI 摘要' : 'AI 双语翻译';
  return <>
    {toolbarHost && createPortal(<span className="ai-toolbar" role="group" aria-label="AI 阅读操作">
      <button type="button" className="icon-button" data-ai-operation="summary" aria-label="AI 摘要" title="AI 摘要" aria-controls={operation ? panelId : undefined} aria-expanded={operation === 'summary'} onClick={() => void choose('summary')}><Sparkles size={19} strokeWidth={1.65} aria-hidden="true" /></button>
      <button type="button" className="icon-button" data-ai-operation="translate" aria-label="AI 双语翻译" title="AI 双语翻译" aria-controls={operation ? panelId : undefined} aria-expanded={operation === 'translate'} onClick={() => void choose('translate')}><Languages size={19} strokeWidth={1.65} aria-hidden="true" /></button>
    </span>, toolbarHost)}
    {bodyHost && operation && createPortal(<section id={panelId} className="ai-card" tabIndex={-1} aria-label={title} data-testid="ai-card" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><h2>{title}</h2><button type="button" className="text-button" onClick={close}>收起 AI</button></header>
      <p className="muted small">{mode === 'fulltext' ? '归档全文' : 'RSS 正文'} · 原文和批注保持独立。关闭面板或离开文章只停止进度查询，不取消服务端任务。</p>
      {unavailable ? <p role="status">{unavailable}</p> : <>
        {busy && !job && <p role="status">正在验证配置与正文…</p>}
        {config && (!config.enabled || !config.hasKey) ? <p role="status">请先在 <button type="button" className="text-button" onClick={() => app.navigate(`/settings/ai${location.search}`)}>AI 模型设置</button> 中启用模型并保存密钥。</p> : config && <>
          <Field label="本次目标语言"><select value={targetLanguage} disabled={busy || !!job && activeAiJob(job)} onChange={event => { stop(); task.current = null; setJob(null); setPaused(false); setError(''); setTargetLanguage(event.target.value as AiLanguage); }}><AiLanguageOptions /></select></Field>
          {!job && <button type="button" className="secondary" disabled={busy} onClick={() => void start()}>{operation === 'summary' ? '生成摘要' : '生成双语翻译'}</button>}
          <p className="muted small">仅本次所选正文会发送至已配置模型，可能产生费用。匹配的账号内缓存结果可直接复用。</p>
        </>}
        {!config && !busy && <button type="button" className="secondary" onClick={() => void choose(operation)}>重新读取配置</button>}
      </>}
      {error && <p role="alert">{error}</p>}
      {job && <>
        <div role="status" aria-live="polite" data-testid="ai-progress">
          <p>{job.status === 'queued' ? '排队中' : job.status === 'running' ? '处理中' : job.status === 'succeeded' ? '处理完成' : job.status === 'skipped' ? '检测到正文已是目标语言，未翻译' : job.status === 'cancelled' ? '任务已取消' : '任务失败；未自动重试'} · 已处理 {job.completedChunks} / {job.totalChunks} 段</p>
          {job.totalChunks > 0 && <progress aria-label="AI 正文覆盖进度" value={job.completedChunks} max={job.totalChunks} />}
          {job.status === 'failed' && <p>结果不完整或服务未能完成请求，未作为完整结果显示。尚缺 {Math.max(0, job.totalChunks - job.completedChunks)} 段。请检查配置后明确重试。</p>}
          {cancelRequested && activeAiJob(job) && <p>已请求取消，正在等待服务端确认。</p>}
        </div>
        {activeAiJob(job) && <div className="button-row"><button type="button" className="secondary" disabled={busy || !app.online || cancelRequested} onClick={() => void cancel()}>取消任务</button>{paused && <button type="button" className="secondary" disabled={!app.online || busy} onClick={resume}>继续查询进度</button>}</div>}
        {paused && activeAiJob(job) && <p role="status">进度查询已暂停（离线、请求失败或达到本次查询上限）。任务可能仍在服务端运行；继续查询不会重新生成。</p>}
        {job.status === 'succeeded' && job.result && (operation === 'summary' ? <div className="ai-summary" data-testid="ai-summary">{job.result.summaryText}</div> : <>
          <div className="button-row"><button type="button" className="secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起双语结果' : '展开双语结果'}</button><button type="button" className="text-button" onClick={() => { setExpanded(false); returnToOriginal(); }}>返回原文与批注</button></div>
          <p className="muted small">逐段原文与译文。代码保持原样，不计入可翻译正文覆盖。批注仅附着于下方独立原文。</p>
          {expanded && <AiBilingual html={job.result.bilingualHtml!} sourceHtml={mode === 'fulltext' ? article.fulltextHtml! : article.contentHtml} article={article} />}
        </>)}
        {!activeAiJob(job) && <button type="button" className="text-button" disabled={busy || !!unavailable} onClick={() => void start(true)}>{job.status === 'succeeded' || job.status === 'skipped' ? '重新生成（会发送请求）' : '重试任务（会发送请求）'}</button>}
      </>}
    </section>, bodyHost)}
  </>;
}
