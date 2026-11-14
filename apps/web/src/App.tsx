import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { DEFAULT_SETTINGS, type ArticleDetail, type ArticleMode, type ArticlePage, type ArticleStatePatch, type ArticleSummary, type FeedPreferences, type ReaderSettings, type Session } from '@feedink/shared';
import { api, HttpError, mutate, setApiSession } from './api';
import { Auth } from './Auth';
import { assertAuthEpoch, authEpoch, beginAuthTransition, ObsoleteSessionError, withAuthNetworkLock } from './authEpoch';
import { ObsoleteMutationError, OwnerMismatchError, queueState, synchronizeState } from './stateSync';
import { AppContext, type AppContextValue } from './context';
import { AssetImage, Empty, Icon, IconButton, Logo, Modal, ResizeHandle, SourceIcon } from './components';
import { articleQuery, formatDate, ownedAssetUrl, ownedImageUrl, progressAt, queryString, safeExternalUrl, shortcutAction } from './logic';
import { adjustCounts, applyState, CacheInvalidatedError, OfflineStore, type Library } from './offline';
import { DiscoveryPanel, OrganizationPanel, SaveUrlPanel, TransferPanel, type OrganizationTarget } from './Panels';
import { Reader } from './Reader';
import { scopedCss } from './safety';
import { SettingsPanel } from './Settings';

const emptyLibrary: Library = { subscriptions: [], folders: [], tags: [] };
const scopeTitles = { all: '全部订阅源', unread: '未读文章', saved: '稍后阅读', archive: '全部存档' };
function message(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }
function isConnectionError(error: unknown) { return error instanceof TypeError || !navigator.onLine; }

export function App() {
  const [store] = useState(() => new OfflineStore());
  const [session, setSession] = useState<Session | null>(null); const sessionRef = useRef<Session | null>(null);
  const [starting, setStarting] = useState(true); const [online, setOnline] = useState(navigator.onLine);
  const [locationKey, setLocationKey] = useState(location.pathname + location.search);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const navigate = useCallback((path: string, replace = false) => { history[replace ? 'replaceState' : 'pushState']({}, '', path); setLocationKey(location.pathname + location.search); }, []);
  const commitSession = useCallback((value: Session | null, epoch: number) => { assertAuthEpoch(epoch); sessionRef.current = value; setApiSession(value, epoch); setSession(value); }, []);
  const task = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => { try { return await action(); } catch (error) { if (error instanceof ObsoleteSessionError || error instanceof ObsoleteMutationError) return; if (isConnectionError(error)) setOnline(false); notify(message(error), true); return undefined; } }, [notify]);
  const logoutInFlight = useRef(false);
  async function purge(epoch = authEpoch(), owner?: string) {
    localStorage.setItem('feedink-private-purge-pending', '1');
    try { await store.clear(() => assertAuthEpoch(epoch), owner); assertAuthEpoch(epoch); localStorage.removeItem('feedink-private-purge-pending'); }
    catch (error) { if (!(error instanceof ObsoleteSessionError)) notify(`本地数据清理失败：${message(error)}。请在浏览器中清除此网站数据。`, true); }
  }
  async function invalidate(reason = '登录已失效，请重新登录') {
    const owner = sessionRef.current?.user.id;
    const epoch = beginAuthTransition(); commitSession(null, epoch); localStorage.setItem('feedink-logout-pending', '1');
    channelRef.current?.postMessage({ type: 'logout' }); navigate('/login', true); notify(reason, true); await purge(epoch, owner);
  }
  async function login(value: Session) {
    const epoch = authEpoch();
    try { await store.activate(value, () => assertAuthEpoch(epoch)); localStorage.removeItem('feedink-private-purge-pending'); }
    catch (error) { assertAuthEpoch(epoch); localStorage.setItem('feedink-private-purge-pending', '1'); notify(`登录成功，但离线存储不可用：${message(error)}`, true); }
    assertAuthEpoch(epoch); localStorage.removeItem('feedink-logout-pending'); commitSession(value, epoch); setOnline(true);
    channelRef.current?.postMessage({ type: 'identity', userId: value.user.id });
    if (location.pathname !== '/share') navigate('/', true);
  }
  async function retryLogout() {
    if (logoutInFlight.current || sessionRef.current || !navigator.onLine || !localStorage.getItem('feedink-logout-pending')) return;
    const epoch = authEpoch(); logoutInFlight.current = true;
    try {
      await withAuthNetworkLock(async () => {
        assertAuthEpoch(epoch); let previous: Session;
        try { previous = await api<Session>('/session'); }
        catch (error) { assertAuthEpoch(epoch); if (error instanceof HttpError && error.status === 401) { localStorage.removeItem('feedink-logout-pending'); return; } throw error; }
        assertAuthEpoch(epoch); if (sessionRef.current) throw new ObsoleteSessionError();
        const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': previous.csrfToken }, cache: 'no-store' });
        assertAuthEpoch(epoch);
        if (!response.ok && response.status !== 401) throw new Error('服务器退出尚未完成，联网后会重试');
        localStorage.removeItem('feedink-logout-pending'); notify('服务器会话已撤销');
      });
    } catch (error) { if (!(error instanceof ObsoleteSessionError)) notify(message(error), true); }
    finally { logoutInFlight.current = false; }
  }
  async function logout() {
    const owner = sessionRef.current?.user.id;
    localStorage.setItem('feedink-logout-pending', '1');
    const epoch = beginAuthTransition(); commitSession(null, epoch); navigate('/login', true); channelRef.current?.postMessage({ type: 'logout' });
    // Neither operation depends on the other's success; quota/purge errors cannot prevent server revocation.
    await Promise.all([purge(epoch, owner), retryLogout()]);
    if (!navigator.onLine) notify('已退出；离线时无法撤销服务器会话，恢复联网后会自动重试');
  }
  useEffect(() => {
    let alive = true; const epoch = authEpoch();
    async function boot() {
      try {
        if (localStorage.getItem('feedink-logout-pending') || localStorage.getItem('feedink-private-purge-pending')) { await Promise.all([purge(), retryLogout()]); return; }
        const value = await api<Session>('/session'); if (!alive) return; assertAuthEpoch(epoch);
        try { await store.activate(value, () => assertAuthEpoch(epoch)); } catch (error) { assertAuthEpoch(epoch); localStorage.setItem('feedink-private-purge-pending', '1'); notify(`离线存储不可用：${message(error)}`, true); }
        if (!alive) return; assertAuthEpoch(epoch); commitSession(value, epoch); setOnline(true);
      } catch (error) {
        if (!alive || error instanceof ObsoleteSessionError) return;
        if (error instanceof HttpError && error.status === 401) { commitSession(null, epoch); await purge(); }
        else if (isConnectionError(error)) { const cached = await store.identity(); assertAuthEpoch(epoch); if (alive && cached) { commitSession({ ...cached, csrfToken: '' }, epoch); setOnline(false); notify('离线模式：仅显示此账号在此设备缓存的文章'); } }
        else notify(message(error), true);
      } finally { if (alive) setStarting(false); }
    }
    void boot().catch(error => { if (alive && !(error instanceof ObsoleteSessionError)) { notify(`无法打开离线存储：${message(error)}`, true); setStarting(false); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const pop = () => setLocationKey(location.pathname + location.search);
    const offline = () => setOnline(false); const reconnect = () => { setOnline(navigator.onLine); if (!sessionRef.current) void retryLogout(); };
    const unauthorized = () => void invalidate();
    window.addEventListener('popstate', pop); window.addEventListener('offline', offline); window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect); window.addEventListener('feedink:unauthorized', unauthorized);
    if ('BroadcastChannel' in window) {
      const channel = new BroadcastChannel('feedink-auth'); channelRef.current = channel;
      channel.onmessage = event => { if (event.data?.type === 'logout' || event.data?.type === 'identity') { const epoch = beginAuthTransition(); commitSession(null, epoch); navigate('/login', true); notify('账号在另一标签页已变更，请重新登录'); } };
    }
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('offline', offline); window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect); window.removeEventListener('feedink:unauthorized', unauthorized); channelRef.current?.close(); };
  }, []);
  const renderEpoch = authEpoch();
  const path = locationKey.split('?')[0];
  return <>{starting ? <main className="startup"><Logo text /><p role="status">正在打开你的阅读空间…</p></main> : session ? <Workspace key={session.user.id} session={session} epoch={renderEpoch} store={store} online={online} setOnline={setOnline} locationKey={locationKey} navigate={navigate} notify={notify} task={task} updateSession={value => { assertAuthEpoch(renderEpoch); if (sessionRef.current?.user.id !== value.user.id) throw new ObsoleteSessionError(); commitSession(value, renderEpoch); void store.updateIdentity(value, () => assertAuthEpoch(renderEpoch)).catch(error => { if (!(error instanceof ObsoleteSessionError)) notify(message(error), true); }); }} logout={logout} invalidate={invalidate} /> : <Auth onLogin={login} path={path} navigate={navigate} />}
    {notice && <Notification notice={notice} close={() => setNotice(null)} />}
  </>;
}

function Notification({ notice, close }: { notice: { text: string; error: boolean }; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.showPopover?.(); }, [notice]);
  return <div ref={ref} popover="manual" className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><IconButton icon="close" label="关闭提示" onClick={close} /></div>;
}

interface WorkspaceProps {
  session: Session; epoch: number; store: OfflineStore; online: boolean; setOnline: (online: boolean) => void;
  locationKey: string; navigate: AppContextValue['navigate']; notify: AppContextValue['notify']; task: AppContextValue['task']; updateSession: (session: Session) => void; logout: () => Promise<void>; invalidate: (reason?: string) => Promise<void>;
}
function Workspace({ session, epoch, store, online, setOnline, locationKey, navigate, notify, task, updateSession, logout, invalidate }: WorkspaceProps) {
  const settings = session.settings; const userId = session.user.id;
  const [library, setLibrary] = useState<Library>(emptyLibrary); const [libraryReady, setLibraryReady] = useState(false); const [articles, setArticles] = useState<ArticleSummary[]>([]); const [article, setArticle] = useState<ArticleDetail | null>(null); const articleRef = useRef<ArticleDetail | null>(null);
  const [total, setTotal] = useState(0); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [loadingArticle, setLoadingArticle] = useState(false); const [version, setVersion] = useState(0);
  const [drawer, setDrawer] = useState(false); const [sidebarClosed, setSidebarClosed] = useState(false); const [filters, setFilters] = useState(false); const [listMenu, setListMenu] = useState(false); const [help, setHelp] = useState(false);
  const [organization, setOrganization] = useState<OrganizationTarget | null>(null); const [actionArticle, setActionArticle] = useState<ArticleSummary | null>(null); const [pending, setPending] = useState(0); const [syncing, setSyncing] = useState(false); const [cachedIds, setCachedIds] = useState(new Set<string>());
  const syncLock = useRef(false); const cacheEpoch = useRef(0); const cacheEnabled = useRef(settings.offlineEnabled); cacheEnabled.current = settings.offlineEnabled; const articleRequest = useRef(0); const listRequest = useRef(0); const viewRef = useRef<HTMLDivElement>(null); const listRef = useRef<HTMLDivElement>(null); const listScrolls = useRef(new Map<string, number>()); const pointer = useRef<ReturnType<typeof setTimeout> | null>(null); const longPressed = useRef(false);
  const [mode, setMode] = useState<ArticleMode>('feed'); const [focusedIndex, setFocusedIndex] = useState(0);
  const params = new URLSearchParams(locationKey.split('?')[1] || ''); const path = locationKey.split('?')[0]; const selectedId = params.get('article');
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const subscription = library.subscriptions.find(item => item.id === params.get('subscription'));
  const folder = library.folders.find(item => item.id === (params.get('folder') || subscription?.folderId));
  const preferences: FeedPreferences = { ...folder?.settings, ...subscription?.settings };
  const query = articleQuery(params.toString(), settings, preferences); const queryKey = queryString(query);
  const title = subscription?.title || (params.get('folder') ? folder?.name : undefined) || library.tags.find(item => item.id === params.get('tag'))?.name || scopeTitles[query.scope || 'all'];
  const [searchText, setSearchText] = useState(params.get('q') || '');
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  const setDetail = (detail: ArticleDetail | null) => { articleRef.current = detail; setArticle(detail); };
  const receiveDetail = (detail: ArticleDetail) => {
    if (selectedIdRef.current !== detail.id) return;
    const current = articleRef.current;
    setDetail(current?.id === detail.id ? { ...detail, read: current.read, saved: current.saved, tags: current.tags, progress: current.progress } : detail);
  };
  function selectScope(values: Record<string, string>) { const next = new URLSearchParams(values); navigate(`/?${next}`); setDrawer(false); }
  function changeParam(key: string, value: string) { const next = new URLSearchParams(location.search); if (value) next.set(key, value); else next.delete(key); next.delete('article'); navigate(`/?${next}`); }
  function openArticle(id: string) { const next = new URLSearchParams(location.search); next.set('article', id); navigate(`/?${next}`); }
  function retainProgress() { const current = articleRef.current; const element = viewRef.current; if (current && element) void task(() => patchArticle(current, { progress: progressAt(element.scrollTop, element.scrollHeight, element.clientHeight) })); }
  function back() { retainProgress(); const next = new URLSearchParams(location.search); next.delete('article'); navigate(`/?${next}`); listRef.current?.querySelector<HTMLButtonElement>(`[data-article-id="${CSS.escape(selectedId || '')}"]`)?.focus(); }
  function move(direction: number) { retainProgress(); const current = Math.max(0, articles.findIndex(item => item.id === selectedId)); const next = current + direction; if (next >= 0 && next < articles.length) { setFocusedIndex(next); openArticle(articles[next].id); } else notify(direction > 0 ? cursor ? '已到当前页末尾，请加载更多文章' : '已经是最后一篇' : '已经是第一篇'); }
  async function clearCache(enabled = cacheEnabled.current) {
    cacheEpoch.current++; cacheEnabled.current = enabled; setCachedIds(new Set());
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('feedink-cache') : null;
    channel?.postMessage({ userId }); channel?.close();
    await store.removeArticles(userId, enabled);
  }
  useEffect(() => {
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('feedink-cache') : null;
    if (channel) channel.onmessage = event => { if (event.data?.userId === userId) { cacheEpoch.current++; setCachedIds(new Set()); } };
    return () => channel?.close();
  }, [userId]);
  async function updateSettings(patch: Partial<ReaderSettings>) {
    assertAuthEpoch(epoch); if (!online) throw new Error('设置需要联网保存；离线阅读状态仍可正常修改');
    if (patch.offlineEnabled === false) { cacheEpoch.current++; cacheEnabled.current = false; setCachedIds(new Set()); }
    const result = await mutate<ReaderSettings>('/settings', 'PATCH', patch); assertAuthEpoch(epoch); updateSession({ ...session, settings: result });
    if (patch.offlineEnabled !== undefined) await clearCache(result.offlineEnabled).catch(error => notify(`设置已保存；本地缓存清理失败：${message(error)}`, true));
  }
  async function updateListPreference(patch: FeedPreferences) {
    if (subscription) await mutate(`/subscriptions/${subscription.id}`, 'PATCH', { settings: { ...subscription.settings, ...patch } });
    else if (folder && params.get('folder')) await mutate(`/folders/${folder.id}`, 'PATCH', { settings: { ...folder.settings, ...patch } });
    else { await updateSettings(patch.view && window.innerWidth < 700 ? { mobileView: patch.view } : patch); return; }
    refresh();
  }
  async function cacheArticle(detail: ArticleDetail) {
    if (!cacheEnabled.current) return;
    const generation = cacheEpoch.current;
    setCachedIds(old => { const next = new Set(old); next.delete(detail.id); return next; });
    const guard = () => { assertAuthEpoch(epoch); if (generation !== cacheEpoch.current || !cacheEnabled.current) throw new CacheInvalidatedError(); };
    try {
      const ticket = await store.cacheTicket(userId); guard();
      await store.saveArticle(userId, detail, ticket); guard();
      const urls = detail.images.filter(image => image.status === 'cached').map(image => image.url);
      const icon = library.subscriptions.find(sub => sub.id === detail.subscriptionId)?.iconUrl;
      for (const raw of urls) {
        const url = ownedImageUrl(raw); if (!url) continue;
        if (await store.image(userId, url)) { guard(); continue; }
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); guard();
        if (!response.ok) throw new Error(`图片缓存失败 (${response.status})`);
        const blob = await response.blob(); guard(); await store.saveImage(userId, url, blob, ticket); guard();
      }
      // Source icons have a generic offline fallback and do not determine article/image readiness.
      if (icon && ownedImageUrl(icon)) {
        try {
          if (!await store.image(userId, icon)) { guard(); const response = await fetch(icon, { credentials: 'same-origin', cache: 'no-store' }); guard(); if (response.ok) { const blob = await response.blob(); guard(); await store.saveImage(userId, icon, blob, ticket); } }
        } catch (error) { if (error instanceof CacheInvalidatedError || error instanceof ObsoleteSessionError) throw error; }
      }
      guard(); if ((await store.cacheTicket(userId)).generation !== ticket.generation) throw new CacheInvalidatedError(); guard();
      setCachedIds(old => new Set(old).add(detail.id));
    } catch (error) {
      if (!(error instanceof CacheInvalidatedError) && !(error instanceof ObsoleteSessionError)) notify(`服务器操作不受影响，但此设备未完成离线缓存：${message(error)}`, true);
    }
  }
  async function sync() {
    if (syncLock.current || !navigator.onLine) return; syncLock.current = true; setSyncing(true);
    try {
      await synchronizeState(store, userId, epoch); assertAuthEpoch(epoch);
      const remaining = (await store.pending(userId)).length; assertAuthEpoch(epoch);
      setOnline(true); setPending(remaining);
      if (remaining) setTimeout(() => { if (authEpoch() === epoch) void sync(); }, 100);
    } catch (error) {
      if (authEpoch() !== epoch || error instanceof ObsoleteSessionError) return;
      if (error instanceof ObsoleteMutationError) { if (authEpoch() === epoch) setTimeout(() => void sync(), 150); return; }
      if (error instanceof HttpError && error.status === 401 || error instanceof OwnerMismatchError) await invalidate('登录账号已变更，请重新登录');
      else { if (isConnectionError(error)) setOnline(false); notify(`离线更改暂未同步：${message(error)}`, true); }
    } finally { syncLock.current = false; if (authEpoch() === epoch) setSyncing(false); }
  }
  async function patchArticle(summary: ArticleSummary, patch: ArticleStatePatch) {
    const queued = await queueState(store, userId, summary, patch, online, epoch, text => notify(text, true)); assertAuthEpoch(epoch);
    const update = <T extends ArticleSummary>(value: T): T => ({ ...value, ...patch, ...(patch.tagIds ? { tags: library.tags.filter(tag => patch.tagIds!.includes(tag.id)) } : {}) });
    setArticles(old => old.map(item => item.id === summary.id ? update(item) : item));
    const readDelta = patch.read === undefined || patch.read === summary.read ? 0 : patch.read ? -1 : 1;
    if (readDelta) setLibrary(old => adjustCounts(old, summary, readDelta));
    if (articleRef.current?.id === summary.id) setDetail(update(articleRef.current));
    setActionArticle(old => old?.id === summary.id ? update(old) : old); setPending((await store.pending(userId).catch(() => [])).length);
    if (online && queued) void sync();
  }
  useEffect(() => { let alive = true; void task(async () => { let value: Library;
    if (online) { try { const countEpoch = await store.countEpoch(userId).catch(() => 0); const [subscriptions, folders, tags] = await Promise.all([api<{ items: Library['subscriptions'] }>('/subscriptions'), api<{ items: Library['folders'] }>('/folders'), api<{ items: Library['tags'] }>('/tags')]); value = { subscriptions: subscriptions.items, folders: folders.items, tags: tags.items }; value = await store.saveLibrary(userId, value, countEpoch).catch(error => { notify(`订阅已加载，但离线保存失败：${message(error)}`, true); return value; }); }
      catch (error) { if (!isConnectionError(error)) throw error; setOnline(false); value = await store.library(userId) || emptyLibrary; }
    } else value = await store.library(userId) || emptyLibrary;
    assertAuthEpoch(epoch); if (alive) { setLibrary(value); setLibraryReady(true); }
  }); return () => { alive = false; }; }, [online, version, userId]);
  useEffect(() => { if (online) void sync(); else void task(async () => { const items = await store.pending(userId); assertAuthEpoch(epoch); setPending(items.length); }); }, [online]);
  useEffect(() => { const reconnect = () => { if (navigator.onLine) void sync(); }; window.addEventListener('focus', reconnect); return () => window.removeEventListener('focus', reconnect); }, [userId, online]);
  useEffect(() => { setSearchText(params.get('q') || ''); }, [params.get('q')]);
  async function loadPage(nextCursor?: string) {
    const requestId = ++listRequest.current; setLoading(true);
    try {
      let page: ArticlePage;
      if (online) {
        try { page = await api<ArticlePage>(`/articles?${queryString({ ...query, cursor: nextCursor })}`); }
        catch (error) { if (!isConnectionError(error)) throw error; setOnline(false); const items = await store.articles(userId, query); page = { items, nextCursor: null, total: items.length }; }
      } else { const items = await store.articles(userId, query); page = { items, nextCursor: null, total: items.length }; }
      const queued = await store.pending(userId).catch(error => { if (!online) throw error; return []; });
      page.items = page.items.map(item => { const state = queued.find(change => change.articleId === item.id)?.patch; return state ? { ...item, ...state, ...(state.tagIds ? { tags: library.tags.filter(tag => state.tagIds!.includes(tag.id)) } : {}) } : item; });
      if (requestId !== listRequest.current) return;
      setArticles(old => nextCursor ? [...old, ...page.items.filter(item => !old.some(existing => existing.id === item.id))] : page.items); setCursor(page.nextCursor); setTotal(page.total);
      if (!nextCursor) requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listScrolls.current.get(queryKey) || 0; });
    } catch (error) { if (requestId === listRequest.current) notify(message(error), true); }
    finally { if (requestId === listRequest.current) setLoading(false); }
  }
  useEffect(() => { setFocusedIndex(0); void loadPage(); return () => { listRequest.current++; }; }, [queryKey, online, version]);
  useEffect(() => {
    const requestId = ++articleRequest.current;
    if (!selectedId) { setDetail(null); return; }
    if (!libraryReady) return;
    setLoadingArticle(true);
    let opened = false;
    void task(async () => {
      let detail: ArticleDetail | undefined;
      if (online) { try { detail = await api<ArticleDetail>(`/articles/${selectedId}`); } catch (error) { if (!isConnectionError(error)) throw error; setOnline(false); detail = await store.article(userId, selectedId); } }
      else detail = await store.article(userId, selectedId);
      if (!detail) throw new Error('此文章尚未缓存。请联网打开后再离线阅读。');
      if (requestId !== articleRequest.current) return;
      const state = (await store.pending(userId).catch(error => { if (!online) throw error; return []; })).find(item => item.articleId === detail!.id)?.patch;
      assertAuthEpoch(epoch); if (requestId !== articleRequest.current || selectedIdRef.current !== detail.id) return;
      if (state) detail = applyState(detail, state, library.tags);
      const detailSub = library.subscriptions.find(item => item.id === detail!.subscriptionId); const detailFolder = library.folders.find(item => item.id === detailSub?.folderId);
      const preferred = detailSub?.settings.articleMode || detailFolder?.settings.articleMode || (settings.autoFulltext ? 'fulltext' : 'feed');
      opened = true; setMode(preferred); setDetail(detail); setLoadingArticle(false);
      if (!detail.read) await patchArticle(detail, { read: true });
      if (preferred === 'fulltext' && !detail.fulltextHtml && online) {
        try { const full = await mutate<ArticleDetail>(`/articles/${detail.id}/fulltext`, 'POST'); if (requestId === articleRequest.current) { detail = { ...full, read: articleRef.current?.read ?? true, saved: articleRef.current?.saved ?? full.saved, tags: articleRef.current?.tags ?? full.tags, progress: articleRef.current?.progress ?? full.progress }; receiveDetail(detail); } if (full.fulltextError) notify(full.fulltextError, true); }
        catch (error) { notify(`全文提取失败，保留 RSS 正文：${message(error)}`, true); }
      }
      if (requestId === articleRequest.current) await cacheArticle(detail);
    }).finally(() => { if (requestId === articleRequest.current) { setLoadingArticle(false); if (!opened) setDetail(null); } });
    return () => { articleRequest.current++; };
  }, [selectedId, userId, libraryReady]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const action = shortcutAction(event.key, event.target, event.ctrlKey || event.altKey || event.metaKey); if (!action) return;
      event.preventDefault();
      if (action === 'help') setHelp(true);
      else if (action === 'back') back();
      else if (action === 'next' || action === 'previous') { if (selectedId) move(action === 'next' ? 1 : -1); else { const index = Math.max(0, Math.min(articles.length - 1, focusedIndex + (action === 'next' ? 1 : -1))); setFocusedIndex(index); listRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="article-card"]')[index]?.focus(); } }
      else if (action === 'open' && !selectedId && articles[focusedIndex]) openArticle(articles[focusedIndex].id);
      else if (action === 'page' && selectedId) { const element = viewRef.current; if (element && progressAt(element.scrollTop, element.scrollHeight, element.clientHeight) > 0.99) move(1); else element?.scrollBy({ top: element.clientHeight * 0.85, behavior: 'instant' }); }
      else if (action === 'save' || action === 'read') { const current = article || articles[focusedIndex]; if (current) void task(() => patchArticle(current, action === 'save' ? { saved: !current.saved } : { read: !current.read })); }
      else if (action === 'original' && article) { const url = safeExternalUrl(article.url); if (url) window.open(url, '_blank', 'noopener,noreferrer'); }
      else if (action === 'feed') { const available = library.subscriptions.filter(item => item.unreadCount > 0 && !item.settings.muted); const index = available.findIndex(item => item.id === subscription?.id); const next = available[(index + 1) % available.length]; if (next) selectScope({ subscription: next.id }); else notify('没有更多未读订阅'); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; document.documentElement.style.colorScheme = settings.theme === 'dark' ? 'dark' : settings.theme === 'system' ? 'light dark' : 'light'; document.title = `${article?.title || title} · FeedInk`; }, [settings.theme, article?.title, title]);
  const customCss = useMemo(() => { try { return settings.theme === 'eink' ? '' : scopedCss(settings.customCss); } catch { return ''; } }, [settings.customCss, settings.theme]);
  const context: AppContextValue = { session, library, store, online, articles, article, navigate, notify, task, refresh, updateSettings, updateSession, patchArticle, openArticle, logout, cacheArticle, clearCache };
  const style = { '--sidebar-width': `${settings.sidebarWidth}px`, '--list-width': `${settings.listWidth}px`, '--accent': /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : DEFAULT_SETTINGS.accent, '--article-size': `${settings.fontSize}px`, '--article-line': settings.lineHeight, '--content-width': `${settings.contentWidth}px`, '--article-font': settings.fontFamily === 'serif' ? 'Georgia, "Noto Serif SC", "Songti SC", serif' : settings.fontFamily === 'sans' ? 'Arial, "PingFang SC", sans-serif' : 'system-ui, -apple-system, "PingFang SC", sans-serif' } as CSSProperties;
  const navigatePanel = (route: string) => navigate(`${route}${location.search}`);
  async function bulkRead(above?: string) {
    const loaded = above ? articles.slice(0, articles.findIndex(item => item.id === above)) : articles;
    if (above && !loaded.length) { notify('此文章上方没有文章'); return; }
    if (!above && !confirm(`将“${title}”中符合当前筛选的${online ? '全部' : '已缓存'}文章标为已读？`)) return;
    const cached = above ? [] : await store.articles(userId, query).catch(error => { if (!online) throw error; notify('无法更新部分离线元数据，请联网重新缓存', true); return []; });
    const list = [...new Map([...cached, ...loaded].map(item => [item.id, item])).values()];
    if (online) await mutate('/articles/bulk-state', 'POST', above ? { ids: loaded.map(item => item.id), read: true } : { query, read: true });
    assertAuthEpoch(epoch);
    for (const item of list) await patchArticle(item, { read: true });
    if (online) { await sync(); refresh(); } notify('已标记为已读');
  }
  function sourceRow(sub: Library['subscriptions'][number]) {
    if (settings.hideReadFeeds && !sub.unreadCount && subscription?.id !== sub.id) return null;
    return <div className={`sidebar-item ${subscription?.id === sub.id ? 'selected' : ''}`} key={sub.id} onContextMenu={event => { event.preventDefault(); setOrganization({ kind: 'subscription', value: sub }); }}><button className="nav-item" onClick={() => { if (subscription?.id === sub.id && online) void task(async () => { await mutate(`/subscriptions/${sub.id}/refresh`, 'POST'); refresh(); }); selectScope({ subscription: sub.id }); }}>{sub.settings.pinned ? <Icon name="pin" size={16} /> : <SourceIcon subscriptionId={sub.id} size={12} />}<span className="truncate">{sub.title}</span>{sub.status === 'error' && <span className="source-error" title={sub.lastError || '更新失败'}>!</span>}<span className="count">{sub.unreadCount || ''}</span>{sub.settings.muted && <Icon name="mute" size={12} />}</button><IconButton icon="more" label={`管理订阅 ${sub.title}`} className="icon-button item-more" onClick={() => setOrganization({ kind: 'subscription', value: sub })} /></div>;
  }
  const sortedSubs = [...library.subscriptions].sort((a, b) => Number(!!b.settings.pinned) - Number(!!a.settings.pinned) || a.position - b.position);
  return <AppContext.Provider value={context}><div className={`app-shell ${selectedId ? 'has-article' : ''} ${sidebarClosed ? 'sidebar-collapsed' : ''} ${drawer ? 'drawer-open' : ''}`} data-testid="app-shell" data-theme={settings.theme} style={style}>
    {customCss && <style>{customCss}</style>}
    {drawer && <button className="drawer-scrim" aria-label="关闭侧栏" onClick={() => setDrawer(false)} />}
    <aside className="sidebar" aria-label="订阅导航" aria-hidden={path !== '/' || undefined}><header className="sidebar-header"><Logo /><span className="toolbar-spacer" /><IconButton icon="sidebarClose" label="收起侧栏" onClick={() => { setSidebarClosed(true); setDrawer(false); }} /><IconButton icon="user" label="我的账号" onClick={() => navigatePanel('/settings')} /></header>
      <div className="sidebar-scroll"><nav aria-label="阅读分类">{([['all', 'inbox', '全部'], ['unread', 'unread', '未读'], ['saved', 'saved', '稍后阅读'], ['archive', 'archive', '全部存档']] as const).map(([scope, icon, label]) => <button key={scope} className={`nav-item ${query.scope === scope && !query.subscriptionId && !query.folderId && !query.tagId ? 'selected' : ''}`} onClick={() => selectScope({ scope })}><Icon name={icon} size={17} /><span>{label}</span>{scope === 'all' && <span className="count">{library.subscriptions.reduce((sum, sub) => sum + sub.unreadCount, 0) || ''}</span>}</button>)}</nav>
        <div className="section-heading"><span>标签</span><IconButton icon="add" label="新建标签" onClick={() => setOrganization({ kind: 'tag' })} /></div>{library.tags.map(tag => <div className={`sidebar-item ${query.tagId === tag.id ? 'selected' : ''}`} key={tag.id} onContextMenu={event => { event.preventDefault(); setOrganization({ kind: 'tag', value: tag }); }}><button className="nav-item" onClick={() => selectScope({ tag: tag.id })}><span className="tag-dot" style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(tag.color) ? tag.color : undefined }} /><span className="truncate">{tag.name}</span><span className="count">{tag.count || ''}</span></button><IconButton icon="more" label={`管理标签 ${tag.name}`} className="icon-button item-more" onClick={() => setOrganization({ kind: 'tag', value: tag })} /></div>)}
        <div className="section-heading"><span>订阅源</span><span className="toolbar-spacer" /><IconButton icon="add" label="添加订阅" onClick={() => navigatePanel('/discover')} /><IconButton icon="folder" label="新建文件夹" onClick={() => setOrganization({ kind: 'folder' })} /></div>
        {library.folders.map(item => <details className="folder-group" key={item.id} open={query.folderId === item.id || undefined}><summary><Icon name="right" size={15} /><button className={`folder-name ${query.folderId === item.id ? 'active' : ''}`} onClick={event => { event.preventDefault(); selectScope({ folder: item.id }); }}>{item.name}</button><span className="count">{item.unreadCount || ''}</span><IconButton icon="more" label={`管理文件夹 ${item.name}`} onClick={event => { event.preventDefault(); setOrganization({ kind: 'folder', value: item }); }} /></summary><div className="folder-children">{sortedSubs.filter(sub => sub.folderId === item.id).map(sourceRow)}</div></details>)}
        {sortedSubs.filter(sub => !sub.folderId || !library.folders.some(item => item.id === sub.folderId)).map(sourceRow)}
        {!library.subscriptions.length && <button className="add-first" onClick={() => navigatePanel('/discover')}><Icon name="add" />添加第一个订阅</button>}
      </div>
      <footer className="sidebar-footer"><button className="nav-item" onClick={() => navigatePanel('/share')}><Icon name="add" size={17} />保存网页</button><div className="button-row"><IconButton icon="settings" label="设置" onClick={() => navigatePanel('/settings')} /><IconButton icon="download" label="导入订阅与存档" onClick={() => navigatePanel('/import')} /><IconButton icon="archive" label="导出与电子书" onClick={() => navigatePanel('/export')} /><IconButton icon="help" label="快捷键帮助" onClick={() => setHelp(true)} /><IconButton icon="logout" label="退出登录" onClick={() => void logout()} /></div></footer>
      <ResizeHandle label="调整侧栏宽度" value={settings.sidebarWidth} min={180} max={360} onChange={value => void task(() => updateSettings({ sidebarWidth: value }))} />
    </aside>
    <section className="list-pane" aria-label="文章列表"><header className="list-toolbar"><IconButton icon="menu" label="打开侧栏" className="icon-button sidebar-toggle" onClick={() => { setSidebarClosed(false); setDrawer(true); }} /><h1>{title}</h1><span className="count">{total}</span><span className="toolbar-spacer" /><IconButton icon="allRead" label="全部标为已读" onClick={() => void task(() => bulkRead())} /><IconButton icon="more" label="列表菜单" aria-expanded={listMenu} onClick={() => setListMenu(value => !value)} /></header>
      <form className="search-bar" onSubmit={(event: FormEvent) => { event.preventDefault(); changeParam('q', searchText); }}><Icon name="search" size={16} /><input aria-label="搜索文章" placeholder="搜索文章…" value={searchText} onChange={event => setSearchText(event.target.value)} />{searchText && <IconButton icon="close" label="清除搜索" onClick={() => { setSearchText(''); changeParam('q', ''); }} />}<IconButton icon="filters" label="筛选与视图" aria-expanded={filters} onClick={() => setFilters(value => !value)} /></form>
      <div className={`network-status ${!online ? 'is-offline' : ''}`} data-testid="offline-status"><span>{!online ? <><Icon name="offline" size={13} />离线 · 仅本地缓存{pending > 0 && ` · ${pending} 项待同步`}</> : syncing ? '正在同步…' : pending ? `${pending} 项更改待同步` : selectedId && cachedIds.has(selectedId) ? '离线可用 · 已缓存正文与可用图片' : '已连接'}</span>{(!online || pending > 0) && <button className="text-button" onClick={() => void sync()}>重试同步</button>}</div>
      {filters && <div className="filter-panel"><div className="button-row">{(['magazine', 'list', 'grid'] as const).map(view => <button key={view} className={(preferences.view || settings.view) === view ? 'active' : ''} onClick={() => void task(() => updateListPreference({ view }))}>{view === 'magazine' ? '杂志' : view === 'list' ? '单行' : '网格'}</button>)}</div><label>排序 <select value={query.sort} onChange={event => void task(() => updateListPreference({ sort: event.target.value as ReaderSettings['sort'] }))}><option value="newest">最新在前</option><option value="oldest">最早在前</option></select></label><label><input type="checkbox" checked={query.scope === 'unread'} onChange={event => changeParam('scope', event.target.checked ? 'unread' : 'all')} />只看未读</label><label>开始日期 <input type="date" value={params.get('after')?.slice(0, 10) || ''} onChange={event => changeParam('after', event.target.value ? `${event.target.value}T00:00:00.000Z` : '')} /></label><label>截止日期 <input type="date" value={params.get('before')?.slice(0, 10) || ''} onChange={event => changeParam('before', event.target.value ? `${event.target.value}T23:59:59.999Z` : '')} /></label>{(subscription || folder) && <button className="text-button" onClick={() => setOrganization(subscription ? { kind: 'subscription', value: subscription } : { kind: 'folder', value: folder! })}>当前源 / 文件夹独立偏好</button>}</div>}
      <div className={`article-list view-${preferences.view || settings.view} mobile-${preferences.view || settings.mobileView}`} ref={listRef} onScroll={event => { const element = event.currentTarget; listScrolls.current.set(queryKey, element.scrollTop); if (settings.markReadOnScroll) { const top = element.getBoundingClientRect().top; for (const row of element.querySelectorAll<HTMLButtonElement>('[data-unread="true"]')) if (row.getBoundingClientRect().bottom < top) { const item = articles.find(value => value.id === row.dataset.articleId); if (item) { row.dataset.unread = 'false'; void task(() => patchArticle(item, { read: true })); } } } }}>
        {loading && !articles.length ? <p className="loading" role="status">正在载入文章…</p> : !articles.length ? <Empty icon={query.q ? 'search' : 'inbox'} title={query.q ? '没有匹配的文章' : query.scope === 'unread' ? '未读清空了，休息一下' : !online ? '还没有离线文章' : '这里还没有文章'}><p>{!online ? '联网打开文章或使用列表菜单缓存文章。' : '添加订阅，或换个筛选条件试试。'}</p>{online && <button className="text-button" onClick={() => navigatePanel('/discover')}>发现订阅</button>}</Empty> : articles.map((item, index) => <button type="button" key={item.id} className={`article-card ${item.id === selectedId ? 'selected' : ''} ${item.read ? 'read' : 'unread'}`} data-testid="article-card" data-article-id={item.id} data-unread={!item.read} aria-current={item.id === selectedId ? 'true' : undefined} onFocus={() => setFocusedIndex(index)} onClick={event => { if (longPressed.current) { event.preventDefault(); longPressed.current = false; return; } openArticle(item.id); }} onContextMenu={event => { event.preventDefault(); setActionArticle(item); }} onPointerDown={event => { longPressed.current = false; if (event.pointerType !== 'mouse') pointer.current = setTimeout(() => { pointer.current = null; longPressed.current = true; setActionArticle(item); }, 550); }} onPointerUp={() => { if (pointer.current) clearTimeout(pointer.current); }} onPointerMove={() => { if (pointer.current) clearTimeout(pointer.current); }} onPointerCancel={() => { if (pointer.current) clearTimeout(pointer.current); }}>
          <span className="unread-dot" /><span className="card-meta">{settings.showFeedIcons && <SourceIcon subscriptionId={item.subscriptionId} size={12} />}<span className="truncate">{item.feedTitle || '网页存档'}</span><time dateTime={item.publishedAt}>{formatDate(item.publishedAt, true)}</time></span>
          {settings.showThumbnails && <AssetImage src={item.thumbnailUrl} alt="" className="card-thumbnail" />}<h2>{item.title || '无标题文章'}</h2><p>{item.summary}</p><span className="card-badges">{item.saved && <Icon name="saved" size={12} />}{item.tags.slice(0, 2).map(tag => <small key={tag.id}>{tag.name}</small>)}</span>
        </button>)}
        {cursor && <button className="load-more secondary" disabled={loading} onClick={() => void loadPage(cursor)}>{loading ? '加载中…' : '加载更多文章'}</button>}
      </div><ResizeHandle label="调整列表宽度" value={settings.listWidth} min={260} max={600} onChange={value => void task(() => updateSettings({ listWidth: value }))} />
    </section>
    {loadingArticle && <div className="reader-loading" role="status">正在打开文章…</div>}
    <Reader article={article} mode={mode} setMode={setMode} back={back} move={move} more={() => article && setActionArticle(article)} onDetail={receiveDetail} scrollRef={viewRef} />
    <PwaControls notify={notify} />
    {listMenu && <Modal title="列表操作" onClose={() => setListMenu(false)}><div className="action-list"><button onClick={() => void task(async () => { if (subscription) await mutate(`/subscriptions/${subscription.id}/refresh`, 'POST'); else for (const sub of library.subscriptions.filter(item => !query.folderId || item.folderId === query.folderId)) await mutate(`/subscriptions/${sub.id}/refresh`, 'POST'); refresh(); setListMenu(false); notify('已刷新订阅源'); })} disabled={!online}><Icon name="refresh" />刷新当前订阅</button><button onClick={() => void task(async () => { if (!settings.offlineEnabled) throw new Error('请先在设置中开启离线缓存'); for (const item of articles) await cacheArticle(await api<ArticleDetail>(`/articles/${item.id}`)); notify(`已处理 ${articles.length} 篇文章的离线缓存；图片失败会单独提示`); setListMenu(false); })} disabled={!online}><Icon name="offline" />缓存当前列表正文与图片</button><button onClick={() => { setListMenu(false); navigatePanel('/export'); }}><Icon name="download" />导出 / 生成电子书</button><button onClick={() => { setListMenu(false); navigatePanel('/import'); }}><Icon name="add" />导入 OPML / ZIP</button><button onClick={() => { setListMenu(false); setHelp(true); }}><Icon name="help" />快捷键与手势</button></div></Modal>}
    {actionArticle && <Modal title="文章操作" onClose={() => setActionArticle(null)}><h3>{actionArticle.title}</h3><div className="action-list"><button onClick={() => void task(() => patchArticle(actionArticle, { saved: !actionArticle.saved }))}><Icon name="saved" />{actionArticle.saved ? '移出稍后阅读' : '稍后阅读'}</button><button onClick={() => void task(() => patchArticle(actionArticle, { read: !actionArticle.read }))}><Icon name="unread" />{actionArticle.read ? '标记为未读' : '标记为已读'}</button><button onClick={() => void task(() => bulkRead(actionArticle.id))}><Icon name="allRead" />此文章以上标为已读</button><a href={safeExternalUrl(actionArticle.url) || undefined} target="_blank" rel="noopener noreferrer"><Icon name="external" />打开原文</a><button onClick={() => void task(async () => { const url = safeExternalUrl(actionArticle.url); if (!url) throw new Error('文章原文地址无效'); if (navigator.share) await navigator.share({ title: actionArticle.title, url }); else if (navigator.clipboard) { await navigator.clipboard.writeText(url); notify('原文链接已复制'); } else throw new Error('浏览器不支持自动复制，请使用“打开原文”后复制地址'); })}><Icon name="share" />分享 / 复制链接</button></div><h3>标签</h3><div className="tag-choices">{library.tags.map(tag => <label key={tag.id}><input type="checkbox" checked={actionArticle.tags.some(item => item.id === tag.id)} onChange={event => { const ids = actionArticle.tags.map(item => item.id); void task(() => patchArticle(actionArticle, { tagIds: event.target.checked ? [...ids, tag.id] : ids.filter(id => id !== tag.id) })); }} />{tag.name}</label>)}</div><button className="text-button" onClick={() => { setActionArticle(null); setOrganization({ kind: 'tag' }); }}>新建标签</button></Modal>}
    {organization && <Modal title={organization.kind === 'subscription' ? '管理订阅' : organization.kind === 'folder' ? '管理文件夹' : '管理标签'} onClose={() => setOrganization(null)}><OrganizationPanel key={`${organization.kind}:${organization.value?.id || 'new'}`} target={organization} close={() => setOrganization(null)} /></Modal>}
    {help && <Modal title="快捷键与手势" onClose={() => setHelp(false)}><dl className="shortcuts">{[['J / K', '下一篇 / 上一篇'], ['Enter', '打开选中文章'], ['U / O', '返回文章列表'], ['Space', '向下翻页，文末进入下一篇'], ['Y', '切换稍后阅读'], ['M', '切换已读状态'], ['V', '打开原文'], ['G', '下一未读订阅（跳过静音源）'], ['?', '显示帮助']].map(([key, description]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{description}</dd></div>)}</dl><p>手机：向右滑动阅读页返回列表；长按文章打开操作菜单。所有手势都有按钮替代。输入框中不会拦截快捷键。</p></Modal>}
    {path !== '/' && <Modal title={path.startsWith('/settings') ? '设置' : path === '/discover' ? '发现与添加订阅' : path === '/import' ? '导入' : path === '/export' ? '导出与电子书' : path === '/share' ? '保存网页' : '页面不存在'} wide={path.startsWith('/settings') || path === '/discover'} onClose={() => navigate(`/${location.search}`)}>{path.startsWith('/settings') ? <SettingsPanel key={path} path={path} /> : path === '/discover' ? <DiscoveryPanel /> : path === '/import' || path === '/export' ? <TransferPanel mode={path.slice(1) as 'import' | 'export'} /> : path === '/share' ? <SaveUrlPanel /> : <button className="primary" onClick={() => navigate('/')}>返回阅读</button>}</Modal>}
  </div></AppContext.Provider>;
}

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
function PwaControls({ notify }: { notify: AppContextValue['notify'] }) {
  const [update, setUpdate] = useState<ServiceWorker | null>(null); const [install, setInstall] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
    let disposed = false;
    void navigator.serviceWorker.register('/sw.js').then(registration => { if (disposed) return; if (registration.waiting) setUpdate(registration.waiting); registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdate(worker); }); }); }).catch(error => notify(`离线应用壳未能启用：${message(error)}`, true));
    const controller = () => { if (navigator.serviceWorker.controller && sessionStorage.getItem('feedink-update-requested')) { sessionStorage.removeItem('feedink-update-requested'); location.reload(); } }; navigator.serviceWorker.addEventListener('controllerchange', controller);
    return () => { disposed = true; navigator.serviceWorker.removeEventListener('controllerchange', controller); };
  }, []);
  useEffect(() => { const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); }; window.addEventListener('beforeinstallprompt', prompt); return () => window.removeEventListener('beforeinstallprompt', prompt); }, []);
  return <>{update && <div className="pwa-banner" role="status"><span>FeedInk 有新版本</span><button onClick={() => { sessionStorage.setItem('feedink-update-requested', '1'); update.postMessage('ACTIVATE_UPDATE'); }}>更新并重新载入</button><IconButton icon="close" label="稍后更新" onClick={() => setUpdate(null)} /></div>}{install && <div className="pwa-banner install-banner"><button onClick={() => void install.prompt().then(() => install.userChoice).then(choice => { setInstall(null); if (choice.outcome === 'accepted') notify('已请求安装 FeedInk'); })}>安装 FeedInk</button><IconButton icon="close" label="暂不安装" onClick={() => setInstall(null)} /></div>}</>;
}
