// Frontend-only fixture test. This does NOT replace the real API/database integration suite.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const executablePath = process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
import { DEFAULT_SETTINGS } from '@feedink/shared';
import { emptyAnnotationDocument } from './audit-fixture.mjs';
import { fixtureOrigin, fixtureOffline } from './fixture-origin.mjs';
import { fixturePageErrors, verifyRuntimeErrorWitness } from './fixture-page-errors.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const artifacts = process.env.FEEDINK_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), 'feedink-web-smoke-'));
await mkdir(artifacts, { recursive: true });
let settings = { ...DEFAULT_SETTINGS };
const user = { id: 'alice', email: 'alice@example.test', name: '阅读者', isAdmin: true, isDemo: false, createdAt: '2026-01-01T00:00:00Z' };
let loggedIn = true;
const tag = { id: 'tag-one', name: '设计', color: '#861dd4', count: 0 };
const article = { stateVersion: 0, id: 'article-one', feedId: 'feed-one', subscriptionId: 'sub-one', feedTitle: 'FeedInk 原创阅读札记', title: '在安静的阅读里，留住自己的思考', url: 'https://example.test/reading', author: 'FeedInk', publishedAt: '2026-01-02T12:00:00Z', summary: '订阅不是为了读得更多，而是让值得阅读的文字回到身边。', thumbnailUrl: '/api/assets/image-one', read: false, saved: false, tags: [], wordCount: 1000, archivedAt: '2026-01-02T12:00:00Z', progress: 0, enclosures: [], contentHtml: '<p>持久存档把阅读的选择权交还给读者。即使源站改变，已经保存的文字和图片仍然在这里。</p><p>这是用于验证界面和离线缓存的原创测试内容，不来自第三方文章。</p><img src="/api/assets/image-one" alt="归档图片"><script>window.__feedinkXss=true</script><div class="toast">不可信样式类</div><img src="https://invalid.test/track" onerror="window.__feedinkXss=true"><p>今天，留一点时间给认真阅读。</p>', fulltextHtml: null, contentText: '持久存档把阅读的选择权交还给读者。', fetchedAt: '2026-01-02T12:00:00Z', contentHash: 'a'.repeat(64), images: [{ id: 'image-one', originalUrl: 'https://example.test/image.png', url: '/api/assets/image-one', status: 'cached', contentType: 'image/png' }], fulltextError: null };
const secondArticle = { ...article, id: 'article-two', title: '把阅读变成持续的小习惯', contentHtml: '<p>第二篇的正文，继续朗读与异步阅读切换的回归夹具。</p>', contentText: '第二篇的正文，继续朗读。', images: [], thumbnailUrl: null };
const articleRows = [article, secondArticle];
let releaseFulltext;
let fulltextRequested = false;
const subscriptions = [{ id: 'sub-one', feedId: 'feed-one', title: 'FeedInk 原创阅读札记', url: 'https://example.test/feed', siteUrl: 'https://example.test', description: '', iconUrl: null, folderId: 'folder-one', unreadCount: 1, totalCount: 1, settings: {}, status: 'ok', lastFetchedAt: '2026-01-02T12:00:00Z', lastError: null, position: 0 }];
const folders = [{ id: 'folder-one', name: '阅读与设计', unreadCount: 1, settings: {}, position: 0 }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    if (!loggedIn) { json({ error: { code: 'unauthorized', message: '请登录' } }, 401); return; }
    if (url.pathname === '/api/session') return json({ user, settings, csrfToken: 'fixture-csrf' });
    if (url.pathname === '/api/settings') { if (req.method === 'PATCH') { let body = ''; for await (const chunk of req) body += chunk; settings = { ...settings, ...JSON.parse(body) }; } return json(settings); }
    if (url.pathname === '/api/subscriptions') return json({ items: subscriptions });
    if (url.pathname === '/api/folders') return json({ items: folders });
    if (url.pathname === '/api/tags') return json({ items: [tag] });
    if (url.pathname === '/api/articles') return json({ items: articleRows, total: articleRows.length, nextCursor: null });
    const annotationArticle = articleRows.find(item => url.pathname === `/api/articles/${item.id}/annotations`);
    if (annotationArticle && req.method === 'GET') {
      const mode = url.searchParams.get('mode') || 'feed';
      if (mode !== 'feed' && (mode !== 'fulltext' || !annotationArticle.fulltextHtml)) return json({ error: { code: 'ANNOTATION_CONTEXT', message: '测试正文上下文不可用' } }, 409);
      const document = emptyAnnotationDocument(annotationArticle, mode);
      if (url.searchParams.has('contentHash') && url.searchParams.get('contentHash') !== document.contentHash) return json({ error: { code: 'ANNOTATION_CONTEXT', message: '测试历史上下文不可用' } }, 409);
      return json(document);
    }
    const matchedArticle = articleRows.find(item => url.pathname === `/api/articles/${item.id}`);
    if (matchedArticle) return json(matchedArticle);
    const stateArticle = articleRows.find(item => url.pathname === `/api/articles/${item.id}/state`);
    if (stateArticle) { if (req.headers['if-match'] !== `"${stateArticle.stateVersion}"`) return json({ error: { code: 'STATE_CONFLICT', message: 'state conflict' } }, 412); let body = ''; for await (const chunk of req) body += chunk; const patch = JSON.parse(body); Object.assign(stateArticle, patch); stateArticle.stateVersion++; if (patch.tagIds) stateArticle.tags = patch.tagIds.includes(tag.id) ? [tag] : []; return json(stateArticle); }
    if (url.pathname === '/api/articles/article-one/fulltext') { fulltextRequested = true; await new Promise(resolve => { releaseFulltext = resolve; }); article.fulltextHtml = '<p>第一篇提取全文，不得覆盖第二篇阅读。</p>'; return json(article); }
    if (url.pathname === '/api/assets/image-one') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(await readFile(resolve(dist, 'icon-192.png'))); return; }
    if (url.pathname === '/api/auth/logout') { loggedIn = false; res.writeHead(204); res.end(); return; }
    return json({ error: { code: 'fixture_missing', message: 'Fixture route intentionally not implemented' } }, 404);
  }
  const file = url.pathname === '/' || !extname(url.pathname) ? resolve(dist, 'index.html') : resolve(dist, `.${url.pathname}`);
  if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(file); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }; res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const origin = fixtureOrigin(server);
let browser;
let page;
let stage = 'launch';
const step = name => { stage = name; console.log(`SMOKE ${name}`); };
try {
  browser = await engine.launch({ executablePath, headless: true, timeout: 20_000 });
  await verifyRuntimeErrorWitness(browser);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = await fixturePageErrors(context, { browserName: engine.name(), ownedOrigin: url, apiPaths: ['/api/session', '/api/articles'], origin });
  const setOffline = fixtureOffline(context, origin);
  context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(15_000);
  // Deterministic browser-API seam: verifies continuous-play UI logic, not actual voice/audio quality.
  await context.addInitScript(() => {
    const speech = { spoken: [], latest: null, getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {}, pause() {}, resume() {}, speak(utterance) { this.latest = utterance; this.spoken.push(utterance.text); } };
    Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true });
    window.__feedinkSpeech = speech;
  });
  page = await context.newPage();
  step('reader and sanitization');
  await page.goto(url); await page.getByTestId('article-card').first().click();
  await page.getByTestId('reader-content').waitFor();
  assert.match(await page.getByTestId('reader-content').textContent(), /持久存档/);
  assert.equal(await page.locator('.article-content script').count(), 0); assert.equal(await page.locator('.article-content .toast').count(), 0); assert.equal(await page.evaluate(() => window.__feedinkXss), undefined);
  await expect(page.getByTestId('offline-status')).toContainText('离线可用');
  step('continuous speech across article fetch');
  await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
  await page.getByRole('dialog', { name: '阅读工具', exact: true }).getByRole('button', { name: '朗读', exact: true }).click();
  await page.getByLabel('连续朗读下一篇').check();
  await page.getByRole('button', { name: '开始朗读', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__feedinkSpeech.spoken.length)).toBe(1);
  await page.evaluate(() => window.__feedinkSpeech.latest.onend(new Event('end')));
  await expect(page.getByTestId('reader-content')).toContainText('第二篇的正文');
  await expect.poll(() => page.evaluate(() => window.__feedinkSpeech.spoken.at(-1))).toContain(secondArticle.title);
  // Article navigation dismisses the popup, but continuous speech remains mounted.
  await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
  await page.getByRole('dialog', { name: '阅读工具', exact: true }).getByRole('button', { name: '朗读', exact: true }).click();
  await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('article-card').filter({ hasText: article.title }).click();
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  step('late fulltext response cannot replace selected article');
  await page.getByRole('button', { name: '提取全文', exact: true }).click();
  await expect.poll(() => fulltextRequested).toBe(true);
  await page.getByTestId('article-card').filter({ hasText: secondArticle.title }).click();
  await expect(page.getByTestId('reader-content')).toContainText('第二篇的正文');
  releaseFulltext();
  await expect(page.getByRole('status').filter({ hasText: '全文与可用图片已持久归档' })).toBeVisible();
  await expect(page.getByTestId('reader-content')).toContainText('第二篇的正文');
  await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
  await page.getByRole('dialog', { name: '阅读工具', exact: true }).getByRole('button', { name: '正文与排版', exact: true }).click();
  assert.equal(await page.getByLabel('正文模式').inputValue(), 'feed');
  await page.keyboard.press('Escape');
  await page.getByTestId('article-card').filter({ hasText: article.title }).click();
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await page.locator('.reader-scroll').focus(); await page.keyboard.press('y'); await page.waitForFunction(() => document.querySelector('[aria-label="稍后阅读"]').getAttribute('aria-pressed') === 'true');
  await expect.poll(() => article.saved).toBe(true);
  step('service worker and cache readiness');
  await page.evaluate(async () => { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('service worker readiness exceeded 10s')), 10_000))]); }); await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.screenshot({ path: join(artifacts, 'reader-desktop.png') });
  step('offline body and image reload');
  await setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByTestId('reader-content').waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('.article-content img[alt="归档图片"]'); return image?.src.startsWith('data:image/') && image.complete && image.naturalWidth > 0; });
  await page.locator('.reader-scroll').focus(); await page.keyboard.press('y'); await page.waitForFunction(() => document.querySelector('[data-testid="offline-status"]').textContent.includes('待同步'));
  step('reconnect state replay');
  assert.equal(article.saved, true); await setOffline(false);
  await page.waitForFunction(() => !document.querySelector('[data-testid="offline-status"]').textContent.includes('待同步') && !document.querySelector('[data-testid="offline-status"]').textContent.includes('同步…'));
  await expect.poll(() => article.saved).toBe(false);
  step('tablet and phone geometry');
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByTestId('reader-content').isVisible(), true);
    await page.screenshot({ path: join(artifacts, `reader-${width}.png`) });
  }
  step('scoped CSS settings');
  await page.goto(`${url}/settings/interface/article-contents?article=article-one`);
  await page.getByLabel('自定义正文 CSS').fill('@import "https://invalid.test/steal";');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('自定义 CSS 不允许');
  await expect(page.getByRole('alert')).toBeVisible(); assert.equal(settings.customCss, '');
  await page.getByLabel('自定义正文 CSS').fill('p { letter-spacing: 1px; }');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => settings.customCss).toBe('p { letter-spacing: 1px; }');
  await page.getByRole('button', { name: '关闭对话框' }).click();
  step('e-ink');
  settings = { ...settings, theme: 'eink', fontSize: 22 };
  await page.reload(); await page.getByTestId('reader-content').waitFor();
  const style = await page.getByTestId('reader-content').evaluate(element => { const style = getComputedStyle(element); return [style.color, style.fontSize, style.animationName, style.boxShadow]; });
  assert.deepEqual(style, ['rgb(0, 0, 0)', '22px', 'none', 'none']);
  step('logout and purge');
  await page.goto(`${url}/settings`); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('heading', { name: '欢迎回来' }).waitFor();
  await setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: '欢迎回来' }).waitFor(); assert.equal(await page.getByTestId('reader-content').count(), 0);
  await errors.assertClean(); await context.close();
  console.log('PASS browser fixture: sanitized reader, desktop/tablet/phone no overflow, offline body+image reload, queued state reconnect, continuous TTS browser-API seam, late fulltext isolation, scoped CSS success/rejection, e-ink, logout purge; no unexpected page errors or runtime errors.');
} catch (error) {
  console.error(`FAIL browser fixture at stage: ${stage}`);
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText({ timeout: 2_000 }).catch(() => 'Unable to inspect page'));
    console.error('active element:', await page.evaluate(() => document.activeElement?.outerHTML).catch(() => 'unavailable'));
    await page.screenshot({ path: join(artifacts, 'failure.png'), timeout: 3_000 }).catch(() => {});
  }
  throw error;
} finally { await browser?.close(); await origin.pauseOrigin(); }
