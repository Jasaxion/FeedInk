import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertNoHorizontalOverflow, detail, register, resetUpstream, subscribe, upstream, waitForArticles } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

test('real UI registration, organization, subscription, tagging, exports and archive import', async ({ page }, info) => {
  test.setTimeout(120_000);
  const email = `workflow-${randomUUID()}@example.test`;
  const password = 'FeedInk-real-UI-password-2026!';
  await page.goto('/register');
  await page.getByLabel('昵称', { exact: true }).fill('真实流程读者');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并开始阅读', exact: true }).click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const api = page.context().request;

  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const folderDialog = page.getByRole('dialog', { name: '管理文件夹', exact: true });
  await folderDialog.getByLabel('名称', { exact: true }).fill('长期阅读');
  await folderDialog.getByLabel('列表样式', { exact: true }).selectOption('grid');
  await folderDialog.getByLabel('排序', { exact: true }).selectOption('oldest');
  await folderDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(folderDialog).toHaveCount(0);
  await expect.poll(async () => {
    const data = await (await api.get('/api/folders')).json();
    return data.items.find((folder: { name: string }) => folder.name === '长期阅读')?.settings;
  }).toMatchObject({ view: 'grid', sort: 'oldest' });

  await page.getByRole('button', { name: '添加订阅', exact: true }).click();
  const discovery = page.getByRole('dialog', { name: '发现与添加订阅', exact: true });
  await discovery.getByLabel('网址或关键字', { exact: true }).fill(`${upstream}/feed.xml?ui=${randomUUID()}`);
  await discovery.getByLabel('添加到文件夹', { exact: true }).selectOption({ label: '长期阅读' });
  await discovery.getByRole('button', { name: '查找', exact: true }).click();
  await expect(discovery.getByRole('button', { name: '订阅', exact: true })).toBeVisible();
  await discovery.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(discovery.getByRole('button', { name: '已订阅', exact: true })).toBeVisible();
  await discovery.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.getByTestId('article-card')).toHaveCount(2);

  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  const tagDialog = page.getByRole('dialog', { name: '管理标签', exact: true });
  await tagDialog.getByLabel('名称', { exact: true }).fill('值得重读');
  await tagDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(tagDialog).toHaveCount(0);
  const card = page.getByTestId('article-card').filter({ hasText: '墨水屏上的安静阅读' }).first();
  const articleId = await card.getAttribute('data-article-id');
  await card.click();
  const reader = page.getByTestId('reader');
  await expect(page.getByTestId('reader-content')).toContainText('持久存档');
  await reader.getByRole('button', { name: '更多文章操作', exact: true }).click();
  const actions = page.getByRole('dialog', { name: '文章操作', exact: true });
  const tagCheckbox = actions.getByRole('checkbox', { name: '值得重读', exact: true });
  await tagCheckbox.click();
  await expect(tagCheckbox).toBeChecked();
  await expect.poll(async () => (await detail(api, articleId!)).tags.some(tag => tag.name === '值得重读')).toBe(true);
  await actions.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await reader.getByRole('button', { name: '稍后阅读', exact: true }).click();
  await expect.poll(async () => (await detail(api, articleId!)).saved).toBe(true);

  await page.goto('/export');
  const exports = page.getByRole('dialog', { name: '导出与电子书', exact: true });
  let downloaded = page.waitForEvent('download');
  await exports.getByRole('button', { name: '导出 OPML', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.opml$/);
  downloaded = page.waitForEvent('download');
  await exports.getByRole('button', { name: '导出完整 ZIP 存档', exact: true }).click();
  const zip = await downloaded;
  const zipPath = info.outputPath('owned-archive.zip');
  await zip.saveAs(zipPath);
  expect((await readFile(zipPath)).subarray(0, 2).toString()).toBe('PK');
  await exports.getByLabel('书名', { exact: true }).fill('验收阅读集');
  await exports.getByRole('button', { name: '生成电子书', exact: true }).click();
  await expect(exports.getByText('验收阅读集', { exact: true })).toBeVisible();
  downloaded = page.waitForEvent('download');
  await exports.getByRole('button', { name: '下载', exact: true }).first().click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.epub$/);

  await page.goto('/settings');
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByTestId('app-shell')).toHaveCount(0);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('article-card')).toHaveCount(2);
  expect((await detail(api, articleId!)).saved).toBe(true);

  await page.goto('/import');
  const imports = page.getByRole('dialog', { name: '导入', exact: true });
  const opmlDone = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/import/opml'));
  await imports.getByLabel('导入 OPML', { exact: true }).setInputFiles({ name: 'feeds.opml', mimeType: 'application/xml', buffer: Buffer.from(`<opml version="2.0"><body><outline text="迁入文件夹"><outline text="Atom迁入" type="rss" xmlUrl="${upstream}/atom.xml?ui=${randomUUID()}" /></outline></body></opml>`) });
  expect((await opmlDone).ok()).toBe(true);
  await expect(imports.getByRole('status').filter({ hasText: '正在安全导入' })).toHaveCount(0);
  const result = imports.getByRole('status').filter({ has: page.getByRole('heading', { name: '导入结果', exact: true }) });
  await expect(result).toContainText('导入 1');
  const archiveDone = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/import/archive'));
  await imports.getByLabel('导入 FeedInk ZIP 存档', { exact: true }).setInputFiles(zipPath);
  const archiveResponse = await archiveDone;
  expect(archiveResponse.ok()).toBe(true);
  const archiveResult = await archiveResponse.json();
  expect(archiveResult.skipped).toBe(2);
  expect(archiveResult.errors.length).toBe(0);
  await expect(imports.getByRole('status').filter({ hasText: '正在安全导入' })).toHaveCount(0);
  await expect(result).toContainText('跳过 2');
  await expect(result).toContainText('失败 0');
  await assertNoHorizontalOverflow(page);
});

test('two real tabs serialize offline intentions and stale writes cannot replace the latest state', async ({ context, page }, info) => {
  test.setTimeout(90_000);
  const api = context.request;
  const session = await register(api);
  const sub = await subscribe(api, session);
  const list = await waitForArticles(api, sub.id, 2);
  const item = list.items.find(article => article.title.includes('墨水屏'))!;
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto(`/?article=${item.id}`);
    await expect(tab.getByTestId('reader-content')).toContainText('持久存档');
    await expect(tab.getByTestId('offline-status')).toContainText(/离线可用|已缓存/);
  }
  let releaseFirst!: () => void;
  let firstSeen!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const seen = new Promise<void>(resolve => { firstSeen = resolve; });
  let heldOnce = false;
  const sent: { saved: boolean; precondition?: string }[] = [];
  await context.route(`**/api/articles/${item.id}/state`, async route => {
    const request = route.request();
    const body = request.postDataJSON();
    if (typeof body.saved === 'boolean') {
      sent.push({ saved: body.saved, precondition: request.headers()['if-match'] });
      if (body.saved && !heldOnce) { heldOnce = true; firstSeen(); await held; }
    }
    await route.continue();
  });
  try {
    await context.setOffline(true);
    await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click();
    await expect(page.getByTestId('offline-status')).toContainText(/待同步|等待同步/);
    await context.setOffline(false);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([seen, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('No queued state request was sent')), 20_000); })]);
    } finally { clearTimeout(timeout); }
    await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click();
    const firstResponse = context.waitForEvent('response', { predicate: response => response.url().endsWith(`/api/articles/${item.id}/state`) && response.request().postDataJSON()?.saved === true });
    releaseFirst();
    expect([200, 412]).toContain((await firstResponse).status());
    await expect(page.getByTestId('offline-status')).not.toContainText(/待同步|等待同步/);
    await expect.poll(async () => (await detail(api, item.id)).saved, { timeout: 30_000 }).toBe(false);
    expect(sent.some(request => request.saved === false)).toBe(true);
    expect(sent.every(request => /^"\d+"$/.test(request.precondition || ''))).toBe(true);
    await page.screenshot({ path: info.outputPath('two-tab-synchronized.png') });
  } finally {
    releaseFirst();
    await context.unroute(`**/api/articles/${item.id}/state`);
    await second.close();
  }
});
