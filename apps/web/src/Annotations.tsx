import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NotebookPen, PenLine, X, Undo2, Redo2 } from 'lucide-react';
import { AnnotationFloat } from './AnnotationFloat';
import './annotation-ui.css';
import type { AnnotationDocument, AnnotationMode, AnnotationVersion, ArticleDetail, MarkColor, TextAnnotation, TextMarkKind, TextQuoteAnchor } from '@feedink/shared';
import { WebInkOverlay } from '@feedink/ink/overlay';
import type { HostMessage, Tool } from '@feedink/ink/types';
import { useApp } from './context';
import { api, HttpError } from './api';
import { assertAuthEpoch, authEpoch, withAuthNetworkLock } from './authEpoch';
import { withOwnerLock } from './stateSync';
import { annotationKey, assertContext, markColors, markLabels, sameAnnotationPayload, validateAnnotations, type StoredAnnotations } from './annotationData';
import { annotationPath, fetchAnnotations, registerNotes, synchronizeAnnotations } from './annotationSync';
import { exportNotesJson, exportNotesMarkdown, printNotes } from './annotationExport';
import { captureQuote, matchQuote, quoteRange, quoteStream } from './textAnchors';
import { sanitizeArticle } from './safety';

const errorText = (error: unknown) => error instanceof Error ? error.message : '批注操作失败';
interface AnnotatedArticleProps { article: ArticleDetail; mode: AnnotationMode; onImage: (url: string) => void; onTap: () => void; toolbarHost?: HTMLElement | null }
export function AnnotatedArticle(props: AnnotatedArticleProps) {
  const app = useApp();
  return <AnnotationSession key={`${app.session.user.id}:${props.article.id}:${props.mode}:${props.mode === 'fulltext' ? props.article.fulltextHtml : props.article.contentHtml}`} {...props} />;
}
function AnnotationSession({ article, mode, onImage, onTap, toolbarHost }: AnnotatedArticleProps) {
  const app = useApp(), owner = app.session.user.id;
  const [epoch] = useState(authEpoch);
  const root = useRef<HTMLDivElement>(null), engine = useRef<WebInkOverlay | null>(null);
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [row, setRow] = useState<StoredAnnotations | null>(null);
  const current = useRef<StoredAnnotations | null>(null), storedVersion = useRef<string | null>(null);
  const writeTail = useRef<Promise<void>>(Promise.resolve()), writeError = useRef<unknown>(null), frozen = useRef(false), alive = useRef(true);
  const [status, setStatus] = useState('正在验证批注上下文…'), [error, setError] = useState(''), [engineError, setEngineError] = useState('');
  const [tool, setTool] = useState<Tool | 'text'>('text'), [color, setColor] = useState<MarkColor>('yellow'), [width, setWidth] = useState(3);
  const [historyState, setHistoryState] = useState({ undo: false, redo: false }), [editor, setEditor] = useState<string | null>(null);
  const [versions, setVersions] = useState<AnnotationVersion[]>([]), [nextVersion, setNextVersion] = useState<number | null>(0);
  const [historical, setHistorical] = useState(false), [syncing, setSyncing] = useState(false);
  const pauses = useRef(0), syncBusy = useRef(false), syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paused, setPaused] = useState(false), [loadGeneration, setLoadGeneration] = useState(0), [syncAgain, setSyncAgain] = useState(0);
  const [configurationGeneration, setConfigurationGeneration] = useState(0);
  const [inkOpen, setInkOpen] = useState(false);
  const [selection, setSelection] = useState<{ anchor: TextQuoteAnchor; range: Range } | null>(null);
  const [editorRange, setEditorRange] = useState<Range | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null), selectionRef = useRef(selection); selectionRef.current = selection;
  const readOnly = loading || paused;
  const closeEditor = () => { setEditor(null); const target = returnFocus.current?.isConnected ? returnFocus.current : root.current; target?.focus({ preventScroll: true }); };
  const closeDrawer = () => { setOpen(false); toolbarHost?.querySelector<HTMLButtonElement>('[data-testid=annotation-toggle]')?.focus({ preventScroll: true }); };
  const closeSelection = () => { setSelection(null); window.getSelection()?.removeAllRanges(); };
  const closeInk = () => { engine.current?.flush(); setInkOpen(false); setTool('text'); toolbarHost?.querySelector<HTMLButtonElement>('[data-testid=ink-toggle]')?.focus({ preventScroll: true }); };
  function openEditor(id: string, range: Range | null = null) { returnFocus.current = document.activeElement as HTMLElement; setEditorRange(range); setSelection(null); setInkOpen(false); setTool('text'); setEditor(id); }

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
    if (frozen.current || pauses.current || !current.current) return false;
    try {
      const next = { ...current.current, document: validateAnnotations(document), pending: true, localVersion: crypto.randomUUID() };
      present(next); setStatus('未保存 · 正在写入本机'); setError(''); persist(next); return true;
    } catch (reason) { setError(errorText(reason)); return false; }
  }
  async function flush() {
    if (engine.current && !engine.current.flush()) throw new Error('笔迹尚未交给本地存储，请保留页面并导出');
    let tail: Promise<void>;
    do { tail = writeTail.current; await tail; } while (tail !== writeTail.current);
    if (writeError.current) throw writeError.current;
  }
  function pause() {
    // Capture accepted engine input before rejecting any further edits.
    engine.current?.flush(); pauses.current++; setPaused(true); engine.current?.configure({ enabled: false });
    return () => {
      pauses.current--;
      if (alive.current) {
        setPaused(pauses.current > 0);
        // React may batch false → true → false when a retirement rejects immediately.
        if (!pauses.current) setConfigurationGeneration(value => value + 1);
      }
    };
  }
  const actions = useRef({ update, flush, pause }); actions.current = { update, flush, pause };
  useEffect(() => {
    alive.current = true;
    const unregister = registerNotes({ owner, email: app.session.user.email, flush: () => actions.current.flush(), pause: () => actions.current.pause(), freeze: () => { engine.current?.flush(); frozen.current = true; engine.current?.configure({ enabled: false }); }, snapshot: () => current.current });
    const unload = (event: BeforeUnloadEvent) => { engine.current?.flush(); if (current.current?.pending || writeError.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { alive.current = false; window.dispatchEvent(new Event('feedink:annotation-context-retired')); unregister(); window.removeEventListener('beforeunload', unload); engine.current?.destroy(); engine.current = null; };
  }, []);
  async function load(contentHash?: string) {
    if (loading || pauses.current || frozen.current) return;
    const resume = pause();
    setLoading(true); setError('');
    try {
      await flush(); assertAuthEpoch(epoch);
      // A context reload must not mistake our own in-flight save for a remote conflict.
      await withAuthNetworkLock(() => withOwnerLock(app.store, owner, async check => {
      await check(); assertAuthEpoch(epoch);
      let document: AnnotationDocument, cachedHistory: StoredAnnotations | undefined;
      const localDocuments = (await app.store.annotationDocuments(owner)).filter(item => item.document.context.articleId === article.id && item.document.context.mode === mode);
      assertAuthEpoch(epoch);
      if (app.online) {
        try { document = await fetchAnnotations(article.id, mode, contentHash); }
        catch (reason) {
          const local = contentHash && localDocuments.find(item => item.document.contentHash === contentHash);
          if (!(reason instanceof HttpError) || !(reason.status === 404 || reason.status === 409 && reason.code === 'ANNOTATION_CONTEXT') || !local) throw reason;
          assertContext(local.document, { articleId: article.id, mode, sourceUrl: article.url, contentHash });
          cachedHistory = local; document = local.document;
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
      let next: StoredAnnotations = cachedHistory ? local || cachedHistory : local?.pending ? local : { document, pending: false, localVersion: crypto.randomUUID() };
      if (!cachedHistory && local?.pending && app.online && local.document.revision !== document.revision) {
        next = !local.conflict && document.revision > local.document.revision && sameAnnotationPayload(local.document, document)
          ? { document, pending: false, localVersion: local.localVersion }
          : { ...local, conflict: document };
      }
      await check(); assertAuthEpoch(epoch);
      await app.store.putAnnotations(owner, next, local?.localVersion ?? null); assertAuthEpoch(epoch); if (!alive.current) return;
      setLoadGeneration(value => value + 1); setTool('text'); setInkOpen(false); setEditor(null); setSelection(null);
      storedVersion.current = next.localVersion; present(next); setStatus(`${cachedHistory ? '本机历史快照 · ' : ''}${pendingLabel(next)}`); setHistorical(!!contentHash || !app.online); setVersions([...new Map([...(document.versions || []), ...localDocuments.map(item => ({ contentHash: item.document.contentHash, revision: item.document.revision, updatedAt: item.document.updatedAt || '', markCount: item.document.marks.length, strokeCount: item.document.ink?.strokes.length || 0 }))].map(item => [item.contentHash, item])).values()]); setNextVersion(0);
      }));
    } catch (reason) { if (alive.current) { setError(errorText(reason)); setStatus('载入失败 · 未启用书写'); } }
    finally { resume(); if (alive.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
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
      overlay = new WebInkOverlay(window, { readerRoot: reader, paintHost: reader.closest<HTMLElement>('.app-shell') || undefined, clipRoot: reader.closest<HTMLElement>('.reader-scroll') || undefined, documentUrl: row.document.context.sourceUrl, title: row.document.context.title, transport });
      overlay.configure({ enabled: false, attachmentMode: 'smart' });
      overlay.boot({ nativeInput: false });
      overlay.restore(validateAnnotations(row.document).ink);
      engine.current = overlay;
    } catch (reason) { setEngineError(errorText(reason)); return; }
    return () => { window.dispatchEvent(new Event('feedink:annotation-context-retired')); overlay.destroy(); if (engine.current === overlay) engine.current = null; };
  }, [contextKey, html, loadGeneration]);
  useEffect(() => { engine.current?.configure({ enabled: inkOpen && tool !== 'text' && !readOnly && !frozen.current && !pauses.current, tool: tool === 'text' ? 'pen' : tool, color: app.session.settings.theme === 'eink' ? '#000000' : markColors[color], width: tool === 'highlighter' ? Math.max(12, width * 4) : tool === 'eraser' ? Math.max(16, width * 4) : width }); }, [inkOpen, tool, color, width, contextKey, html, loadGeneration, configurationGeneration, readOnly, app.session.settings.theme]);
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
    if (syncBusy.current || frozen.current || pauses.current) return;
    // A manual save consumes the pending debounce too; a failed pass must not retry itself.
    if (syncTimer.current !== null) { clearTimeout(syncTimer.current); syncTimer.current = null; }
    syncBusy.current = true; setSyncing(true); setError('');
    try {
      if (writeError.current && current.current) persist(current.current);
      await flush();
      if (!app.online) return;
      const sentVersion = current.current?.localVersion;
      await synchronizeAnnotations(app.store, owner, epoch); await refreshLocal();
      // Only successful passes can re-arm a debounce consumed by an in-flight save.
      if (alive.current && current.current?.pending && !current.current.conflict && current.current.localVersion !== sentVersion) setSyncAgain(value => value + 1);
    }
    catch (reason) { if (alive.current) setError(`未同步：${errorText(reason)}。草稿仍保留。`); }
    finally { syncBusy.current = false; if (alive.current) setSyncing(false); }
  }
  useEffect(() => {
    if (!row?.pending || row.conflict || !app.online || readOnly) return;
    const timer = setTimeout(() => { syncTimer.current = null; void sync(); }, 1000);
    syncTimer.current = timer;
    return () => { clearTimeout(timer); if (syncTimer.current === timer) syncTimer.current = null; };
  }, [row?.localVersion, app.online, syncAgain, readOnly]);
  useEffect(() => {
    const refreshed = () => { void refreshLocal().catch(() => {}); };
    window.addEventListener('feedink:annotations-synced', refreshed);
    return () => window.removeEventListener('feedink:annotations-synced', refreshed);
  }, []);
  useEffect(() => {
    const capture = () => {
      if (document.activeElement?.closest('[data-annotation-ui]') && selectionRef.current) return;
      if (inkOpen || editor || !current.current || readOnly) { setSelection(null); return; }
      try {
        if (!root.current) return;
        const anchor = captureQuote(root.current), range = window.getSelection()!.getRangeAt(0).cloneRange();
        setSelection({ anchor, range }); setOpen(false);
      } catch { setSelection(null); }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-annotation-ui]')) setSelection(null);
      // Navigation retirement may reject; closing UI never discards its protected draft.
      if (editor && !event.target.closest('.annotation-editor')) setEditor(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (selectionRef.current || editor || inkOpen || open)) { event.preventDefault(); event.stopPropagation(); if (editor) closeEditor(); else if (inkOpen) closeInk(); else if (open) closeDrawer(); else closeSelection(); }
      if (event.altKey && event.key === 'Enter' && selectionRef.current) { event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-testid=selection-annotation-toolbar] button')?.focus({ preventScroll: true }); }
    };
    document.addEventListener('selectionchange', capture); document.addEventListener('pointerup', capture); document.addEventListener('keyup', capture);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard);
    capture();
    return () => { document.removeEventListener('selectionchange', capture); document.removeEventListener('pointerup', capture); document.removeEventListener('keyup', capture); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard); };
  }, [inkOpen, editor, open, readOnly, contextKey]);
  function addMark(kind: TextMarkKind, wholeArticle = false) {
    const document = current.current?.document; if (!document || !root.current) return;
    const captured = selectionRef.current;
    if (!wholeArticle && !captured) return;
    const mark: TextAnnotation = { id: crypto.randomUUID(), kind, color, anchor: wholeArticle ? null : captured!.anchor, text: '', createdAt: Date.now(), updatedAt: Date.now() };
    if (update({ ...document, marks: [...document.marks, mark] })) {
      setSelection(null); window.getSelection()?.removeAllRanges();
      if (kind === 'note') openEditor(mark.id, wholeArticle ? null : captured!.range);
    }
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
    const result = await api<AnnotationDocument>(`/articles/${encodeURIComponent(active.document.context.articleId)}/annotations/import`, { method: 'POST', headers: { 'If-Match': `"${active.document.revision}"` }, body: JSON.stringify(backup) });
    assertAuthEpoch(epoch); assertContext(result, active.document.context);
    if (!alive.current || current.current?.localVersion !== active.localVersion) throw new Error('上下文已变更，请重新载入导入结果');
    await load(result.contentHash);
  }
  const toolbar = <span className="annotation-entry" data-pending={Boolean(row?.pending || error || engineError) || undefined} data-annotation-ui="">
    <button type="button" className="icon-button" data-testid="annotation-toggle" aria-label="批注与笔记" title="批注与笔记" aria-expanded={open} onClick={() => { window.getSelection()?.removeAllRanges(); setSelection(null); setEditor(null); setInkOpen(false); setTool('text'); setOpen(value => !value); if (!row && !loading) void load(); }}><NotebookPen size={18} /></button>
    <button type="button" className="icon-button" data-testid="ink-toggle" aria-label="手写批注" title="手写批注" aria-pressed={inkOpen} disabled={!row || readOnly} onClick={() => { if (inkOpen) closeInk(); else { window.getSelection()?.removeAllRanges(); setSelection(null); setEditor(null); setOpen(false); setInkOpen(true); setTool('pen'); } }}><PenLine size={18} /></button>
  </span>;
  const colors = <select aria-label="批注颜色" value={color} onChange={event => setColor(event.target.value as MarkColor)}>{Object.keys(markColors).map(value => <option key={value} value={value}>{({ yellow: '黄色', green: '绿色', blue: '蓝色', lilac: '淡紫' } as Record<string, string>)[value]}</option>)}</select>;
  return <section className="annotation-section">
    {toolbarHost ? createPortal(toolbar, toolbarHost) : root.current?.closest('.app-shell') && createPortal(<div className="annotation-entry-fallback">{toolbar}</div>, root.current.closest('.app-shell')!)}
    {Boolean(writeError.current || row?.pending && error || row?.conflict) && !open && !editor && <AnnotationFloat root={root} kind="notice" label="笔记保存状态" onClose={() => setOpen(true)}><div role="alert"><strong>{writeError.current ? '笔记未保存' : row?.conflict ? '笔记有冲突' : '笔记待同步'}</strong> <button onClick={() => { closeInk(); setOpen(true); }}>查看恢复选项</button></div></AnnotationFloat>}
    {!open && <span className="annotation-sr-status" role="status" data-testid="annotation-status">{status}{error && ` · ${error}`}</span>}
    {selection && !editor && !inkOpen && <AnnotationFloat root={root} anchor={selection.range} kind="selection" label="选中文字批注" testId="selection-annotation-toolbar" onClose={closeSelection} onInvisible={() => setSelection(null)}>
      {(['highlight', 'underline', 'wave', 'note'] as TextMarkKind[]).map(kind => <button key={kind} disabled={readOnly} onPointerDown={event => event.preventDefault()} onClick={() => addMark(kind)}>{markLabels[kind]}</button>)}
      <details className="annotation-options"><summary aria-label="文字批注颜色">颜色</summary>{colors}</details>
      <button aria-label="关闭文字批注工具" onClick={closeSelection}><X size={16} /></button>
    </AnnotationFloat>}
    {inkOpen && <AnnotationFloat root={root} kind="ink" label="手写工具" testId="annotation-toolbar" onClose={closeInk}>
      {([['pen', '钢笔'], ['highlighter', '荧光笔'], ['eraser', '橡皮']] as const).map(([key, label]) => <button key={key} disabled={!row || readOnly} aria-pressed={tool === key} onClick={() => setTool(key)}>{label}</button>)}
      <button aria-label="撤销笔迹" title="撤销笔迹" disabled={!historyState.undo || readOnly} onClick={() => engine.current?.undo()}><Undo2 size={17} /></button><button aria-label="重做笔迹" title="重做笔迹" disabled={!historyState.redo || readOnly} onClick={() => engine.current?.redo()}><Redo2 size={17} /></button>
      <details className="annotation-options"><summary>选项</summary><label>颜色{colors}</label><label>笔宽<input aria-label="笔宽" type="range" min="1" max="12" value={width} onChange={event => setWidth(Number(event.target.value))} /></label></details>
      <button aria-label="退出手写" onClick={closeInk}><X size={17} /></button>
      {engineError && <small role="status">{engineError} · 未定位数据仍保留</small>}
    </AnnotationFloat>}
    {open && <AnnotationFloat root={root} kind="drawer" label="批注与笔记" onClose={closeDrawer}>
    <aside className="annotations-panel" data-testid="annotations-panel" aria-label="批注与笔记" inert={paused || undefined}>
      <header className="annotation-drawer-header"><h2>批注与笔记</h2><button aria-label="关闭批注与笔记" onClick={closeDrawer}><X size={18} /></button></header>
      <p role="status" data-testid="annotation-status">{status}</p>
      <button disabled={!row || readOnly} onClick={() => addMark('note', true)}>整篇备注</button>
      {error && <p role="alert">{error}</p>}{Boolean(writeError.current) && row && <button onClick={() => { if (confirm('请先导出 JSON。本操作放弃此标签页尚未写入的草稿，重新载入本机 / 服务器版本。')) { engine.current?.destroy(); engine.current = null; writeTail.current = Promise.resolve(); writeError.current = null; void load(row.document.contentHash); } }}>放弃此页草稿并重新载入</button>}{engineError && <p role="status">笔迹提示：{engineError} · 未定位数据仍在 JSON / 打印报告中保留。</p>}
      {row && <><div className="button-row"><button className="secondary" disabled={syncing || readOnly} onClick={() => void sync()}>{syncing ? '正在同步…' : '重试同步'}</button><button onClick={() => void app.task(async () => { exportNotesJson(exportSnapshot()); })}>导出 JSON</button><button disabled={!app.online || row.pending} onClick={() => void app.task(() => exportNotesMarkdown(row.document))}>导出 Markdown</button><button onClick={() => void app.task(async () => { printNotes(exportSnapshot()); })}>打印 / PDF</button><label className="secondary">导入笔记 JSON<input aria-label="导入笔记 JSON" type="file" accept="application/json,.json" disabled={!app.online || loading || row.pending} onChange={event => { const file = event.target.files?.[0]; if (file) void app.task(() => importJson(file)); event.target.value = ''; }} /></label></div>
        <p className="muted small">JSON 保存全部原始笔记，可恢复到匹配的文章存档。Markdown 使用服务器当次快照（可能包含其他设备的新修改）；打印是含引用、备注和笔迹组的展示报告，不是备份。{row.pending && ' 当前有本地草稿，Markdown 暂不可用。'}</p>
        {row.conflict && <section className="annotation-conflict" role="alert"><h3>版本冲突 · 未覆盖任何一方</h3><p>本地基线 {row.document.revision}，服务器修订 {row.conflict.revision}。请比较并导出后明确选择。</p><button onClick={() => exportNotesJson(row.document)}>导出本地版本</button><button onClick={() => exportNotesJson(row.conflict!)}>导出服务器冲突版本</button><button onClick={() => void app.task(() => resolveConflict(false))}>使用服务器版本</button><button onClick={() => void app.task(() => resolveConflict(true))}>保留本地版本</button></section>}
        <details><summary>正文版本 {historical ? '· 正在查看历史 / 离线快照' : '· 当前正文'}</summary><p className="hash">{row.document.contentHash}</p><button disabled={!app.online || loading} onClick={() => void load()}>返回最新正文版本</button>{versions.map(version => <button key={version.contentHash} disabled={loading} onClick={() => void load(version.contentHash)}>{version.contentHash.slice(0, 12)} · {version.markCount} 标记 / {version.strokeCount} 笔 · 修订 {version.revision}</button>)}<button disabled={!app.online || nextVersion === null} onClick={() => void app.task(async () => { const page = await api<{ items: AnnotationVersion[]; nextOffset: number | null }>(`/articles/${article.id}/annotation-versions?mode=${mode}&offset=${nextVersion}&limit=20`); assertAuthEpoch(epoch); if (!alive.current) return; setVersions(old => [...new Map([...old, ...page.items].map(item => [item.contentHash, item])).values()]); setNextVersion(page.nextOffset); })}>加载更多版本</button></details>
        <h3>文字批注（{row.document.marks.length}） · 手写 {row.document.ink?.strokes.length || 0} 笔</h3>
        <ol className="annotation-list">{row.document.marks.map(mark => <li key={mark.id}><button className="annotation-list-item" onClick={() => openEditor(mark.id)}><strong>{markLabels[mark.kind]}</strong>{mark.anchor && <blockquote>{mark.anchor.exact}</blockquote>}{mark.text && <p>{mark.text}</p>}{!mark.anchor && <small>整篇备注</small>}</button><button aria-label={`删除${markLabels[mark.kind]}`} disabled={readOnly} onClick={() => { if (confirm('删除这条批注？')) update({ ...row.document, marks: row.document.marks.filter(item => item.id !== mark.id) }); }}>删除</button></li>)}</ol>
      </>}
      {!row && <button disabled={loading} onClick={() => void load()}>{loading ? '正在验证批注上下文…' : '重新载入批注'}</button>}
    </aside></AnnotationFloat>}
    {editing && <AnnotationFloat root={root} anchor={editorRange} kind="editor" testId="annotation-note-popover" label="备注编辑器" onClose={closeEditor}><section className="note-editor"><button className="annotation-editor-close" aria-label="关闭备注编辑器" onClick={closeEditor}><X size={17} /></button><h3>编辑{markLabels[editing.kind]}</h3>{editing.anchor && <blockquote>{editing.anchor.exact}</blockquote>}<label>备注内容（纯文本）<textarea data-testid="note-editor" aria-label="备注内容" disabled={readOnly} maxLength={32768} rows={4} value={editing.text} onChange={event => editMark(editing.id, { text: event.target.value })} /></label><label>标记颜色<select disabled={readOnly} value={editing.color} onChange={event => editMark(editing.id, { color: event.target.value as MarkColor })}>{Object.keys(markColors).map(value => <option key={value} value={value}>{value}</option>)}</select></label><button disabled={readOnly} onClick={() => void app.task(async () => { await flush(); closeEditor(); if (app.online) await sync(); })}>保存备注</button><small role="status">{status}</small>{!open && error && <p role="alert">{error}</p>}<small>输入会立即尝试写入本机草稿；“服务器已确认”才表示跨设备保存。</small></section></AnnotationFloat>}
    {historical && row && <p className="notice">正在显示笔记所属的正文快照；不会替换文章最新存档。</p>}
    <div className="annotation-page">
      <div className="article-content" data-testid="reader-content" data-reader-root="" tabIndex={-1} ref={root} data-annotation-context={row?.document.contentHash} data-article-key={row?.document.contentHash} dangerouslySetInnerHTML={{ __html: html }} onClick={event => { if (tool === 'text' && !window.getSelection()?.toString() && !(event.target as HTMLElement).closest('a,img,button,summary,pre,code')) onTap(); }} />
      {row && <TextMarkPresentation root={root} marks={row.document.marks} html={html} onEdit={openEditor} enabled={!inkOpen} />}
    </div>
  </section>;
}

function TextMarkPresentation({ root, marks, html, onEdit, enabled }: { root: React.RefObject<HTMLDivElement | null>; marks: TextAnnotation[]; html: string; onEdit: (id: string, range: Range) => void; enabled: boolean }) {
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
  useEffect(() => {
    const element = root.current; if (!element || !enabled) return;
    const click = (event: MouseEvent) => {
      if (window.getSelection()?.toString() || (event.target as Element).closest('a,img,button')) return;
      try {
        const stream = quoteStream(element), budget = { left: 8388608 };
        for (const mark of marks) {
          if (!mark.anchor) continue;
          const found = matchQuote(stream.value, mark.anchor, budget); if (found.status !== 'located') continue;
          const range = quoteRange(stream, found.start, found.end);
          if (Array.from(range.getClientRects()).some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) { event.preventDefault(); event.stopPropagation(); onEdit(mark.id, range); return; }
        }
      } catch { /* Unresolved marks remain accessible in the drawer. */ }
    };
    element.addEventListener('click', click);
    return () => element.removeEventListener('click', click);
  }, [marks, html, enabled, onEdit, root]);
  return <><div className="text-mark-presentation" aria-hidden="true">{rects.map(r => <span key={r.key} className={`text-mark text-mark-${r.kind}`} style={{ left: r.x, top: r.y, width: r.width, height: r.height, '--mark-color': markColors[r.color] } as React.CSSProperties} />)}</div>{unlocated > 0 && <p className="annotation-unlocated" role="status">{unlocated} 条引用暂未定位；完整引用与备注仍在笔记列表和导出中。</p>}</>;
}
