import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationDocument, AnnotationMode, AnnotationVersion, ArticleDetail, MarkColor, TextAnnotation, TextMarkKind } from '@feedink/shared';
import { WebInkOverlay } from '@feedink/ink/overlay';
import type { HostMessage, Tool } from '@feedink/ink/types';
import { useApp } from './context';
import { api, HttpError } from './api';
import { assertAuthEpoch, authEpoch } from './authEpoch';
import { annotationKey, assertContext, markColors, markLabels, validateAnnotations, type StoredAnnotations } from './annotationData';
import { annotationPath, fetchAnnotations, registerNotes, synchronizeAnnotations } from './annotationSync';
import { exportNotesJson, exportNotesMarkdown, printNotes } from './annotationExport';
import { captureQuote, matchQuote, quoteRange, quoteStream } from './textAnchors';
import { sanitizeArticle } from './safety';

const errorText = (error: unknown) => error instanceof Error ? error.message : '批注操作失败';
export function AnnotatedArticle({ article, mode, onImage, onTap }: { article: ArticleDetail; mode: AnnotationMode; onImage: (url: string) => void; onTap: () => void }) {
  const app = useApp(), owner = app.session.user.id;
  const [epoch] = useState(authEpoch);
  const root = useRef<HTMLDivElement>(null), engine = useRef<WebInkOverlay | null>(null);
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [row, setRow] = useState<StoredAnnotations | null>(null);
  const current = useRef<StoredAnnotations | null>(null), storedVersion = useRef<string | null>(null);
  const writeTail = useRef<Promise<void>>(Promise.resolve()), writeError = useRef<unknown>(null), frozen = useRef(false), alive = useRef(true);
  const [status, setStatus] = useState('打开批注以载入笔记'), [error, setError] = useState(''), [engineError, setEngineError] = useState('');
  const [tool, setTool] = useState<Tool | 'text'>('text'), [color, setColor] = useState<MarkColor>('yellow'), [width, setWidth] = useState(3);
  const [historyState, setHistoryState] = useState({ undo: false, redo: false }), [editor, setEditor] = useState<string | null>(null);
  const [versions, setVersions] = useState<AnnotationVersion[]>([]), [nextVersion, setNextVersion] = useState<number | null>(0);
  const [historical, setHistorical] = useState(false), [syncing, setSyncing] = useState(false);
  const rawHtml = row?.document.context.contentHtml ?? (mode === 'fulltext' && article.fulltextHtml ? article.fulltextHtml : article.contentHtml);
  const html = useMemo(() => sanitizeArticle(rawHtml, app.session.settings.lazyImages), [rawHtml, app.session.settings.lazyImages]);
  const present = (next: StoredAnnotations) => { current.current = next; if (alive.current) setRow(next); };
  const pendingLabel = (value: StoredAnnotations) => value.conflict ? '存在版本冲突 · 本地草稿保留' : value.pending ? '本地待同步 · 已保存到本机' : `已同步 · 服务器已确认修订 ${value.document.revision}`;
  function persist(next: StoredAnnotations) {
    writeError.current = null;
    const work = writeTail.current.catch(() => {}).then(async () => {
      const existing = await app.store.annotations(owner, next.document.context);
      // Acknowledgement can advance the baseline while the user continues typing.
      const candidate = existing?.localVersion === storedVersion.current
        ? { ...next, document: { ...next.document, revision: existing.document.revision, id: existing.document.id, updatedAt: existing.document.updatedAt }, ...(existing.conflict ? { conflict: existing.conflict } : {}) } : next;
      await app.store.putAnnotations(owner, candidate, storedVersion.current);
      storedVersion.current = candidate.localVersion; writeError.current = null;
      if (current.current?.localVersion === candidate.localVersion) { present(candidate); if (alive.current) setStatus(pendingLabel(candidate)); }
    });
    writeTail.current = work;
    void work.catch(reason => { writeError.current = reason; if (alive.current) { setStatus('未保存 · 请保留此页并导出 JSON'); setError(errorText(reason)); } });
  }
  function update(document: AnnotationDocument): boolean {
    if (frozen.current || !current.current) return false;
    try {
      const next = { ...current.current, document: validateAnnotations(document), pending: true, localVersion: crypto.randomUUID() };
      present(next); setStatus('未保存 · 正在写入本机'); setError(''); persist(next); return true;
    } catch (reason) { setError(errorText(reason)); return false; }
  }
  async function flush() {
    if (engine.current && !engine.current.flush()) throw new Error('笔迹尚未交给本地存储，请保留页面并导出');
    await writeTail.current;
    if (writeError.current) throw writeError.current;
  }
  const actions = useRef({ update, flush }); actions.current = { update, flush };
  useEffect(() => {
    alive.current = true;
    const unregister = registerNotes({ owner, email: app.session.user.email, flush: () => actions.current.flush(), freeze: () => { engine.current?.flush(); frozen.current = true; engine.current?.configure({ enabled: false }); }, snapshot: () => current.current });
    const unload = (event: BeforeUnloadEvent) => { engine.current?.flush(); if (current.current?.pending || writeError.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { alive.current = false; window.dispatchEvent(new Event('feedink:annotation-context-retired')); unregister(); window.removeEventListener('beforeunload', unload); engine.current?.destroy(); engine.current = null; };
  }, []);
  async function load(contentHash?: string) {
    if (loading) return;
    setLoading(true); setError('');
    try {
      await flush(); assertAuthEpoch(epoch);
      let document: AnnotationDocument;
      const localDocuments = (await app.store.annotationDocuments(owner)).filter(item => item.document.context.articleId === article.id && item.document.context.mode === mode);
      assertAuthEpoch(epoch);
      if (app.online) {
        try { document = await fetchAnnotations(article.id, mode, contentHash); }
        catch (reason) {
          const local = contentHash && localDocuments.find(item => item.document.contentHash === contentHash);
          if (!(reason instanceof HttpError) || reason.status !== 404 || !local) throw reason;
          document = local.document;
        }
      } else {
        const cached = localDocuments.filter(item => !contentHash || item.document.contentHash === contentHash);
        const latest = cached.sort((a, b) => (b.document.updatedAt || '').localeCompare(a.document.updatedAt || ''))[0];
        if (!latest) throw new Error('此正文上下文尚未在线验证。请联网打开批注后再离线书写。');
        document = latest.document;
      }
      assertAuthEpoch(epoch); if (!alive.current) return;
      assertContext(document, { articleId: article.id, mode, sourceUrl: article.url, contentHash });
      const local = await app.store.annotations(owner, document.context); assertAuthEpoch(epoch); if (!alive.current) return;
      let next: StoredAnnotations = local?.pending ? local : { document, pending: false, localVersion: crypto.randomUUID() };
      if (local?.pending && app.online && local.document.revision !== document.revision) next = { ...local, conflict: document };
      await app.store.putAnnotations(owner, next, local?.localVersion ?? null); assertAuthEpoch(epoch); if (!alive.current) return;
      engine.current?.destroy(); engine.current = null; setTool('text'); setEditor(null);
      storedVersion.current = next.localVersion; present(next); setStatus(pendingLabel(next)); setHistorical(!!contentHash || !app.online); setVersions([...new Map([...(document.versions || []), ...localDocuments.map(item => ({ contentHash: item.document.contentHash, revision: item.document.revision, updatedAt: item.document.updatedAt || '', markCount: item.document.marks.length, strokeCount: item.document.ink?.strokes.length || 0 }))].map(item => [item.contentHash, item])).values()]); setNextVersion(0);
    } catch (reason) { if (alive.current) { setError(errorText(reason)); setStatus('载入失败 · 未启用书写'); } }
    finally { if (alive.current) setLoading(false); }
  }
  const contextKey = row ? annotationKey(row.document.context) : '';
  useEffect(() => {
    if (!row || !root.current || frozen.current) return;
    const reader = root.current;
    // Stable original media identity survives cached data URLs and asset-ID remapping.
    for (const image of reader.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
      const original = article.images.find(item => item.url === image.dataset.asset)?.originalUrl;
      if (original) image.setAttribute('data-webink-snapshot-original-src', JSON.stringify(original));
    }
    let overlay: WebInkOverlay;
    const transport = (message: HostMessage) => {
      if (message.type === 'save') {
        const active = current.current;
        if (!active || annotationKey(active.document.context) !== contextKey || frozen.current) return false;
        if (JSON.stringify(active.document.ink) === JSON.stringify(message.page)) return true;
        return actions.current.update({ ...active.document, ink: message.page });
      }
      if (message.type === 'state') setHistoryState({ undo: message.undo, redo: message.redo });
      if (message.type === 'error') setEngineError(message.message);
      return true;
    };
    try {
      setEngineError('');
      overlay = new WebInkOverlay(window, { readerRoot: reader, documentUrl: row.document.context.sourceUrl, title: row.document.context.title, transport });
      overlay.configure({ enabled: false, attachmentMode: 'smart' });
      overlay.boot({ nativeInput: false });
      overlay.restore(validateAnnotations(row.document).ink);
      engine.current = overlay;
    } catch (reason) { setEngineError(errorText(reason)); return; }
    return () => { window.dispatchEvent(new Event('feedink:annotation-context-retired')); overlay.destroy(); if (engine.current === overlay) engine.current = null; };
  }, [contextKey, html]);
  useEffect(() => { engine.current?.configure({ enabled: open && tool !== 'text' && !loading, tool: tool === 'text' ? 'pen' : tool, color: app.session.settings.theme === 'eink' ? '#000000' : markColors[color], width: tool === 'highlighter' ? Math.max(12, width * 4) : tool === 'eraser' ? Math.max(16, width * 4) : width }); }, [open, tool, color, width, contextKey, loading, app.session.settings.theme]);
  useEffect(() => {
    let active = true;
    for (const image of root.current?.querySelectorAll<HTMLImageElement>('img[data-asset]') || []) {
      const asset = image.dataset.asset!; image.tabIndex = 0; image.setAttribute('role', 'button'); image.setAttribute('aria-label', `放大图片：${image.alt || '文章图片'}`);
      image.onclick = () => onImage(asset); image.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onImage(asset); } };
      image.onerror = () => { image.classList.add('failed-image'); image.title = '图片不可用；可在文末查看状态并重试'; };
      image.onload = () => image.classList.remove('failed-image');
      void app.store.imageSource(owner, asset).then(url => { if (active && url) { image.loading = 'eager'; image.src = url; } }).catch(() => {});
    }
    return () => { active = false; };
  }, [html, owner]);
  async function refreshLocal() {
    const active = current.current; if (!active) return;
    await writeTail.current;
    const saved = await app.store.annotations(owner, active.document.context); assertAuthEpoch(epoch);
    if (!alive.current || current.current?.localVersion !== active.localVersion || !saved || saved.localVersion !== storedVersion.current) return;
    present(saved); setStatus(pendingLabel(saved));
  }
  async function sync() {
    if (syncing || frozen.current) return; setSyncing(true); setError('');
    try { if (writeError.current && current.current) persist(current.current); await flush(); await synchronizeAnnotations(app.store, owner, epoch); await refreshLocal(); }
    catch (reason) { if (alive.current) setError(`未同步：${errorText(reason)}。草稿仍保留。`); }
    finally { if (alive.current) setSyncing(false); }
  }
  useEffect(() => {
    if (!row?.pending || row.conflict || !app.online) return;
    const timer = setTimeout(() => void sync(), 1000); return () => clearTimeout(timer);
  }, [row?.localVersion, app.online]);
  useEffect(() => {
    const refreshed = () => { void refreshLocal().catch(() => {}); };
    window.addEventListener('feedink:annotations-synced', refreshed);
    return () => window.removeEventListener('feedink:annotations-synced', refreshed);
  }, []);
  function addMark(kind: TextMarkKind) {
    const document = current.current?.document; if (!document || !root.current) return;
    try {
      const selection = window.getSelection();
      const anchor = kind === 'note' && (!selection || selection.isCollapsed) ? null : captureQuote(root.current);
      const mark: TextAnnotation = { id: crypto.randomUUID(), kind, color, anchor, text: '', createdAt: Date.now(), updatedAt: Date.now() };
      if (update({ ...document, marks: [...document.marks, mark] })) { setEditor(mark.id); window.getSelection()?.removeAllRanges(); }
    } catch (reason) { setError(errorText(reason)); }
  }
  function editMark(id: string, patch: Partial<Pick<TextAnnotation, 'text' | 'kind' | 'color'>>) {
    const document = current.current?.document; if (document) update({ ...document, marks: document.marks.map(mark => mark.id === id ? { ...mark, ...patch, updatedAt: Date.now() } : mark) });
  }
  const editing = row?.document.marks.find(mark => mark.id === editor);
  async function resolveConflict(useLocal: boolean) {
    const active = current.current; if (!active?.conflict) return;
    if (!confirm(useLocal ? '用当前本地草稿覆盖此服务器版本？请先导出服务器版本以保留另一份修改。' : '放弃本地草稿并使用服务器版本？请先导出 JSON。')) return;
    await flush();
    const next: StoredAnnotations = { document: useLocal ? { ...active.document, revision: active.conflict.revision, id: active.conflict.id } : active.conflict, pending: useLocal, localVersion: crypto.randomUUID() };
    await app.store.putAnnotations(owner, next, storedVersion.current); assertAuthEpoch(epoch);
    storedVersion.current = next.localVersion; present(next); engine.current?.restore(next.document.ink); setStatus(pendingLabel(next)); setError('');
  }
  function exportSnapshot() {
    const active = current.current; if (!active) throw new Error('笔记尚未载入');
    // snapshot() is raw data; never use exportSnapshot() render projections here.
    return validateAnnotations({ ...active.document, ink: engine.current ? engine.current.snapshot() : active.document.ink });
  }
  async function importJson(file: File) {
    await flush(); const active = current.current; if (!active) return;
    if (active.pending) throw new Error('请先同步或明确处理当前草稿，导入不会覆盖未同步笔记');
    if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MiB');
    const backup = JSON.parse(await file.text()); assertAuthEpoch(epoch);
    if (backup.format !== 'feedink-notes' || backup.version !== 1 || backup.source?.url !== active.document.context.sourceUrl || backup.source?.mode !== mode || backup.source?.contentHash !== active.document.contentHash) throw new Error('备份不属于此文章正文版本');
    validateAnnotations({ ...active.document, ink: backup.ink, marks: backup.marks });
    if (!confirm('导入会替换此正文版本的服务器笔记，是否继续？')) return;
    const result = await api<AnnotationDocument>(annotationPath(active.document.context).replace('/annotations?', '/annotations/import?'), { method: 'POST', headers: { 'If-Match': `"${active.document.revision}"` }, body: JSON.stringify(backup) });
    assertAuthEpoch(epoch); assertContext(result, active.document.context);
    if (!alive.current || current.current?.localVersion !== active.localVersion) throw new Error('上下文已变更，请重新载入导入结果');
    await load(result.contentHash);
  }
  return <section className="annotation-section">
    <div className="annotation-heading"><button type="button" className="secondary" data-testid="annotation-toggle" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!row && !loading) void load(); }}>批注与笔记</button><span role="status" data-testid="annotation-status">{status}</span></div>
    {open && <aside className="annotations-panel" data-testid="annotations-panel" aria-label="批注与笔记">
      <div className="annotation-toolbar" data-testid="annotation-toolbar" role="toolbar" aria-label="批注工具">
        <button aria-pressed={tool === 'text'} onClick={() => setTool('text')}>选择文字</button>
        {(['highlight', 'underline', 'wave', 'note'] as TextMarkKind[]).map(kind => <button key={kind} disabled={!row || loading} onPointerDown={event => event.preventDefault()} onClick={() => addMark(kind)}>{markLabels[kind]}</button>)}
        {([['pen', '钢笔'], ['highlighter', '荧光笔'], ['eraser', '橡皮']] as const).map(([key, label]) => <button key={key} disabled={!row || loading} aria-pressed={tool === key} onClick={() => setTool(key)}>{label}</button>)}
        <button disabled={!historyState.undo || loading} onClick={() => engine.current?.undo()}>撤销笔迹</button><button disabled={!historyState.redo || loading} onClick={() => engine.current?.redo()}>重做笔迹</button>
        <label>颜色<select aria-label="批注颜色" value={color} onChange={event => setColor(event.target.value as MarkColor)}>{Object.keys(markColors).map(value => <option key={value} value={value}>{({ yellow: '黄色', green: '绿色', blue: '蓝色', lilac: '淡紫' } as Record<string, string>)[value]}</option>)}</select></label>
        <label>笔宽<input aria-label="笔宽" type="range" min="1" max="12" value={width} onChange={event => setWidth(Number(event.target.value))} /></label>
      </div>
      <p className="muted small">先选择正文文字再添加标记；无选区可添加整篇备注。手写使用浏览器触控笔压力，手指用于滚动。笔迹采用保守定位，不确定的锚点不猜测位置。</p>
      {error && <p role="alert">{error}</p>}{Boolean(writeError.current) && row && <button onClick={() => { if (confirm('请先导出 JSON。本操作放弃此标签页尚未写入的草稿，重新载入本机 / 服务器版本。')) { engine.current?.destroy(); engine.current = null; writeTail.current = Promise.resolve(); writeError.current = null; void load(row.document.contentHash); } }}>放弃此页草稿并重新载入</button>}{engineError && <p role="status">笔迹提示：{engineError} · 未定位数据仍在 JSON / 打印报告中保留。</p>}
      {row && <><div className="button-row"><button className="secondary" disabled={syncing || loading || !app.online} onClick={() => void sync()}>{syncing ? '正在同步…' : '重试同步'}</button><button onClick={() => void app.task(async () => { exportNotesJson(exportSnapshot()); })}>导出 JSON</button><button disabled={!app.online || row.pending} onClick={() => void app.task(() => exportNotesMarkdown(row.document))}>导出 Markdown</button><button onClick={() => void app.task(async () => { printNotes(exportSnapshot()); })}>打印 / PDF</button><label className="secondary">导入笔记 JSON<input aria-label="导入笔记 JSON" type="file" accept="application/json,.json" disabled={!app.online || loading || row.pending} onChange={event => { const file = event.target.files?.[0]; if (file) void app.task(() => importJson(file)); event.target.value = ''; }} /></label></div>
        <p className="muted small">JSON 保存全部原始笔记，可恢复到匹配的文章存档。Markdown 使用服务器当次快照（可能包含其他设备的新修改）；打印是含引用、备注和笔迹组的展示报告，不是备份。{row.pending && ' 当前有本地草稿，Markdown 暂不可用。'}</p>
        {row.conflict && <section className="annotation-conflict" role="alert"><h3>版本冲突 · 未覆盖任何一方</h3><p>本地基线 {row.document.revision}，服务器修订 {row.conflict.revision}。请比较并导出后明确选择。</p><button onClick={() => exportNotesJson(row.document)}>导出本地版本</button><button onClick={() => exportNotesJson(row.conflict!)}>导出服务器冲突版本</button><button onClick={() => void app.task(() => resolveConflict(false))}>使用服务器版本</button><button onClick={() => void app.task(() => resolveConflict(true))}>保留本地版本</button></section>}
        <details><summary>正文版本 {historical ? '· 正在查看历史 / 离线快照' : '· 当前正文'}</summary><p className="hash">{row.document.contentHash}</p><button disabled={!app.online || loading} onClick={() => void load()}>返回最新正文版本</button>{versions.map(version => <button key={version.contentHash} disabled={loading} onClick={() => void load(version.contentHash)}>{version.contentHash.slice(0, 12)} · {version.markCount} 标记 / {version.strokeCount} 笔 · 修订 {version.revision}</button>)}<button disabled={!app.online || nextVersion === null} onClick={() => void app.task(async () => { const page = await api<{ items: AnnotationVersion[]; nextOffset: number | null }>(`/articles/${article.id}/annotation-versions?mode=${mode}&offset=${nextVersion}&limit=20`); assertAuthEpoch(epoch); if (!alive.current) return; setVersions(old => [...new Map([...old, ...page.items].map(item => [item.contentHash, item])).values()]); setNextVersion(page.nextOffset); })}>加载更多版本</button></details>
        <h3>文字批注（{row.document.marks.length}） · 手写 {row.document.ink?.strokes.length || 0} 笔</h3>
        <ol className="annotation-list">{row.document.marks.map(mark => <li key={mark.id}><button className="annotation-list-item" onClick={() => setEditor(mark.id)}><strong>{markLabels[mark.kind]}</strong>{mark.anchor && <blockquote>{mark.anchor.exact}</blockquote>}{mark.text && <p>{mark.text}</p>}{!mark.anchor && <small>整篇备注</small>}</button><button aria-label={`删除${markLabels[mark.kind]}`} onClick={() => { if (confirm('删除这条批注？')) update({ ...row.document, marks: row.document.marks.filter(item => item.id !== mark.id) }); }}>删除</button></li>)}</ol>
        {editing && <section className="note-editor" aria-label="备注编辑器"><h3>编辑{markLabels[editing.kind]}</h3>{editing.anchor && <blockquote>{editing.anchor.exact}</blockquote>}<label>备注内容（纯文本）<textarea data-testid="note-editor" aria-label="备注内容" disabled={loading} maxLength={32768} rows={4} value={editing.text} onChange={event => editMark(editing.id, { text: event.target.value })} /></label><label>标记颜色<select value={editing.color} onChange={event => editMark(editing.id, { color: event.target.value as MarkColor })}>{Object.keys(markColors).map(value => <option key={value} value={value}>{value}</option>)}</select></label><button onClick={() => void app.task(async () => { await flush(); setEditor(null); if (app.online) await sync(); })}>保存备注</button><small>输入会立即写入本机草稿；“服务器已确认”才表示跨设备保存。</small></section>}
      </>}
      {!row && <button disabled={loading} onClick={() => void load()}>{loading ? '正在验证批注上下文…' : '重新载入批注'}</button>}
    </aside>}
    {historical && row && <p className="notice">正在显示笔记所属的正文快照；不会替换文章最新存档。</p>}
    <div className="annotation-page">
      <div className="article-content" data-testid="reader-content" data-reader-root="" ref={root} data-annotation-context={row?.document.contentHash} data-article-key={row?.document.contentHash} dangerouslySetInnerHTML={{ __html: html }} onClick={event => { if (tool === 'text' && !window.getSelection()?.toString() && !(event.target as HTMLElement).closest('a,img,button,summary,pre,code')) onTap(); }} />
      {row && <TextMarkPresentation root={root} marks={row.document.marks} html={html} />}
    </div>
  </section>;
}

function TextMarkPresentation({ root, marks, html }: { root: React.RefObject<HTMLDivElement | null>; marks: TextAnnotation[]; html: string }) {
  const [rects, setRects] = useState<Array<{ key: string; x: number; y: number; width: number; height: number; kind: TextMarkKind; color: MarkColor }>>([]), [unlocated, setUnlocated] = useState(0);
  useEffect(() => {
    let frame = 0;
    const paint = () => {
      frame = 0; const element = root.current; if (!element) return;
      const output: typeof rects = []; let missing = 0;
      try {
        const stream = quoteStream(element), box = element.getBoundingClientRect(), budget = { left: 8388608 }; let rawRects = 0;
        for (const mark of marks) {
          if (!mark.anchor) continue;
          const found = matchQuote(stream.value, mark.anchor, budget);
          if (found.status !== 'located') { missing++; continue; }
          try {
            const range = quoteRange(stream, found.start, found.end);
            // Inline rectangles cannot prove clipping/rotated writing geometry. Retain
            // these marks in the quote list instead of guessing a current placement.
            for (const entry of stream.nodes) if (entry.end > found.start && entry.start < found.end) {
              for (let parent = entry.node.parentElement; parent && parent !== element; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (style.transform !== 'none' || style.writingMode !== 'horizontal-tb' || /auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) throw new Error('Unsupported text geometry');
              }
            }
            const ranges = range.getClientRects(); rawRects += ranges.length;
            if (ranges.length > 256 || rawRects > 4096) { missing++; continue; }
            let painted = false;
            for (let i = 0; i < ranges.length; i++) { const r = ranges[i]; if (r.width > 0 && r.height > 0 && [r.x, r.y, r.width, r.height].every(Number.isFinite)) { output.push({ key: `${mark.id}:${i}`, x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height, kind: mark.kind, color: mark.color }); painted = true; } }
            if (!painted) missing++;
          } catch { missing++; }
        }
      } catch { missing = marks.filter(mark => mark.anchor).length; }
      setRects(output); setUnlocated(missing);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const resize = new ResizeObserver(schedule); if (root.current) resize.observe(root.current);
    window.addEventListener('resize', schedule); root.current?.addEventListener('load', schedule, true); root.current?.addEventListener('toggle', schedule, true); document.fonts?.addEventListener('loadingdone', schedule); schedule();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('resize', schedule); root.current?.removeEventListener('load', schedule, true); root.current?.removeEventListener('toggle', schedule, true); document.fonts?.removeEventListener('loadingdone', schedule); };
  }, [marks, html]);
  return <><div className="text-mark-presentation" aria-hidden="true">{rects.map(r => <span key={r.key} className={`text-mark text-mark-${r.kind}`} style={{ left: r.x, top: r.y, width: r.width, height: r.height, '--mark-color': markColors[r.color] } as React.CSSProperties} />)}</div>{unlocated > 0 && <p className="annotation-unlocated" role="status">{unlocated} 条引用暂未定位；完整引用与备注仍在笔记列表和导出中。</p>}</>;
}
