import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api';
import { useApp } from './context';
import { authEpoch } from './authEpoch';
import { formatDate } from './logic';
import { useAiIdentity } from './aiIdentity';
import { AI_RESULT_RETIRE_EVENT, AI_RESULT_SELECTION_LIMIT, aiResultsPath, aiResultStatusLabels, assertAiResultsDeleted, readAiResultsPage, toggleAiResultSelection, type AiResultRetirement, type AiResultsPage } from './aiResultData';

export function AiResults() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="ai-results-management">
    <button type="button" className="text-button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>管理已保存 AI 结果</button>
    {open && <div id={id}><AiResultsSession /></div>}
  </section>;
}
function AiResultsSession() {
  const app = useApp(), owner = app.session.user.id;
  const [epoch] = useState(authEpoch);
  const { locked, isCurrent } = useAiIdentity(owner);
  const [page, setPage] = useState<AiResultsPage | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const available = app.online && !app.session.user.isDemo;
  const canRequest = useRef(available); canRequest.current = available;
  const current = (run: number) => isCurrent() && generation.current === run;
  function retire() { generation.current++; request.current?.abort(); request.current = null; }
  async function execute(action: (run: number, signal: AbortSignal) => Promise<void>, failure: string) {
    if (!isCurrent() || !canRequest.current || request.current) return;
    const run = ++generation.current, controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setError(''); setMessage('');
    try { await action(run, controller.signal); }
    catch { if (current(run)) setError(failure); }
    finally { clearTimeout(timeout); if (request.current === controller) request.current = null; if (current(run)) setBusy(false); }
  }
  const load = (cursor: string | null = null) => execute(async (run, signal) => {
    const result = await api<AiResultsPage>(aiResultsPath(cursor), { signal });
    if (current(run)) setPage(readAiResultsPage(result));
  }, '无法读取已保存结果，请检查网络后重试。已加载列表和选择仍保留。');
  useEffect(() => { if (available) void load(); return retire; }, []);
  useEffect(() => {
    if (!available || locked) { retire(); setBusy(false); }
    if (locked) { setPage(null); setSelected([]); }
  }, [available, locked]);
  async function removeSelected() {
    if (!selected.length || !isCurrent() || !canRequest.current || request.current) return;
    const ids = [...selected];
    if (!window.confirm(`清理选中的 ${ids.length} 条已结束 AI 结果？\n只删除这些 AI 记录，不影响原文、图片、批注或模型密钥，也不会取消运行中的任务。\n清理后如需再次生成，可能产生模型请求费用；不会自动重新生成。`)) return;
    if (!isCurrent() || !canRequest.current) return;
    await execute(async (run, signal) => {
      // Retire only selected presentation after confirmation, even if the DELETE reply is lost.
      // This is not cancellation or a global purge; failure preserves selection for explicit recovery.
      const detail: AiResultRetirement = { owner, epoch, ids };
      window.dispatchEvent(new CustomEvent<AiResultRetirement>(AI_RESULT_RETIRE_EVENT, { detail }));
      const result = await api<{ deleted: number }>('/ai/results', { method: 'DELETE', signal, body: JSON.stringify({ ids }) });
      if (!current(run)) return;
      assertAiResultsDeleted(result, ids);
      setSelected([]); setPage(null); setMessage(`已清理 ${result.deleted} 条已选 AI 结果。原文、图片、批注与模型密钥未改变。`);
      try {
        const first = await api<AiResultsPage>(aiResultsPath(), { signal });
        if (current(run)) setPage(readAiResultsPage(first));
      } catch { if (current(run)) setError('清理已完成，但列表刷新失败。请重新读取列表。'); }
    }, '清理未获确认，已保留选择。请刷新核对后再操作；所选 AI 展示保持收起，不会自动重新生成。');
  }
  if (locked || !isCurrent()) return null;
  return <section className="ai-results" aria-label="已保存 AI 结果" data-testid="ai-results">
    <p className="muted small">AI 摘要和翻译长期保存在本账号，不按时间或数量自动清理。这里只显示已结束任务的元数据；清理仅针对你选中的记录。</p>
    {!available && <p role="status">{app.session.user.isDemo ? '演示账号不能管理 AI 结果。' : '离线时无法读取或清理 AI 结果，已加载列表与选择仍保留。'}</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {busy && <p role="status">正在处理所选 AI 结果…</p>}
    {page && <>
      <p data-testid="ai-results-total">本次查询共 {page.total} 条已结束记录</p>
      <ul className="ai-result-list">{page.items.map(item => <li key={item.id} data-result-id={item.id}>
        <label className="ai-result-row"><input type="checkbox" aria-label={`选择 AI 结果：${item.sourceTitle || '无标题文章'}（${item.operation === 'summary' ? '摘要' : '翻译'} / ${item.targetLanguage}）`} checked={selected.includes(item.id)} disabled={busy || !available || !selected.includes(item.id) && selected.length >= AI_RESULT_SELECTION_LIMIT} onChange={event => setSelected(ids => toggleAiResultSelection(ids, item.id, event.target.checked))} />
          <span><strong>{item.sourceTitle || '无标题文章'}</strong><span className="ai-result-meta">{item.operation === 'summary' ? '摘要' : '翻译'} · {item.targetLanguage} · {aiResultStatusLabels[item.status as keyof typeof aiResultStatusLabels]} · {item.mode === 'fulltext' ? '归档全文' : 'RSS 正文'}</span><span className="ai-result-meta">模型：{item.model}</span><span className="ai-result-meta">创建：<time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time> · 更新：<time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time></span></span>
        </label>
      </li>)}</ul>
      {!page.items.length && <p>本页没有已保存的 AI 结果。</p>}
    </>}
    <p className="small" data-testid="ai-results-selected">已选 {selected.length} 条（可跨页，最多 {AI_RESULT_SELECTION_LIMIT} 条）</p>
    <div className="button-row"><button type="button" className="text-button" disabled={busy || !selected.length} onClick={() => setSelected([])}>清空选择</button>
      <button type="button" className="secondary" disabled={busy || !available} onClick={() => void load()}>{page ? '刷新并返回首页' : '读取已保存结果'}</button>
      {page?.nextCursor !== null && page?.nextCursor !== undefined && <button type="button" className="secondary" disabled={busy || !available} onClick={() => void load(page.nextCursor)}>下一页结果</button>}
      <button type="button" className="danger" disabled={!selected.length || busy || !available} onClick={() => void removeSelected()}>清理所选结果（{selected.length}）</button></div>
  </section>;
}
