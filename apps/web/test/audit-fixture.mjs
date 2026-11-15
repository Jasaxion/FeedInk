// Deterministic HTTP fixture for client lifecycle races, not backend acceptance evidence.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '@feedink/shared';
import { fixtureOrigin } from './fixture-origin.mjs';
export function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
export async function auditFixture() {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const user = name => ({ id: name, email: `${name}@example.test`, name, isAdmin: false, isDemo: false, createdAt: '2026-01-01T00:00:00Z' });
  const article = id => ({ id, stateVersion: 0, feedId: '12345678-abcd-1234-abcd-123456789abc', subscriptionId: 'sub', feedTitle: '测试订阅', title: id === 'one' ? '第一篇持久存档' : '第二篇独立阅读', url: '', author: null, publishedAt: '2026-01-01T00:00:00Z', summary: '原创测试摘要', thumbnailUrl: '/api/assets/image-one', read: true, saved: false, tags: [], wordCount: 20, archivedAt: '2026-01-01T00:00:00Z', progress: 0, enclosures: [], contentHtml: `<p>${id === 'one' ? '第一篇持久存档正文' : '第二篇独立阅读正文'}</p><img alt="归档图片" src="/api/assets/image-one">`, fulltextHtml: null, contentText: '原创测试正文', fetchedAt: '2026-01-01T00:00:00Z', contentHash: 'a'.repeat(64), images: [{ id: 'image-one', url: '/api/assets/image-one', originalUrl: 'https://example.test/image.png', status: 'cached', contentType: 'image/png' }], fulltextError: null });
  const control = { user: user('alice'), loggedIn: true, settings: { ...DEFAULT_SETTINGS }, articles: [article('one'), article('two')], folders: [{ id: 'folder', name: '文件夹', position: 0, unreadCount: 0, settings: {} }], subscriptions: [{ id: 'sub', feedId: '12345678-abcd-1234-abcd-123456789abc', title: '测试订阅', url: 'https://example.test/feed', siteUrl: 'https://example.test', description: '', iconUrl: '/api/feed-icons/12345678-abcd-1234-abcd-123456789abc', folderId: 'folder', unreadCount: 0, totalCount: 2, settings: {}, status: 'ok', lastFetchedAt: null, lastError: null, position: 0 }], tags: [], writes: [], logouts: 0, sessionCalls: 0, holdSession: null, holdLibrary: null, holdMutation: null, mutationHeld: false, iconStatus: 200, listed: null, assets: 0, holdList: null, listCaptured: false, holdDetail: null, detailCaptured: false, rejectedCsrf: 0, discoveryQueries: [] };
  const counts = () => { const unread = control.articles.filter(item => !item.read).length; control.subscriptions[0].unreadCount = unread; control.folders[0].unreadCount = unread; };
  const routes = [], routeErrors = [];
  const route = (pathname, handler) => routes.unshift({ pathname, handler });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      const body = async () => { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
      if (url.pathname.startsWith('/api/')) {
        const login = ['/api/auth/login', '/api/auth/register', '/api/auth/demo'].includes(url.pathname);
        if (url.pathname === '/api/session') { control.sessionCalls++; if (control.holdSession) await control.holdSession.promise; }
        if (!login && !control.loggedIn) return json({ error: { code: 'UNAUTHORIZED', message: '请登录' } }, 401);
        if (!login && req.method !== 'GET' && req.headers['x-csrf-token'] !== `csrf-${control.user.id}`) { control.rejectedCsrf++; return json({ error: { code: 'CSRF_INVALID', message: 'CSRF token required' } }, 403); }
        // HTTP dispatch also covers service-worker-controlled WebKit requests.
        // Overrides retain the fixture's authentication and mutation CSRF guards.
        const matched = routes.find(route => typeof route.pathname === 'string' ? route.pathname === url.pathname : route.pathname.test(url.pathname));
        if (matched) {
          try { return await matched.handler({ request: req, url, body, json }); }
          catch (error) { routeErrors.push(String(error)); throw error; }
        }
        if (login) { const data = await body(); control.user = user(data.name || 'bob'); control.loggedIn = true; return json({ user: control.user, settings: control.settings, csrfToken: `csrf-${control.user.id}` }); }
        if (url.pathname === '/api/session') return json({ user: control.user, settings: control.settings, csrfToken: `csrf-${control.user.id}` });
        if (url.pathname === '/api/auth/logout') { control.logouts++; control.loggedIn = false; res.writeHead(204); res.end(); return; }
        if (url.pathname === '/api/discover') { control.discoveryQueries.push(url.searchParams.get('q')); return json({ feeds: [{ title: '发现结果订阅', url: 'https://example.test/discovered-feed', siteUrl: 'https://example.test', description: '发现结果夹具' }] }); }
        if (url.pathname === '/api/settings') { if (req.method === 'PATCH') control.settings = { ...control.settings, ...await body() }; return json(control.settings); }
        if (url.pathname === '/api/subscriptions') { if (control.holdLibrary) await control.holdLibrary.promise; return json({ items: control.subscriptions }); }
        if (url.pathname === '/api/folders') { if (req.method === 'POST') { const folder = { id: 'folder-new', ...await body(), position: 1, unreadCount: 0, settings: {} }; control.folders.push(folder); return json(folder, 201); } return json({ items: control.folders }); }
        if (url.pathname === '/api/folders/folder-new') { const folder = control.folders.find(item => item.id === 'folder-new'); Object.assign(folder, await body()); return json(folder); }
        if (url.pathname === '/api/tags') return json({ items: control.tags });
        if (url.pathname === '/api/articles') { let items = control.articles.filter(item => !control.listed || control.listed.includes(item.id)); if (url.searchParams.get('scope') === 'unread') items = items.filter(item => !item.read); const captured = structuredClone({ items, nextCursor: null, total: items.length }); if (control.holdList) { const hold = control.holdList; control.holdList = null; control.listCaptured = true; await hold.promise; } return json(captured); }
        if (url.pathname === '/api/articles/bulk-state') { const data = await body(); for (const item of control.articles) if (!data.ids || data.ids.includes(item.id)) { item.read = data.read; item.stateVersion++; } counts(); return json({ updated: control.articles.length }); }
        if (url.pathname === '/api/articles/save-url') return json(control.articles[0], 201);
        const state = control.articles.find(item => url.pathname === `/api/articles/${item.id}/state`);
        if (state) {
          const patch = await body(); const version = req.headers['if-match'];
          if (control.holdMutation) { const held = control.holdMutation; control.holdMutation = null; control.mutationHeld = true; await held.promise; }
          if (version !== `"${state.stateVersion}"`) return json({ error: { code: 'STATE_CONFLICT', message: '状态版本冲突' } }, 412);
          Object.assign(state, patch); state.stateVersion++; counts(); control.writes.push({ id: state.id, patch, version }); return json(state);
        }
        const item = control.articles.find(item => url.pathname === `/api/articles/${item.id}`);
        if (item) { const captured = structuredClone(item); if (control.holdDetail) { const hold = control.holdDetail; control.holdDetail = null; control.detailCaptured = true; await hold.promise; } return json(captured); }
        if (url.pathname.startsWith('/api/assets/') || url.pathname.startsWith('/api/feed-icons/')) { control.assets++; res.writeHead(url.pathname.includes('feed-icons') ? control.iconStatus : 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(await readFile(resolve(dist, 'icon-192.png'))); return; }
        return json({ error: { code: 'FIXTURE_ONLY', message: '未实现的测试路由' } }, 404);
      }
      if (url.pathname === '/original' || url.pathname === '/denied') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(url.pathname === '/denied' ? { 'X-Frame-Options': 'DENY' } : {}) }); res.end('<h1>沙箱原网页夹具</h1><script>top.location="/escaped"</script>'); return; }
      const file = !extname(url.pathname) ? resolve(dist, 'index.html') : resolve(dist, `.${url.pathname}`);
      if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(file); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }; res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`; control.articles.forEach(item => { item.url = `${url}/original`; });
  const origin = fixtureOrigin(server);
  return { url, control, route, routeErrors, ...origin, close: async () => { control.holdSession?.resolve(); control.holdLibrary?.resolve(); control.holdMutation?.resolve(); control.holdList?.resolve(); control.holdDetail?.resolve(); await origin.pauseOrigin(); } };
}

export function instrumentStorage() {
  window.__audit = { queueHold: false, imageHold: false, identityHold: false, authLockReads: 0, held: [], quota: false, bodyQuota: false, identityQuota: false, clearFailure: false };
  const wrap = (request, shouldHold) => {
    if (!shouldHold) return request;
    Object.defineProperty(request, 'onsuccess', { configurable: true, set(callback) { request.addEventListener('success', event => { window.__audit.held.push(() => callback.call(request, event)); }); } });
    return request;
  };
  const indexGetAll = IDBIndex.prototype.getAll;
  IDBIndex.prototype.getAll = function(query, ...args) { const hold = window.__audit.queueHold && Array.isArray(query) && query[1] === 'queue'; if (hold) window.__audit.queueHold = false; return wrap(indexGetAll.call(this, query, ...args), hold); };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function(key) { if (this.name === 'coordination' && key === 'lock') window.__audit.authLockReads++; const queue = window.__audit.queueHold && String(key).includes(':queue:'); if (queue) window.__audit.queueHold = false; return wrap(get.call(this, key), queue || window.__audit.imageHold && String(key).includes(':image:')); };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) { if (window.__audit.quota && value.key?.includes(':queue:') || window.__audit.bodyQuota && value.key?.includes(':article:') || window.__audit.identityQuota && value.key === 'identity') throw new DOMException('fixture quota', 'QuotaExceededError'); const hold = window.__audit.identityHold && value.key === 'identity'; if (hold) window.__audit.identityHold = false; return wrap(put.call(this, value, ...args), hold); };
  const clear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function() { if (window.__audit.clearFailure) throw new DOMException('fixture clear failure', 'UnknownError'); return clear.call(this); };
}
