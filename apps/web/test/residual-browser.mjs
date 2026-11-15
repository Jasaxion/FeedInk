// Release regressions use isolated HTTP/IDB seams, not real-backend certification.
import assert from 'node:assert/strict';
import { auditFixture, deferred, instrumentStorage } from './audit-fixture.mjs';
const { chromium, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true, timeout: 20_000 });
const failures = [];
async function scenario(name, action) {
  if (process.env.FEEDINK_RESIDUAL_FILTER && !name.startsWith(process.env.FEEDINK_RESIDUAL_FILTER)) return;
  const fixture = await auditFixture(); const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(12000); await context.addInitScript(instrumentStorage); const page = await context.newPage();
  try { await action({ ...fixture, page, context }); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); await fixture.close(); }
}
const open = async (page, url, id = 'one') => { await page.goto(`${url}/?article=${id}`); await expect(page.getByTestId('reader-content')).toBeVisible(); await expect(page.getByTestId('offline-status')).toContainText('离线可用'); };
const queueEmpty = page => page.evaluate(() => new Promise((resolve, reject) => { const open = indexedDB.open('feedink-private-v1'); open.onerror = () => reject(open.error); open.onsuccess = () => { const read = open.result.transaction('rows').objectStore('rows').get('alice:queue:one'); read.onsuccess = () => { resolve(!read.result); open.result.close(); }; }; }));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await scenario('CI nested discovery input has an exact accessible label and submits discovery', async ({ page, url, control }) => {
    await page.goto(`${url}/discover`); await page.getByLabel('网址或关键字', { exact: true }).fill('technology'); await page.getByRole('button', { name: '查找', exact: true }).click();
    await expect.poll(() => control.discoveryQueries).toEqual(['technology']); await expect(page.getByRole('heading', { name: '发现结果订阅', exact: true })).toBeVisible();
    await page.goto(`${url}/?article=one`); await page.getByRole('button', { name: '朗读', exact: true }).click(); await expect(page.getByLabel('速度', { exact: true })).toHaveAttribute('type', 'range');
  });
  await scenario('R1 ordinary full settings save preserves both cached articles and images', async ({ page, context, url }) => {
    await open(page, url, 'two'); await open(page, url);
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('字号 (px)', { exact: true }).fill('21'); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '设置已保存并同步' })).toBeVisible();
    await page.getByRole('button', { name: '关闭对话框' }).click(); await context.setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('reader-content')).toContainText('第一篇'); await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(page.getByTestId('article-card')).toHaveCount(2); await page.getByTestId('article-card').filter({ hasText: '第二篇' }).click(); await expect.poll(() => page.locator('.article-content img[alt="归档图片"]').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  });
  await scenario('R2 reconnect credentials survive two SPA metadata saves with real CSRF enforcement', async ({ page, context, url, control }) => {
    await open(page, url); await context.setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('reader-content')).toBeVisible(); await context.setOffline(false); await expect(page.getByTestId('offline-status')).not.toContainText('离线 ·'); await expect(page.getByTestId('offline-status')).not.toContainText('正在同步');
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('字号 (px)', { exact: true }).fill('20'); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect.poll(() => control.settings.fontSize).toBe(20);
    await page.getByLabel('字号 (px)', { exact: true }).fill('22'); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect.poll(() => control.settings.fontSize).toBe(22); assert.equal(control.rejectedCsrf, 0);
  });
  await scenario('R3 full login handoff holds the shared lock against another tab pending logout', async ({ page, context, url, control }) => {
    await page.goto(`${url}/settings`); await page.getByRole('button', { name: '退出登录', exact: true }).waitFor(); await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller)); await context.setOffline(true); await page.getByRole('button', { name: '退出登录', exact: true }).click(); const bob = await context.newPage(); await bob.goto(`${url}/register`); await bob.getByLabel('昵称').waitFor();
    for (const tab of [page, bob]) await tab.evaluate(() => window.addEventListener('online', event => event.stopImmediatePropagation(), { capture: true }));
    await context.setOffline(false); await bob.getByLabel('昵称').fill('bob'); await bob.getByLabel('邮箱', { exact: true }).fill('bob@example.test'); await bob.getByLabel('密码', { exact: true }).fill(crypto.randomUUID());
    // Recreate the persisted old intent after setup focus events, immediately before the held handoff.
    await page.evaluate(() => localStorage.setItem('feedink-logout-pending', JSON.stringify({ id: crypto.randomUUID(), owner: 'alice' }))); const priorLogouts = control.logouts;
    await bob.evaluate(() => { window.__audit.identityHold = true; }); await bob.getByRole('button', { name: '注册并开始阅读', exact: true }).click(); await bob.waitForFunction(() => window.__audit.held.length > 0); assert.equal(control.user.id, 'bob');
    const held = await bob.evaluate(async () => (await navigator.locks.query()).held.some(lock => lock.name === 'feedink-auth-network')); assert.equal(held, true, 'login must retain the lock during cache activation and identity publication');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'feedink-auth-network'))).toBe(true);
    await bob.evaluate(() => window.__audit.held.splice(0).forEach(release => release())); await expect(bob.getByTestId('app-shell')).toBeVisible(); await page.evaluate(() => navigator.locks.request('feedink-auth-network', () => {})); assert.equal(control.logouts, priorLogouts); assert.equal(control.loggedIn, true); assert.equal(await bob.evaluate(() => localStorage.getItem('feedink-logout-pending')), null);
  });
  await scenario('R3 no-WebLocks same-owner handoff uses the origin-wide IDB auth mutex', async ({ page, context, url, control }) => {
    await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })); control.loggedIn = false;
    await page.goto(`${url}/login`); await page.getByRole('heading', { name: '欢迎回来' }).waitFor(); const other = await context.newPage(); await other.goto(`${url}/register`); await other.getByLabel('昵称').fill('alice'); await other.getByLabel('邮箱', { exact: true }).fill('alice@example.test'); await other.getByLabel('密码', { exact: true }).fill(crypto.randomUUID());
    await page.evaluate(() => localStorage.setItem('feedink-logout-pending', JSON.stringify({ id: crypto.randomUUID(), owner: 'alice' }))); await other.evaluate(() => { window.__audit.identityHold = true; }); await other.getByRole('button', { name: '注册并开始阅读', exact: true }).click(); await other.waitForFunction(() => window.__audit.held.length > 0);
    const calls = control.sessionCalls; const reads = await page.evaluate(() => window.__audit.authLockReads); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForFunction(value => window.__audit.authLockReads > value, reads); assert.equal(control.sessionCalls, calls, 'retry cannot enter session HTTP while same-owner handoff holds the IDB mutex');
    await other.evaluate(() => window.__audit.held.splice(0).forEach(release => release())); await expect(other.getByTestId('app-shell')).toBeVisible(); await expect.poll(() => other.evaluate(() => localStorage.getItem('feedink-logout-pending'))).toBe(null); assert.equal(control.logouts, 0);
  });
  await scenario('R3 no lock and no coordination storage suppresses unsafe pending revocation', async ({ page, context, url, control }) => {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); indexedDB.open = () => { throw new DOMException('storage disabled', 'UnknownError'); }; });
    await page.goto(`${url}/settings`); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible(); await expect(page.getByRole('alert')).toContainText('未撤销服务器会话');
    assert.equal(control.logouts, 0); assert.equal(control.loggedIn, true); assert.ok(await page.evaluate(() => localStorage.getItem('feedink-logout-pending'))); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await frames(page); assert.equal(control.logouts, 0);
  });
  await scenario('R5 total IDB open failure permits repeated safe online writes with and without native locks', async ({ page, context, url, control }) => {
    await context.addInitScript(() => { indexedDB.open = () => { throw new DOMException('storage disabled', 'UnknownError'); }; });
    await page.goto(`${url}/?article=one`); await expect(page.getByTestId('reader-content')).toBeVisible();
    const saved = page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }); await saved.click(); await expect.poll(() => control.articles[0].saved).toBe(true); await expect(saved).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })); await saved.click(); await expect.poll(() => control.articles[0].saved).toBe(false);
    assert.equal(control.writes.length, 2); assert.equal(control.rejectedCsrf, 0); assert.deepEqual(control.writes.map(write => write.version), ['"0"', '"1"']);
  });
  await scenario('R6 stale online list keeps newer acknowledged saved state', async ({ page, url, control }) => {
    await open(page, url); const hold = deferred(); control.holdList = hold; await page.getByRole('button', { name: '筛选与视图', exact: true }).click(); await page.locator('.filter-panel select').selectOption('oldest'); await expect.poll(() => control.listCaptured).toBe(true);
    await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click(); await expect.poll(() => control.articles[0].saved).toBe(true); await expect.poll(() => queueEmpty(page)).toBe(true);
    const response = page.waitForResponse(response => response.url().includes('/api/articles?') && response.url().includes('sort=oldest')); hold.resolve(); await (await response).finished(); await frames(page); await expect(page.getByTestId('article-card').filter({ hasText: '第一篇' }).locator('.card-badges .lucide-bookmark')).toHaveCount(1);
  });
  await scenario('R6 stale initial detail preserves newer state without discarding fresh content', async ({ page, context, url, control }) => {
    await open(page, url); const hold = deferred(); control.holdDetail = hold; const other = await context.newPage(); await other.goto(`${url}/?article=one`); await expect.poll(() => control.detailCaptured).toBe(true);
    await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click(); await expect.poll(() => control.articles[0].saved).toBe(true); await expect.poll(() => queueEmpty(page)).toBe(true); hold.resolve();
    await expect(other.getByTestId('reader-content')).toContainText('第一篇'); await expect(other.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], `Residual regressions failed: ${failures.join(', ')}`);
