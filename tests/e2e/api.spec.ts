import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { baseURL, csrf, detail, register, resetUpstream, subscribe, upstream, waitForArticles, articles } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

test('sessions enforce CSRF, foreign-origin rejection and tenant isolation', async ({ request, playwright }) => {
  const owner = await register(request);
  const sub = await subscribe(request, owner);
  const page = await waitForArticles(request, sub.id, 2);
  const id = page.items[0]!.id;
  expect((await request.patch(`/api/articles/${id}/state`, { data: { saved: true } })).status()).toBe(403);
  expect((await request.patch(`/api/articles/${id}/state`, { headers: { ...csrf(owner), Origin: 'https://attacker.example' }, data: { saved: true } })).status()).toBe(403);
  const other = await playwright.request.newContext({ baseURL });
  try {
    const otherUser = await register(other);
    for (const path of [`/api/articles/${id}`, `/api/subscriptions/${sub.id}`]) {
      const response = path.includes('subscriptions')
        ? await other.patch(path, { headers: csrf(otherUser), data: { title: 'intrusion' } })
        : await other.get(path);
      expect([403, 404]).toContain(response.status());
    }
    expect((await other.patch(`/api/articles/${id}/state`, { headers: csrf(otherUser), data: { saved: true } })).status()).toBeGreaterThanOrEqual(400);
    expect((await articles(other)).total).toBe(0);
    expect((await other.get('/api/admin/users')).status()).toBe(403);
    const owned = await detail(request, id);
    for (const image of owned.images) expect([403, 404]).toContain((await other.get(image.url)).status());
  } finally { await other.dispose(); }
  expect((await request.post('/api/auth/logout', { headers: csrf(owner) })).status()).toBe(204);
  expect((await request.get('/api/session')).status()).toBe(401);
  expect((await request.get(`/api/articles/${id}`)).status()).toBe(401);
});

test('RSS, Atom, JSON Feed and HTML discovery ingest actual articles', async ({ request }) => {
  const session = await register(request);
  const discover = await request.get('/api/discover', { params: { q: `${upstream}/discover` } });
  expect(discover.ok(), await discover.text()).toBeTruthy();
  expect((await discover.json()).feeds.some((f: { url: string }) => f.url === `${upstream}/feed.xml`)).toBeTruthy();
  for (const [path, text] of [['/feed.xml', '墨水屏'], ['/atom.xml', 'Atom'], ['/feed.json', 'JSON Feed']]) {
    const sub = await subscribe(request, session, path);
    const list = await waitForArticles(request, sub.id);
    expect(list.items.some(item => item.title.includes(text!))).toBeTruthy();
  }
});

test('archive retains body and anti-hotlink images when origin and subscription disappear', async ({ request }) => {
  const session = await register(request);
  const sub = await subscribe(request, session);
  const list = await waitForArticles(request, sub.id, 2);
  const id = list.items.find(item => item.title.includes('墨水屏'))!.id;
  await expect.poll(async () => {
    const a = await detail(request, id);
    return a.images.length >= 2 && a.images.every(image => image.status === 'cached');
  }, { timeout: 45_000 }).toBe(true);
  const original = await detail(request, id);
  expect(original.contentHtml).toContain('持久存档');
  expect(original.contentHtml).not.toMatch(/<script|onerror\s*=|href\s*=\s*["']javascript:/i);
  expect(original.contentHash).toMatch(/^[a-f0-9]{64}$/i);
  const protectedImage = original.images.find(image => image.originalUrl.includes('/protected-image.png'))!;
  expect(protectedImage, 'data-src anti-hotlink image was captured').toBeTruthy();
  const beforeBytes = await (await request.get(protectedImage.url)).body();
  expect(beforeBytes.subarray(1, 4).toString()).toBe('PNG');
  await resetUpstream(request, { version: 2 });
  const refreshed = await request.post(`/api/subscriptions/${sub.id}/refresh`, { headers: csrf(session) });
  expect(refreshed.ok(), await refreshed.text()).toBeTruthy();
  expect((await detail(request, id)).contentHash).toBe(original.contentHash);
  await resetUpstream(request, { offline: true });
  expect((await request.delete(`/api/subscriptions/${sub.id}`, { headers: csrf(session) })).status()).toBe(204);
  const archived = await detail(request, id);
  expect(archived.contentHtml).toBe(original.contentHtml);
  const cached = await request.get(protectedImage.url);
  expect(cached.ok(), await cached.text()).toBeTruthy();
  expect(createHash('sha256').update(await cached.body()).digest('hex')).toBe(createHash('sha256').update(beforeBytes).digest('hex'));
  const all = await request.get('/api/articles', { params: { scope: 'archive' } });
  expect((await all.json()).items.some((item: { id: string }) => item.id === id)).toBeTruthy();
});

test('folders, tags, search, state, stable sorting and OPML round-trip are functional', async ({ request, playwright }) => {
  const session = await register(request);
  const folderResponse = await request.post('/api/folders', { headers: csrf(session), data: { name: '阅读 & 思考' } });
  expect(folderResponse.status()).toBe(201);
  const folder = await folderResponse.json();
  const sub = await subscribe(request, session);
  expect((await request.patch(`/api/subscriptions/${sub.id}`, { headers: csrf(session), data: { folderId: folder.id, title: '长期阅读', settings: { view: 'list', pinned: true } } })).ok()).toBeTruthy();
  const list = await waitForArticles(request, sub.id, 2);
  const tagResponse = await request.post('/api/tags', { headers: csrf(session), data: { name: '值得重读', color: '#861dd4' } });
  const tag = await tagResponse.json();
  expect(tagResponse.status()).toBe(201);
  const state = await request.patch(`/api/articles/${list.items[0]!.id}/state`, { headers: csrf(session), data: { saved: true, read: true, tagIds: [tag.id], progress: 0.5 } });
  expect(state.ok(), await state.text()).toBeTruthy();
  const saved = await request.get('/api/articles', { params: { scope: 'saved', tagId: tag.id } });
  expect((await saved.json()).items[0].id).toBe(list.items[0]!.id);
  const searched = await request.get('/api/articles', { params: { q: '墨水屏' } });
  expect((await searched.json()).items.some((item: { title: string }) => item.title.includes('墨水屏'))).toBeTruthy();
  const first = await request.get('/api/articles', { params: { subscriptionId: sub.id, limit: 1 } });
  const firstPage = await first.json();
  expect(firstPage.nextCursor).toBeTruthy();
  const next = await request.get('/api/articles', { params: { subscriptionId: sub.id, limit: 1, cursor: firstPage.nextCursor } });
  expect((await next.json()).items[0].id).not.toBe(firstPage.items[0].id);
  const opml = await request.get('/api/export/opml');
  expect(opml.ok()).toBeTruthy();
  expect(await opml.text()).toContain('&amp;');
  const other = await playwright.request.newContext({ baseURL });
  try {
    const importedUser = await register(other);
    const imported = await other.post('/api/import/opml', { headers: csrf(importedUser), data: { content: await opml.text() } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    expect((await imported.json()).imported).toBeGreaterThanOrEqual(1);
    expect((await (await other.get('/api/folders')).json()).items.some((item: { name: string }) => item.name === '阅读 & 思考')).toBeTruthy();
  } finally { await other.dispose(); }
});

test('full-text capture, portable archive restore and valid ebook download retain owned content', async ({ request, playwright }) => {
  const session = await register(request);
  const sub = await subscribe(request, session);
  const page = await waitForArticles(request, sub.id, 2);
  const id = page.items[0]!.id;
  const full = await request.post(`/api/articles/${id}/fulltext`, { headers: csrf(session) });
  expect(full.ok(), await full.text()).toBeTruthy();
  const fullArticle = await full.json();
  expect(fullArticle.fulltextHtml).toContain('阅读不是追逐更新');
  expect(fullArticle.fulltextHtml).not.toContain('这是不应混入正文的导航');
  const ebook = await request.post('/api/ebooks', { headers: csrf(session), data: { articleIds: [id], title: 'FeedInk 阅读合集' } });
  expect(ebook.status(), await ebook.text()).toBe(201);
  const book = await ebook.json();
  const download = await request.get(book.downloadUrl);
  expect(download.ok()).toBeTruthy();
  expect(download.headers()['content-type']).toContain('application/epub+zip');
  const epubBytes = await download.body();
  expect(epubBytes.subarray(0, 2).toString()).toBe('PK');
  const epub = unzipSync(epubBytes);
  expect(strFromU8(epub['mimetype']!)).toBe('application/epub+zip');
  const container = strFromU8(epub['META-INF/container.xml']!);
  expect(container).toContain('urn:oasis:names:tc:opendocument:xmlns:container');
  const packagePath = /full-path=["']([^"']+)["']/.exec(container)?.[1];
  expect(packagePath).toBeTruthy();
  const packageXml = strFromU8(epub[packagePath!]!);
  expect(packageXml).toContain('http://www.idpf.org/2007/opf');
  expect(packageXml).toContain('<spine');
  expect(Object.entries(epub).some(([name, bytes]) => /\.x?html$/.test(name) && strFromU8(bytes).includes('阅读不是追逐更新'))).toBeTruthy();
  const archive = await request.get('/api/export/archive');
  expect(archive.ok(), await archive.text()).toBeTruthy();
  const zip = await archive.body();
  expect(zip.subarray(0, 2).toString()).toBe('PK');
  await resetUpstream(request, { offline: true });
  const other = await playwright.request.newContext({ baseURL });
  try {
    const otherUser = await register(other);
    const restored = await other.post('/api/import/archive', { headers: csrf(otherUser), multipart: { file: { name: 'feedink-archive.zip', mimeType: 'application/zip', buffer: zip } } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
    expect((await restored.json()).imported).toBeGreaterThanOrEqual(2);
    const restoredArticles = await articles(other);
    const restoredDetail = await detail(other, restoredArticles.items.find(item => item.title === fullArticle.title)!.id);
    expect(restoredDetail.fulltextHtml).toContain('阅读不是追逐更新');
    for (const image of restoredDetail.images.filter(image => image.status === 'cached')) expect((await other.get(image.url)).ok()).toBeTruthy();
  } finally { await other.dispose(); }
});

test('upstream boundaries reject metadata, protocols, redirects and malformed inputs', async ({ request }) => {
  const session = await register(request);
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:169.254.169.254]/', 'file:///etc/passwd', 'http://user:pass@example.com/feed.xml', `${upstream}/redirect-private`, `${upstream}/xxe.xml`]) {
    const response = await request.post('/api/subscriptions', { headers: csrf(session), data: { url } });
    expect(response.status(), `unsafe upstream accepted: ${url}: ${await response.text()}`).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('root:x:');
  }
  const settings = await request.patch('/api/settings', { headers: csrf(session), data: { fontSize: -500, contentWidth: 0 } });
  expect(settings.status()).toBe(400);
  const badArchive = await request.post('/api/import/archive', { headers: csrf(session), multipart: { file: { name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('not a ZIP') } } });
  expect(badArchive.status()).toBeGreaterThanOrEqual(400);
  const traversal = zipSync({ '../outside.txt': strToU8('must never be written') });
  const unsafeArchive = await request.post('/api/import/archive', { headers: csrf(session), multipart: { file: { name: 'traversal.zip', mimeType: 'application/zip', buffer: Buffer.from(traversal) } } });
  expect(unsafeArchive.status()).toBeGreaterThanOrEqual(400);
  const me = await request.get('/api/session');
  expect(me.ok()).toBeTruthy();
  const serialized = await me.text();
  expect(serialized).not.toMatch(/passwordHash|password_hash|session_token/);
});
