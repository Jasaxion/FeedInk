import { test, expect } from '@playwright/test';
import { assertNoHorizontalOverflow, csrf, detail, register, resetUpstream, subscribe, waitForArticles } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

test('reading, keyboard state, responsive layouts and e-ink typography are real', async ({ page }, info) => {
  const api = page.context().request;
  const session = await register(api);
  const sub = await subscribe(api, session);
  await waitForArticles(api, sub.id, 2);
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const card = page.getByTestId('article-card').filter({ hasText: '墨水屏上的安静阅读' }).first();
  await expect(card).toBeVisible();
  await card.click();
  const reader = page.getByTestId('reader');
  await expect(reader).toBeVisible();
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await expect(page.getByTestId('reader-content').locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __feedinkXss?: boolean }).__feedinkXss)).toBeUndefined();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('reader-light.png'), fullPage: true });
  const id = await card.getAttribute('data-article-id');
  expect(id).toBeTruthy();
  await expect.poll(async () => (await detail(api, id!)).read).toBe(true);
  await page.keyboard.press('y');
  await expect.poll(async () => (await detail(api, id!)).saved).toBe(true);
  await page.keyboard.press('m');
  await expect.poll(async () => (await detail(api, id!)).read).toBe(false);
  const settings = await api.patch('/api/settings', { headers: csrf(session), data: { theme: 'eink', fontSize: 22, lineHeight: 1.8, tapToPage: true } });
  expect(settings.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('[data-theme="eink"]').first()).toBeAttached();
  if (!(await reader.isVisible())) await page.getByTestId('article-card').filter({ hasText: '墨水屏上的安静阅读' }).first().click();
  const style = await page.getByTestId('reader-content').evaluate(element => {
    const computed = getComputedStyle(element);
    return { fontSize: computed.fontSize, animation: computed.animationName, boxShadow: computed.boxShadow, color: computed.color };
  });
  expect(style.fontSize).toBe('22px');
  expect(style.animation).toBe('none');
  expect(style.boxShadow).toBe('none');
  expect(style.color).toBe('rgb(0, 0, 0)');
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('reader-eink.png'), fullPage: true });
});

test('all list modes remain usable and route navigation preserves selected article', async ({ page }, info) => {
  const api = page.context().request;
  const session = await register(api);
  const sub = await subscribe(api, session);
  await waitForArticles(api, sub.id, 2);
  for (const view of ['list', 'magazine', 'grid']) {
    expect((await api.patch('/api/settings', { headers: csrf(session), data: { view, mobileView: view } })).ok()).toBeTruthy();
    await page.goto('/');
    await expect(page.getByTestId('article-card').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`list-${view}.png`), fullPage: true });
  }
  const card = page.getByTestId('article-card').first();
  const id = await card.getAttribute('data-article-id');
  await card.click();
  await expect(page.getByTestId('reader')).toBeVisible();
  expect(page.url()).toContain(id!);
  await page.reload();
  await expect(page.getByTestId('reader-content')).toBeVisible();
  await page.keyboard.press('o');
  await expect(page.getByTestId('article-card').first()).toBeVisible();
});

test('PWA reads cached body/images offline, syncs changes and purges private data on logout', async ({ page }, info) => {
  test.setTimeout(100_000);
  const api = page.context().request;
  const session = await register(api);
  const sub = await subscribe(api, session);
  const list = await waitForArticles(api, sub.id, 2);
  const item = list.items.find(article => article.title.includes('墨水屏'))!;
  await page.goto('/');
  await expect(page.getByTestId('article-card').first()).toBeVisible();
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const manifestResponse = await api.get(manifestHref!);
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.name).toContain('FeedInk');
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find((value: { sizes: string }) => value.sizes.includes(size));
    expect(icon, `installable icon ${size}`).toBeTruthy();
    expect((await api.get(new URL(icon.src, new URL(manifestHref!, page.url())).href)).ok()).toBeTruthy();
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByTestId('article-card').filter({ hasText: item.title }).first().click();
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  const image = page.getByTestId('reader-content').locator('img[alt="归档图片"]').first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(async () => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  // Wait for the application's explicit offline readiness, not a blind timeout.
  await expect(page.getByTestId('offline-status')).toContainText(/已缓存|离线可用|离线就绪/);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await expect(page.getByTestId('offline-status')).toContainText(/离线/);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(async () => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('y');
  await expect(page.getByTestId('offline-status')).toContainText(/待同步|等待同步/);
  expect((await detail(api, item.id)).saved).toBe(false);
  await page.screenshot({ path: info.outputPath('reader-offline.png'), fullPage: true });
  await page.context().setOffline(false);
  await expect.poll(async () => (await detail(api, item.id)).saved, { timeout: 30_000 }).toBe(true);
  await page.goto('/settings');
  await page.getByRole('button', { name: /退出登录/ }).click();
  await expect(page.getByTestId('app-shell')).toHaveCount(0);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(item.title, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('reader-content')).toHaveCount(0);
  await page.context().setOffline(false);
});
