import { test, expect, type Page } from '@playwright/test';
import { fixtureQuote, getAnnotation } from '../fixtures/annotation-fixtures.js';
import { assertNoHorizontalOverflow, browserNetworkFault, csrf, detail, openSettings, register, resetUpstream, subscribe, waitForArticles } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

async function readerTool(page: Page, label: string) {
  await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
  const tools = page.getByRole('dialog', { name: '阅读工具', exact: true });
  await expect(tools).toBeVisible();
  await tools.getByRole('button', { name: label, exact: true }).click();
  return tools;
}

async function selectOwnedQuote(page: Page) {
  const paragraph = page.getByTestId('reader-content').locator('p').filter({ hasText: fixtureQuote }).first();
  await paragraph.scrollIntoViewIfNeeded();
  expect(await paragraph.evaluate((root, quote) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(quote) ?? -1;
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + quote.length);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange')); return selection?.toString();
    }
    return null;
  }, fixtureQuote)).toBe(fixtureQuote);
  await expect(page.getByTestId('selection-annotation-toolbar')).toBeVisible();
}

async function bodyGeometry(page: Page) {
  return page.getByTestId('reader-content').evaluate(root => {
    const box = root.getBoundingClientRect(), scroll = root.closest('.reader-scroll')!;
    return { x: box.x, y: box.y, width: box.width, height: box.height, scrollHeight: scroll.scrollHeight, scrollTop: scroll.scrollTop };
  });
}

test('reading tools are on demand without body reflow; selection Escape keeps the article open', async ({ page }) => {
  test.setTimeout(100_000);
  const api = page.context().request;
  const session = await register(api), sub = await subscribe(api, session);
  const list = await waitForArticles(api, sub.id, 2);
  const item = list.items.find(article => article.title.includes('墨水屏'))!;
  await page.goto('/');
  const connection = page.getByTestId('offline-status');
  await expect(connection).toHaveAccessibleName('已连接');
  expect(await connection.evaluate(node => node.closest('.list-toolbar') !== null)).toBe(true);
  expect(await connection.evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(24);
  await expect(connection.locator('svg')).toHaveCount(1);
  await expect(connection.locator('.sr-only')).toHaveText('已连接');
  await page.getByTestId('article-card').filter({ hasText: item.title }).click();
  const body = page.getByTestId('reader-content');
  await expect(body).toContainText(fixtureQuote);
  await expect(page.getByTestId('ink-toggle')).toBeEnabled();
  await body.evaluate(async root => { await document.fonts.ready; await Promise.all(Array.from(root.querySelectorAll('img'), image => image.decode())); });
  const baseline = await bodyGeometry(page);
  await expect(page.getByRole('dialog', { name: '阅读工具', exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: '正文模式', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '朗读控制', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
  await expect(page.getByTestId('annotation-toolbar')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '阅读翻页' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '存档信息', exact: true })).toHaveCount(0);
  await expect(page.locator('.article-document')).not.toContainText('SHA-256:');
  expect(await page.getByTestId('annotation-toggle').evaluate(node => !!node.closest('.reader-toolbar'))).toBe(true);
  expect(await page.getByTestId('ink-toggle').evaluate(node => !!node.closest('.reader-toolbar'))).toBe(true);

  const tools = await readerTool(page, '正文与排版');
  await expect(tools.getByRole('combobox', { name: '正文模式', exact: true })).toHaveValue('feed');
  expect(await bodyGeometry(page)).toEqual(baseline);
  await page.keyboard.press('Escape'); await expect(tools).toBeHidden();
  await readerTool(page, '朗读');
  if (await page.evaluate(() => 'speechSynthesis' in window)) await expect(page.getByRole('region', { name: '朗读控制', exact: true })).toBeVisible();
  else await expect(tools).toContainText('当前浏览器不支持 SpeechSynthesis 朗读。');
  expect(await bodyGeometry(page)).toEqual(baseline);
  await page.keyboard.press('Escape');
  await readerTool(page, '存档信息');
  const archive = page.getByRole('dialog', { name: '存档信息', exact: true }), stored = await detail(api, item.id);
  await expect(archive).toContainText(`SHA-256: ${stored.contentHash}`);
  await expect(archive).toContainText(`${stored.images.filter(image => image.status === 'cached').length}/${stored.images.length} 张图片已在服务器保存`);
  await expect(archive.getByRole('button', { name: '重新抓取图片', exact: true })).toBeVisible();
  expect(await bodyGeometry(page)).toEqual(baseline);
  await archive.getByRole('button', { name: '关闭对话框', exact: true }).click();

  await page.getByTestId('annotation-toggle').click();
  await expect(page.getByTestId('annotations-panel')).toBeVisible();
  expect(await bodyGeometry(page)).toEqual(baseline);
  await page.getByTestId('ink-toggle').click();
  await expect(page.getByTestId('annotation-toolbar')).toBeVisible();
  await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
  expect(await bodyGeometry(page)).toEqual(baseline);
  await page.getByRole('button', { name: '退出手写', exact: true }).click();
  await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
  await selectOwnedQuote(page);
  const selectedGeometry = await bodyGeometry(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-annotation-toolbar')).toHaveCount(0);
  await expect(body).toBeVisible(); expect(new URL(page.url()).searchParams.get('article')).toBe(item.id);
  expect(await bodyGeometry(page)).toEqual(selectedGeometry);
  expect((await getAnnotation(api, item.id)).marks).toEqual([]);

  await selectOwnedQuote(page);
  await page.getByTestId('selection-annotation-toolbar').getByRole('button', { name: '备注', exact: true }).click();
  const remark = '自有阅读流程自动保存备注';
  await page.getByTestId('note-editor').fill(remark);
  expect(await bodyGeometry(page)).toEqual(selectedGeometry);
  await expect.poll(async () => (await getAnnotation(api, item.id)).marks.map(mark => mark.text)).toEqual([remark]);
  await page.getByTestId('note-editor').press('Escape');
  await page.getByTestId('annotation-toggle').click();
  await page.locator('.annotation-list-item').filter({ hasText: remark }).click();
  await expect(page.getByTestId('annotations-panel')).toBeVisible();
  await expect(page.getByTestId('note-editor')).toHaveValue(remark);
  expect(await bodyGeometry(page)).toEqual(selectedGeometry);
  await page.getByTestId('note-editor').press('Escape');
  await expect(page.getByTestId('annotations-panel')).toBeVisible();
  await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
  await assertNoHorizontalOverflow(page);
});

test('focus reading is opt-in and Escape exits focus without closing the article', async ({ page }) => {
  const api = page.context().request;
  const session = await register(api), sub = await subscribe(api, session);
  const list = await waitForArticles(api, sub.id, 2);
  const item = list.items.find(article => article.title.includes('墨水屏'))!;
  await page.goto(`/?article=${item.id}`);
  const reader = page.getByTestId('reader');
  await expect(page.getByTestId('ink-toggle')).toBeEnabled();
  await expect(reader).not.toHaveAttribute('data-focus', 'true');
  await readerTool(page, '专注阅读');
  await expect(reader).toHaveAttribute('data-focus', 'true');
  await expect(page.locator('.list-pane')).toBeHidden(); await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.getByRole('button', { name: '退出专注阅读', exact: true })).toBeVisible();
  await selectOwnedQuote(page); await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-annotation-toolbar')).toHaveCount(0);
  await expect(reader).toHaveAttribute('data-focus', 'true');
  await page.keyboard.press('Escape');
  await expect(reader).not.toHaveAttribute('data-focus', 'true');
  await expect(page.getByTestId('reader-content')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('article')).toBe(item.id);
  await assertNoHorizontalOverflow(page);
});

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
  const settings = await api.patch('/api/settings', { headers: csrf(session), data: { theme: 'eink', fontSize: 22, lineHeight: 1.8, tapToPage: false } });
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
  await expect(page.getByRole('navigation', { name: '阅读翻页' })).toBeVisible();
  expect((await api.patch('/api/settings', { headers: csrf(session), data: { theme: 'light', tapToPage: true } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('reader-content')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '阅读翻页' })).toBeVisible();
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

test('PWA reads cached body/images offline, syncs changes and purges private data on logout', async ({ page, browserName }, info) => {
  test.setTimeout(100_000);
  const setOffline = await browserNetworkFault(page, browserName);
  const api = page.context().request;
  const witnessOrigin = process.env.FEEDINK_API_WITNESS_URL;
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
  await setOffline(true);
  expect(await page.evaluate(() => fetch('/api/health').then(() => false, () => true))).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await expect(page.getByTestId('offline-status')).toContainText(/离线/);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(async () => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('y');
  await expect(page.getByTestId('offline-status')).toContainText(/待同步|等待同步/);
  expect((await detail(api, item.id, witnessOrigin)).saved).toBe(false);
  await expect(page.getByRole('button', { name: '重试同步', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const connection = page.getByTestId('offline-status');
  await expect(connection).toHaveAccessibleName(/离线.*待同步/);
  expect(await connection.evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(24);
  await page.getByRole('button', { name: '列表菜单', exact: true }).click();
  const listMenu = page.getByRole('dialog', { name: '列表操作', exact: true });
  await expect(listMenu).toContainText(/离线.*待同步/);
  await listMenu.getByRole('button', { name: '重试同步', exact: true }).click();
  expect((await detail(api, item.id, witnessOrigin)).saved).toBe(false);
  await listMenu.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByTestId('article-card').filter({ hasText: item.title }).click();
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await page.screenshot({ path: info.outputPath('reader-offline.png'), fullPage: true });
  await setOffline(false);
  expect(await page.evaluate(() => fetch('/api/health').then(response => response.ok))).toBe(true);
  await expect.poll(async () => (await detail(api, item.id, witnessOrigin)).saved, { timeout: 30_000 }).toBe(true);
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  for (const size of [20, 22]) {
    await settings.getByLabel('字号 (px)', { exact: true }).fill(String(size));
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await (await api.get('/api/settings')).json()).fontSize).toBe(size);
  }
  await settings.getByRole('button', { name: /退出登录/ }).click();
  await expect(page.getByTestId('app-shell')).toHaveCount(0);
  await setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(item.title, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('reader-content')).toHaveCount(0);
  await setOffline(false);
});
