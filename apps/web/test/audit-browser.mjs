const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const executablePath = process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFixture, deferred, instrumentStorage } from './audit-fixture.mjs';
import { fixtureOffline } from './fixture-origin.mjs';
import { fixturePageErrors, verifyRuntimeErrorWitness } from './fixture-page-errors.mjs';

const artifacts = process.env.FEEDINK_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), 'feedink-audit-')); await mkdir(artifacts, { recursive: true });
const browser = await engine.launch({ executablePath, headless: true, timeout: 20_000 });
let passed = 0;
async function scenario(name, action) {
  console.log(`AUDIT ${name}`); const fixture = await auditFixture(); const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(15_000); await context.addInitScript(instrumentStorage);
  const errors = await fixturePageErrors(context, { browserName: engine.name(), ownedOrigin: fixture.url, apiPaths: ['/api/session', '/api/articles', '/api/subscriptions', '/api/folders', '/api/tags'], fixtureDocumentPaths: ['/original', '/denied'], origin: fixture });
  const page = await context.newPage();
  try { await action({ ...fixture, page, context, setOffline: fixtureOffline(context, fixture) }); await errors.assertClean(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'unavailable')); await page.screenshot({ path: join(artifacts, `failure-${passed}.png`), timeout: 3000 }).catch(() => {}); throw error; }
  finally { await context.close(); await fixture.close(); }
}
const open = async (page, url, id = 'one') => { await page.goto(`${url}/?article=${id}`); await expect(page.getByTestId('reader-content')).toBeVisible(); };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settledRequests = async page => {
  await page.waitForFunction(() => window.__fixtureRuntimeWitness.pendingRequestCount() === 0);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => window.__fixtureRuntimeWitness.pendingRequestCount() === 0);
};
try {
  await verifyRuntimeErrorWitness(browser);
  await scenario('03 native keyboard +16 owned source icons', async ({ page, url, control, context }) => {
    // The shared /original intentionally escapes top.location in the sandbox
    // scenario below. Test keyboard activation against a scriptless original
    // site instead, outside the application's SW scope. This avoids racing an
    // escape into a second FeedInk app against popup.close(); no app errors are
    // waived. The sandbox scenario retains its real escape script/assertions.
    const originalURL = 'https://original.example.test/reading';
    control.articles[0].url = originalURL;
    await context.route(originalURL, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>原文链接键盘夹具</h1>' }));
    await open(page, url);
    const icon = page.locator('.article-source img'); await expect(icon).toHaveAttribute('src', control.subscriptions[0].iconUrl); await expect.poll(() => icon.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    const saved = page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }); await saved.focus(); await page.keyboard.press('Space'); await expect.poll(() => control.articles[0].saved).toBe(true);
    await saved.focus(); await page.keyboard.press('Enter'); await expect.poll(() => control.articles[0].saved).toBe(false);
    const popupPromise = page.waitForEvent('popup'); await page.locator('.article-document>h1 a').focus(); await page.keyboard.press('Enter'); const popup = await popupPromise; await expect(popup).toHaveURL(originalURL); await expect(popup.getByRole('heading')).toHaveText('原文链接键盘夹具'); await popup.close();
    await page.getByRole('button', { name: '返回', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page).not.toHaveURL(/article=/);
    await page.getByTestId('article-card').first().focus(); await page.keyboard.press('Enter'); await expect(page.getByTestId('reader-content')).toBeVisible();
    control.subscriptions[0].iconUrl = 'https://untrusted.invalid/tracker.png'; let tracked = false; page.on('request', request => { if (request.url().includes('untrusted.invalid')) tracked = true; }); await page.reload(); await expect(page.getByTestId('reader-content')).toBeVisible(); await settle(page); assert.equal(tracked, false); assert.equal(await page.locator('.article-source img').count(), 0); await expect(page.locator('.article-source .source-icon svg')).toBeVisible();
  });
  await scenario('05 initial pending-read selection race', async ({ page, url }) => {
    await page.goto(url); await expect(page.getByTestId('article-card')).toHaveCount(2); await expect(page.getByTestId('offline-status')).toContainText('已连接');
    await page.evaluate(() => { window.__audit.queueHold = true; }); await page.getByTestId('article-card').filter({ hasText: '第一篇' }).click(); await page.waitForFunction(() => window.__audit.held.length > 0);
    await page.getByTestId('article-card').filter({ hasText: '第二篇' }).click(); await expect(page.getByTestId('reader-content')).toContainText('第二篇独立');
    await page.evaluate(() => window.__audit.held.splice(0).forEach(release => release())); await settle(page); await expect(page.getByTestId('reader-content')).toContainText('第二篇独立'); await expect(page).toHaveURL(/article=two/);
  });
  await scenario('04 quota online/offline writes and failed-purge server revocation', async ({ page, url, control, setOffline }) => {
    control.articles[0].read = false; await page.goto(url); await expect(page.getByTestId('article-card')).toHaveCount(2);
    await page.evaluate(() => { window.__audit.quota = true; window.__audit.bodyQuota = true; }); await page.getByTestId('article-card').first().click(); await expect(page.getByTestId('reader-content')).toBeVisible(); await expect.poll(() => control.articles[0].read).toBe(true);
    const saved = page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }); await saved.click(); await expect.poll(() => control.articles[0].saved).toBe(true); await expect(page.getByRole('alert')).toContainText('存储');
    await setOffline(true); const writes = control.writes.length; await saved.click(); await expect(page.getByRole('alert')).toContainText('quota'); await expect(saved).toHaveAttribute('aria-pressed', 'true'); assert.equal(control.writes.length, writes);
    await setOffline(false);
    // This case tests quota recovery, not cancellation by a full-document navigation.
    // Wait for the actual native GETs as well as protocol-visible requests.
    await expect(page.getByTestId('offline-status')).not.toContainText('正在同步');
    await settledRequests(page);
    await page.goto(`${url}/share`); await page.getByLabel('网页地址').fill(`${url}/original`); await page.evaluate(() => { window.__audit.bodyQuota = true; }); await page.getByRole('button', { name: '保存到稍后阅读', exact: true }).click(); await expect(page).toHaveURL(/scope=saved&article=one/); await expect(page.getByTestId('reader-content')).toBeVisible();
    await settledRequests(page);
    await page.goto(`${url}/settings`); await page.evaluate(() => { window.__audit.clearFailure = true; }); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect.poll(() => control.logouts).toBe(1); await expect(page.getByTestId('app-shell')).toHaveCount(0); assert.equal(await page.evaluate(() => localStorage.getItem('feedink-private-purge-pending')), '1');
  });
  await scenario('01+04 failed new-account cache activation never restores old private data offline', async ({ page, url, control, setOffline }) => {
    await open(page, url); await expect(page.getByTestId('offline-status')).toContainText('离线可用');
    await page.goto(`${url}/settings`); await page.evaluate(() => { window.__audit.clearFailure = true; window.__audit.identityQuota = true; }); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect.poll(() => control.logouts).toBe(1);
    await page.getByRole('button', { name: '创建账号', exact: true }).click(); await page.getByLabel('昵称').fill('bob'); await page.getByLabel('邮箱', { exact: true }).fill('bob@example.test'); await page.getByLabel('密码', { exact: true }).fill('safe-password-123'); await page.getByRole('button', { name: '注册并开始阅读', exact: true }).click(); await expect(page.getByTestId('app-shell')).toBeVisible();
    assert.equal(control.user.id, 'bob'); assert.equal(await page.evaluate(() => localStorage.getItem('feedink-private-purge-pending')), '1');
    await page.getByTestId('article-card').first().click(); await expect(page.getByTestId('reader-content')).toBeVisible(); await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click(); await expect.poll(() => control.articles[0].saved).toBe(true);
    await setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible(); assert.equal(await page.getByTestId('reader-content').count(), 0);
  });
  await scenario('06 delayed offline AssetImage +07 readiness invalidation', async ({ page, url, setOffline }) => {
    await open(page, url); await expect(page.getByTestId('offline-status')).toContainText('离线可用');
    await setOffline(true); await page.evaluate(() => { window.__audit.imageHold = true; }); await page.locator('.article-content img[alt="归档图片"]').click(); await page.waitForFunction(() => window.__audit.held.length > 0); assert.equal(await page.locator('.image-preview img').count(), 0);
    await page.evaluate(() => { window.__audit.imageHold = false; window.__audit.held.splice(0).forEach(release => release()); }); const image = page.locator('.image-preview img'); await expect.poll(() => image.evaluate(image => image.src.startsWith('data:image/') && image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '关闭对话框' }).focus(); await page.keyboard.press('Enter'); await expect(page.locator('dialog')).toHaveCount(0);
    await setOffline(false); await settledRequests(page); await page.goto(`${url}/settings?article=one`); await expect(page.getByTestId('offline-status')).toContainText('离线可用'); await page.getByRole('button', { name: '离线与安装', exact: true }).click(); await page.getByRole('button', { name: '清理正文缓存', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '此设备的正文与图片缓存已清除' })).toBeVisible(); await expect(page.getByTestId('offline-status')).not.toContainText('离线可用');
  });
  await scenario('10 delayed deep-link preferences +15 sandbox/original fallback', async ({ page, url, control, setOffline }) => {
    control.subscriptions[0].settings.articleMode = 'webpage'; const held = deferred(); control.holdLibrary = held; await page.goto(`${url}/?article=one`); await expect(page.getByTestId('app-shell')).toBeVisible(); assert.equal(await page.locator('iframe').count(), 0);
    held.resolve(); control.holdLibrary = null; await expect(page.locator('iframe.original-frame')).toBeVisible(); await expect(page.locator('iframe')).toHaveAttribute('sandbox', ''); await expect(page.frameLocator('iframe').locator('h1')).toHaveText('沙箱原网页夹具'); await expect(page).toHaveURL(/article=one/);
    await expect(page.getByRole('link', { name: '在新标签页打开原文' })).toHaveAttribute('href', `${url}/original`);
    await page.getByLabel('正文模式').selectOption('feed'); await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click(); await expect.poll(() => control.articles[0].saved).toBe(true); assert.equal(await page.getByLabel('正文模式').inputValue(), 'feed');
    control.articles[0].url = `${url}/denied`; await page.reload(); await expect(page.locator('iframe')).toHaveAttribute('src', `${url}/denied`); await expect(page.getByRole('link', { name: '在新标签页打开原文' })).toBeVisible();
    await setOffline(true); await expect(page.locator('iframe')).toHaveCount(0); await expect(page.getByRole('status').filter({ hasText: '离线时原网页不可用' })).toBeVisible();
  });
  await scenario('11 new folder preferences persist through documented POST then PATCH', async ({ page, url, control }) => {
    await page.goto(url); await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await page.getByLabel('名称', { exact: true }).fill('独立偏好'); await page.getByLabel('列表样式', { exact: true }).selectOption('grid'); await page.getByLabel('排序', { exact: true }).selectOption('oldest'); await page.getByLabel('未读筛选', { exact: true }).selectOption('true'); await page.getByLabel('文章模式', { exact: true }).selectOption('webpage'); await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => control.folders.find(folder => folder.id === 'folder-new')?.settings).toEqual({ view: 'grid', sort: 'oldest', unreadOnly: true, articleMode: 'webpage' });
  });
  await scenario('12 bulk read includes cached articles outside the loaded page and persists counts', async ({ page, url, control, setOffline }) => {
    control.articles.forEach(item => { item.read = false; }); control.subscriptions[0].unreadCount = 2; control.folders[0].unreadCount = 2;
    for (const id of ['two', 'one']) {
      await open(page, url, id); await expect(page.getByTestId('offline-status')).toContainText('离线可用');
      await page.getByTestId('reader').getByRole('button', { name: '标记为未读', exact: true }).click();
      await expect.poll(() => control.articles.find(item => item.id === id).read).toBe(false);
    }
    control.listed = ['one']; await page.goto(url); await expect(page.getByTestId('article-card')).toHaveCount(1);
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
    await expect.poll(() => control.articles.every(item => item.read)).toBe(true); await expect(page.getByRole('status').filter({ hasText: '已标记为已读' })).toBeVisible();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller)); await setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('article-card')).toHaveCount(2); assert.equal(await page.locator('[data-testid="article-card"][data-unread="true"]').count(), 0);
    const counts = await page.evaluate(() => new Promise((resolve, reject) => { const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => { const read = open.result.transaction('rows').objectStore('rows').get('alice:library:'); read.onsuccess = () => { resolve([read.result.value.subscriptions[0].unreadCount, read.result.value.folders[0].unreadCount]); open.result.close(); }; read.onerror = () => reject(read.error); }; })); assert.deepEqual(counts, [0, 0]);
  });
  await scenario('09 tablet 768 and 820 list cards remain actual pointer hit targets', async ({ page, url }) => {
    for (const width of [768, 820]) {
      await page.setViewportSize({ width, height: 1180 }); await page.goto(url); const card = page.getByTestId('article-card').first(); await expect(card).toBeVisible();
      assert.equal(await card.evaluate(button => { const box = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true);
      const panes = await page.evaluate(() => { const list = document.querySelector('.list-pane').getBoundingClientRect(); const reader = document.querySelector('.reader-pane').getBoundingClientRect(); return { width: list.width, overlap: reader.x < list.right - 1 }; }); assert.ok(panes.width >= 270); assert.equal(panes.overlap, false);
      await card.click(); await expect(page.getByTestId('reader-content')).toContainText('第一篇持久存档');
      await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click();
      await page.screenshot({ path: join(artifacts, `audit-tablet-${width}.png`) });
    }
  });
  await scenario('09 essential toolbar bounds at 1100 oversized panes and 320 e-ink', async ({ page, url, control }) => {
    control.settings.sidebarWidth = 360; control.settings.listWidth = 600; await page.setViewportSize({ width: 1100, height: 800 }); await open(page, url);
    const check = async () => assert.deepEqual(await page.locator('.reader-toolbar').evaluate(toolbar => [...toolbar.querySelectorAll('button')].filter(button => getComputedStyle(button).display !== 'none').filter(button => { const box = button.getBoundingClientRect(); const parent = toolbar.getBoundingClientRect(); return box.left < parent.left || box.right > parent.right + 0.5 || box.right > innerWidth || !button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }).map(button => button.getAttribute('aria-label'))), []);
    await check(); control.settings.theme = 'eink'; await page.setViewportSize({ width: 320, height: 844 }); await page.reload(); await expect(page.getByTestId('reader-content')).toBeVisible(); await check(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: join(artifacts, 'audit-eink-320.png') });
  });
  await scenario('02 two real browser tabs serialize snapshot/send/ack with newer queued intent', async ({ page, url, context, control }) => {
    await open(page, url); await expect(page.getByTestId('offline-status')).toContainText('离线可用'); const second = await context.newPage(); await open(second, url); await expect(second.getByTestId('offline-status')).toContainText('离线可用');
    const held = deferred(); control.holdMutation = held; await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click(); await expect.poll(() => control.mutationHeld).toBe(true);
    const saved = second.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }); await saved.click(); await expect(saved).toHaveAttribute('aria-pressed', 'true'); await saved.click(); await expect(saved).toHaveAttribute('aria-pressed', 'false'); held.resolve();
    await expect.poll(() => control.writes.length).toBe(2); assert.equal(control.articles[0].saved, false); await expect(second.getByTestId('offline-status')).not.toContainText('待同步'); assert.deepEqual(control.writes.map(item => item.patch.saved), [true, false]); await second.close();
  });
  await scenario('14 offline logout retries on reconnect without reload', async ({ page, url, control, setOffline }) => {
    await page.goto(`${url}/settings`); await page.getByRole('button', { name: '退出登录', exact: true }).waitFor(); await setOffline(true); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(page.getByTestId('app-shell')).toHaveCount(0); assert.equal(control.logouts, 0);
    await setOffline(false); await expect.poll(() => control.logouts).toBe(1); assert.equal(await page.evaluate(() => localStorage.getItem('feedink-logout-pending')), null);
  });
  await scenario('01+14 newer login cancels a delayed reconnect-logout session check', async ({ page, url, control, setOffline }) => {
    await page.goto(`${url}/settings`); await page.getByRole('button', { name: '退出登录', exact: true }).waitFor(); await setOffline(true); await page.getByRole('button', { name: '退出登录', exact: true }).click(); const held = deferred(); control.holdSession = held; const calls = control.sessionCalls; await setOffline(false); await expect.poll(() => control.sessionCalls).toBeGreaterThan(calls);
    await page.getByRole('button', { name: '创建账号', exact: true }).click(); await page.getByLabel('昵称').fill('bob'); await page.getByLabel('邮箱', { exact: true }).fill('bob@example.test'); await page.getByLabel('密码', { exact: true }).fill('safe-password-123'); await page.getByRole('button', { name: '注册并开始阅读', exact: true }).click(); held.resolve(); control.holdSession = null;
    await expect(page.getByTestId('app-shell')).toBeVisible(); assert.equal(control.user.id, 'bob'); assert.equal(control.logouts, 0); assert.equal(await page.evaluate(() => localStorage.getItem('feedink-logout-pending')), null);
  });
  console.log(`PASS ${passed} deterministic browser audit scenarios (HTTP fixture, not real backend acceptance).`);
} finally { await browser.close(); }
