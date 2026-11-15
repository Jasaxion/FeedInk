import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import type { AnnotationDocument, NotesBackup } from '../../packages/shared/src/index.js';
import { assertNoHorizontalOverflow, baseURL, browserNetworkFault, csrf, openSettings, resetUpstream } from './helpers.js';
import {
  annotationFixture, annotationPath, annotationSaveFault, assertAllStrokeColors, createAnnotationUser, fixtureLiteralNote,
  fixturePassword, fixtureQuote, fixtureRemark, fixtureTitle, fixtureUnlocatedQuote, getAnnotation,
  notesBackup, parsePpm, pngDimensions, putAnnotation, seedAnnotationArticles, textMark, type Raster,
} from '../fixtures/annotation-fixtures.js';

// Synthetic data still travels through authenticated APIs. Do not persist request traces/credentials.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

const tools = ['高亮', '下划线', '波浪线', '备注', '钢笔', '荧光笔', '橡皮', '撤销笔迹', '重做笔迹'];
const pending = /本地|待同步|等待同步/;
const synchronized = /已同步|已保存到服务器|服务器已保存/;

async function showAnnotations(page: Page) {
  if (!await page.getByTestId('annotation-toolbar').isVisible()) await page.getByTestId('annotation-toggle').click();
  await expect(page.getByTestId('annotation-toolbar')).toBeVisible();
  await expect(page.getByTestId('annotations-panel')).toBeVisible();
  await expect(page.getByTestId('annotation-toolbar').getByRole('button', { name: '高亮', exact: true })).toBeEnabled();
}

async function openAnnotations(page: Page, articleId: string) {
  await page.goto(`/?article=${articleId}`);
  await expect(page.getByTestId('reader-content')).toBeVisible();
  await showAnnotations(page);
}

async function selectQuote(page: Page, quote = fixtureQuote) {
  const body = page.getByTestId('reader-content');
  await body.scrollIntoViewIfNeeded();
  const selected = await body.evaluate((root, exact) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(exact) ?? -1;
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + exact.length);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection?.toString();
    }
    return null;
  }, quote);
  expect(selected).toBe(quote);
}

async function addRemark(page: Page, text: string) {
  await selectQuote(page);
  await page.getByTestId('annotation-toolbar').getByRole('button', { name: '备注', exact: true }).click();
  await page.getByTestId('note-editor').fill(text);
  await page.getByRole('button', { name: '保存备注', exact: true }).click();
}

async function waitForMarks(api: APIRequestContext, articleId: string, count: number) {
  await expect.poll(async () => (await getAnnotation(api, articleId)).marks.length).toBe(count);
  return getAnnotation(api, articleId);
}

async function login(page: Page, email: string) {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(fixturePassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

async function pngRaster(page: Page, bytes: Uint8Array): Promise<Raster> {
  const result = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('PNG witness requires canvas');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, Buffer.from(bytes).toString('base64'));
  return { ...result, channels: 4, pixels: Uint8Array.from(result.pixels) };
}

// Trusted Chromium pen events, not direct calls to the ink engine or fabricated saved documents.
async function penPath(page: Page, points: { x: number; y: number; pressure: number }[]) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const first = points[0];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'pen' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: first.pressure });
    for (const point of points.slice(1)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1, pointerType: 'pen', force: point.pressure });
    const last = points[points.length - 1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  } finally { await cdp.detach(); }
}

test('selected quotes produce all four text marks, survive reload and do not move to another article/mode', async ({ page }) => {
  const api = page.context().request;
  const session = await createAnnotationUser(api);
  const { first, second } = await seedAnnotationArticles(api, session);
  await openAnnotations(page, first.id);
  for (const [index, label] of ['高亮', '下划线', '波浪线'].entries()) {
    await selectQuote(page);
    await page.getByTestId('annotation-toolbar').getByRole('button', { name: label, exact: true }).click();
    const document = await waitForMarks(api, first.id, index + 1);
    expect(document.marks[index].anchor?.exact).toBe(fixtureQuote);
    expect(document.marks[index].kind).toBe(['highlight', 'underline', 'wave'][index]);
  }
  await addRemark(page, fixtureRemark);
  const saved = await waitForMarks(api, first.id, 4);
  expect(saved.marks.find(mark => mark.kind === 'note')?.text).toBe(fixtureRemark);
  await expect(page.getByTestId('annotation-status')).toContainText(synchronized);
  await page.reload();
  await showAnnotations(page);
  await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
  expect((await getAnnotation(api, first.id)).marks).toEqual(saved.marks);
  await page.getByRole('button', { name: '下一篇 (J)', exact: true }).click();
  await expect(page.getByTestId('reader')).toContainText(second.title);
  await showAnnotations(page);
  await expect(page.getByTestId('annotations-panel')).not.toContainText(fixtureRemark);
  expect((await getAnnotation(api, second.id)).marks).toEqual([]);
  await page.getByRole('button', { name: '上一篇 (K)', exact: true }).click();
  await expect(page.getByTestId('reader')).toContainText(first.title);
  await showAnnotations(page);
  await page.getByRole('combobox', { name: '正文模式', exact: true }).selectOption('fulltext');
  await expect(page.getByTestId('reader-content')).toContainText('第1段');
  await showAnnotations(page);
  expect((await getAnnotation(api, first.id, 'fulltext')).context.mode).toBe('fulltext');
  await expect(page.getByTestId('annotations-panel')).not.toContainText(fixtureRemark);
  expect((await getAnnotation(api, first.id, 'feed')).marks).toEqual(saved.marks);
  await page.getByRole('combobox', { name: '正文模式', exact: true }).selectOption('feed');
  await expect(page.getByTestId('annotation-toggle')).toHaveAttribute('aria-expanded', 'false');
  await showAnnotations(page);
  await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
});

test('browser pen preserves pressure, scopes input to the reader, and whole-stroke erase/undo/redo persist', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Trusted pressure input witness uses Chromium CDP; no cross-engine pen certification claimed');
  const api = page.context().request;
  const session = await createAnnotationUser(api);
  const { first, second } = await seedAnnotationArticles(api, session);
  await openAnnotations(page, first.id);
  const toolbar = page.getByTestId('annotation-toolbar');
  await toolbar.getByRole('button', { name: '钢笔', exact: true }).click();
  const outside = await page.getByTestId('annotation-status').boundingBox();
  if (!outside) throw new Error('Annotation status must have visible geometry');
  await penPath(page, [{ x: outside.x + 4, y: outside.y + 4, pressure: 0.2 }, { x: outside.x + 20, y: outside.y + 5, pressure: 0.8 }]);
  const paragraph = page.getByTestId('reader-content').locator('p').filter({ hasText: fixtureQuote }).first();
  async function paragraphPoints() {
    // Toolbar clicks can scroll the narrow reader; CDP requires current viewport coordinates.
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.boundingBox(); if (!box) throw new Error('Reader paragraph is not visible');
    return [0.15, 0.3, 0.45, 0.6, 0.75].map((fraction, index) => ({ x: box.x + box.width * fraction, y: box.y + 12 + (index % 2) * 4, pressure: 0.15 + index * 0.18 }));
  }
  await penPath(page, await paragraphPoints());
  await expect.poll(async () => (await getAnnotation(api, first.id)).ink?.strokes.length).toBe(1);
  const pen = (await getAnnotation(api, first.id)).ink!.strokes[0];
  expect(pen.tool).toBe('pen');
  expect(pen.points.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...pen.points.map(point => point.p)) - Math.min(...pen.points.map(point => point.p))).toBeGreaterThan(0.3);
  await toolbar.getByRole('button', { name: '荧光笔', exact: true }).click();
  await penPath(page, (await paragraphPoints()).map(point => ({ ...point, y: point.y + 25 })));
  await expect.poll(async () => (await getAnnotation(api, first.id)).ink?.strokes.length).toBe(2);
  const both = await getAnnotation(api, first.id);
  expect(both.ink!.url).toBe(first.url);
  expect(both.ink!.strokes[1].tool).toBe('highlighter');
  expect(both.ink!.strokes[1].opacity).toBeLessThan(1);
  await toolbar.getByRole('button', { name: '橡皮', exact: true }).click();
  const erasePoint = (await paragraphPoints())[2];
  await penPath(page, [erasePoint, { ...erasePoint, x: erasePoint.x + 3 }]);
  await expect.poll(async () => (await getAnnotation(api, first.id)).ink?.strokes.map(stroke => stroke.id)).toEqual([both.ink!.strokes[1].id]);
  await toolbar.getByRole('button', { name: '撤销笔迹', exact: true }).click();
  await expect.poll(async () => (await getAnnotation(api, first.id)).ink?.strokes).toEqual(both.ink!.strokes);
  await toolbar.getByRole('button', { name: '重做笔迹', exact: true }).click();
  await expect.poll(async () => (await getAnnotation(api, first.id)).ink?.strokes.map(stroke => stroke.id)).toEqual([both.ink!.strokes[1].id]);
  await page.reload();
  expect((await getAnnotation(api, first.id)).ink!.strokes).toEqual([both.ink!.strokes[1]]);
  await openAnnotations(page, second.id);
  expect((await getAnnotation(api, second.id)).ink?.strokes ?? []).toEqual([]);
  await openAnnotations(page, first.id);
  expect((await getAnnotation(api, first.id)).ink!.strokes).toEqual([both.ink!.strokes[1]]);
});

test('conditional writes conflict atomically and matching JSON restores preserve raw notes across owned ID remapping', async ({ request, playwright }) => {
  const session = await createAnnotationUser(request);
  const { first, second } = await seedAnnotationArticles(request, session);
  const empty = await getAnnotation(request, first.id);
  expect(empty).toMatchObject({ id: null, revision: 0, marks: [], ink: null });
  const payload = annotationFixture(empty.context);
  const saved = await putAnnotation(request, session, empty, payload);
  expect(saved.revision).toBe(1);
  expect(saved.context.contentHtml).toBe(first.contentHtml);
  const stale = await request.put(annotationPath(first.id), { headers: { ...csrf(session), 'If-Match': '"0"' }, data: { ...payload, marks: [] } });
  expect(stale.status()).toBe(412);
  expect((await stale.json()).error.code).toBe('ANNOTATION_CONFLICT');
  expect((await getAnnotation(request, first.id)).marks).toEqual(payload.marks);
  const json = await request.get(`${annotationPath(first.id, 'feed', saved.contentHash, '/export')}&format=json`);
  expect(json.status()).toBe(200);
  const backup: NotesBackup = await json.json();
  expect(JSON.stringify(backup).includes(session.user.id), 'portable backup contains no owner id').toBe(false);
  expect(JSON.stringify(backup).includes(session.csrfToken), 'portable backup contains no CSRF capability').toBe(false);
  expect(backup).toEqual(notesBackup(saved));
  expect(Object.keys(backup).sort()).toEqual(['format', 'ink', 'marks', 'source', 'version']);
  const clear = await request.delete(annotationPath(first.id, 'feed', saved.contentHash), { headers: { ...csrf(session), 'If-Match': `"${saved.revision}"` } });
  expect(clear.status()).toBe(200);
  const tombstone: AnnotationDocument = await clear.json();
  expect(tombstone.revision).toBe(saved.revision + 1);
  expect(tombstone.marks).toEqual([]);
  expect(tombstone.ink?.strokes ?? []).toEqual([]);
  const restoredResponse = await request.post(annotationPath(first.id, 'feed', undefined, '/import'), { headers: { ...csrf(session), 'If-Match': `"${tombstone.revision}"` }, data: backup });
  expect(restoredResponse.status()).toBe(200);
  const restored: AnnotationDocument = await restoredResponse.json();
  expect(restored.revision).toBe(tombstone.revision + 1);
  expect(restored.marks).toEqual(saved.marks); expect(restored.ink).toEqual(saved.ink);
  const mismatch = await request.post(annotationPath(second.id, 'feed', undefined, '/import'), { headers: { ...csrf(session), 'If-Match': '"0"' }, data: backup });
  expect([400, 409, 422]).toContain(mismatch.status());
  expect((await getAnnotation(request, second.id)).marks).toEqual([]);
  const other = await playwright.request.newContext({ baseURL });
  try {
    const otherSession = await createAnnotationUser(other);
    const owned = await seedAnnotationArticles(other, otherSession);
    expect(owned.first.id).not.toBe(first.id);
    const context = await getAnnotation(other, owned.first.id);
    expect(context.contentHash).toBe(saved.contentHash);
    for (const suffix of ['', '/export', '/preview']) {
      const deniedRead = await other.get(annotationPath(first.id, 'feed', saved.contentHash, suffix));
      expect([403, 404]).toContain(deniedRead.status());
    }
    const privateSearch = await other.get('/api/annotations', { params: { q: '验收备注' } });
    expect(privateSearch.status()).toBe(200);
    expect((await privateSearch.json()).items).toEqual([]);
    const denied = await other.post(annotationPath(first.id, 'feed', undefined, '/import'), { headers: { ...csrf(otherSession), 'If-Match': '"0"' }, data: backup });
    expect([403, 404]).toContain(denied.status());
    const remapped = await other.post(annotationPath(owned.first.id, 'feed', undefined, '/import'), { headers: { ...csrf(otherSession), 'If-Match': '"0"' }, data: backup });
    expect(remapped.status()).toBe(200);
    const document: AnnotationDocument = await remapped.json();
    expect(document.context.articleId).toBe(owned.first.id);
    expect(document.marks).toEqual(saved.marks); expect(document.ink).toEqual(saved.ink);
    expect(document.context.contentHtml).toBe(owned.first.contentHtml);
  } finally { await other.dispose(); }
});

test('invalid imports, untrusted replacement HTML and render projections cannot destroy a saved revision', async ({ request }) => {
  const session = await createAnnotationUser(request);
  const { first } = await seedAnnotationArticles(request, session);
  const empty = await getAnnotation(request, first.id);
  const saved = await putAnnotation(request, session, empty, annotationFixture(empty.context));
  const backup = notesBackup(saved);
  const invalid = [
    { ...backup, version: 99 },
    { ...backup, marks: [...backup.marks, backup.marks[0]] },
    { ...backup, marks: [{ ...backup.marks[0], anchor: null }] },
    { ...backup, marks: [{ ...backup.marks[0], text: '\ud800' }] },
    { ...backup, ink: { ...backup.ink!, strokes: [{ ...backup.ink!.strokes[0], anchor: { kind: 'render-v1', matrix: [1, 0, 0, 1, 0, 0], clips: [] } }] } },
  ];
  for (const data of invalid) {
    const response = await request.post(annotationPath(first.id, 'feed', undefined, '/import'), { headers: { ...csrf(session), 'If-Match': `"${saved.revision}"` }, data });
    expect([400, 413, 422]).toContain(response.status());
    const unchanged = await getAnnotation(request, first.id);
    expect(unchanged.revision).toBe(saved.revision); expect(unchanged.marks).toEqual(saved.marks); expect(unchanged.ink).toEqual(saved.ink);
  }
  const response = await request.put(annotationPath(first.id), { headers: { ...csrf(session), 'If-Match': `"${saved.revision}"` }, data: { ...annotationFixture(saved.context), context: { ...saved.context, contentHtml: '<p>untrusted client replacement</p>' } } });
  expect([200, 400, 422]).toContain(response.status());
  expect((await getAnnotation(request, first.id)).context.contentHtml).toBe(saved.context.contentHtml);
});

test('offline draft survives reload/cache clear, does not claim server acknowledgement, and retries after reconnect', async ({ page, browserName }) => {
  test.setTimeout(100_000);
  const api = page.context().request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  const setOffline = await browserNetworkFault(page, browserName);
  await openAnnotations(page, first.id);
  await expect(page.getByTestId('offline-status')).toContainText(/离线可用|已缓存|离线就绪/);
  await setOffline(true);
  try {
    expect(await page.evaluate(() => fetch('/api/health').then(() => false, () => true))).toBe(true);
    await addRemark(page, fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    await expect(page.getByTestId('annotation-status')).not.toContainText(synchronized);
    expect((await getAnnotation(api, first.id, 'feed', undefined, process.env.FEEDINK_API_WITNESS_URL)).revision).toBe(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await showAnnotations(page);
    await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    await openSettings(page);
    await page.getByRole('button', { name: '离线与安装', exact: true }).click();
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '清理正文缓存', exact: true }).click();
    await expect(page.getByText('此设备的正文与图片缓存已清除，服务器存档未删除', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  } finally { await setOffline(false); }
  await expect.poll(async () => (await getAnnotation(api, first.id)).marks.map(mark => mark.text)).toContain(fixtureRemark);
  await page.goto(`/?article=${first.id}`);
  await showAnnotations(page);
  await expect(page.getByTestId('annotation-status')).toContainText(synchronized);
});

test('failed local draft storage is visible, retains the in-memory note and retries without false server success', async ({ page, context, browserName }) => {
  const api = context.request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  await openAnnotations(page, first.id);
  const setOffline = await browserNetworkFault(page, browserName);
  await setOffline(true);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add;
    (window as Window & { restoreNoteStorage?: () => void }).restoreNoteStorage = () => {
      IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.add = add;
    };
    const unavailable = () => { throw new DOMException('Synthetic local quota fault', 'QuotaExceededError'); };
    IDBObjectStore.prototype.put = unavailable; IDBObjectStore.prototype.add = unavailable;
  });
  try {
    await addRemark(page, fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(/失败|未保存|空间不足/);
    await expect(page.getByTestId('annotation-status')).not.toContainText(synchronized);
    await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
    expect((await getAnnotation(api, first.id, 'feed', undefined, process.env.FEEDINK_API_WITNESS_URL)).revision).toBe(0);
    await page.evaluate(() => (window as Window & { restoreNoteStorage?: () => void }).restoreNoteStorage?.());
    await page.getByTestId('annotations-panel').getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
  } finally {
    await page.evaluate(() => (window as Window & { restoreNoteStorage?: () => void }).restoreNoteStorage?.());
    await setOffline(false);
  }
  await expect.poll(async () => (await getAnnotation(api, first.id)).marks.map(mark => mark.text)).toContain(fixtureRemark);
  await expect(page.getByTestId('annotation-status')).toContainText(synchronized);
});

test('a delayed backend save stays locally pending and a real 412 preserves both local draft and server winner', async ({ page, context }) => {
  const api = context.request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  await openAnnotations(page, first.id);
  const saveFault = await annotationSaveFault();
  try {
    await saveFault.hold(first.id);
    await addRemark(page, '本地冲突草稿');
    await expect.poll(async () => (await saveFault.status()).held).toBe(1);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    await expect(page.getByTestId('annotation-status')).not.toContainText(synchronized);
    const empty = await getAnnotation(api, first.id, 'feed', undefined, saveFault.witnessOrigin);
    expect(empty.revision).toBe(0);
    const winner = await putAnnotation(api, session, empty, { schemaVersion: 1, contentHash: empty.contentHash, ink: null, marks: [textMark('note', '服务器另一设备版本')] }, saveFault.witnessOrigin);
    expect(winner.revision).toBe(1);
    expect((await saveFault.status()).held, 'independent API winner bypassed the held browser PUT').toBe(1);
    await saveFault.release();
    await expect.poll(async () => (await saveFault.status()).lastStatus).toBe(412);
    await expect(page.getByTestId('annotation-status')).toContainText(/冲突/);
    await expect(page.getByTestId('annotations-panel')).toContainText('本地冲突草稿');
    expect((await getAnnotation(api, first.id)).marks).toEqual(winner.marks);
    await page.getByTestId('annotations-panel').getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(page.getByTestId('annotation-status')).toContainText(/冲突/);
    expect((await getAnnotation(api, first.id)).revision).toBe(winner.revision);
    await page.reload();
    await showAnnotations(page);
    await expect(page.getByTestId('annotations-panel')).toContainText('本地冲突草稿');
    await expect(page.getByTestId('annotation-status')).toContainText(/冲突/);
  } finally { await saveFault.reset(); }
});

test('forced expiry strictly blocks account switching until the original owner recovers and resolves drafts', async ({ page, context, playwright, browserName }) => {
  test.setTimeout(100_000);
  const api = context.request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  const saveFault = await annotationSaveFault();
  const setOffline = await browserNetworkFault(page, browserName);
  const otherApi = await playwright.request.newContext({ baseURL });
  try {
    const otherSession = await createAnnotationUser(otherApi);
    const otherArticles = await seedAnnotationArticles(otherApi, otherSession);
    await openAnnotations(page, first.id);
    await setOffline(true);
    await addRemark(page, fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    // Revoke the real server session without invoking the application's voluntary-logout flow.
    const revoked = await api.post(new URL('/api/auth/logout', process.env.FEEDINK_API_WITNESS_URL || baseURL).href, { headers: csrf(session) });
    expect(revoked.status()).toBe(204);
    const denied = await api.get(new URL(annotationPath(first.id), saveFault.witnessOrigin).href);
    expect(denied.status(), 'revoked owner cannot read server annotations').toBe(401);
    await setOffline(false);
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect(page.getByText(fixtureRemark, { exact: false })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
    let foreignLoginRequests = 0;
    const observeLogin = (request: import('@playwright/test').Request) => { if (new URL(request.url()).pathname === '/api/auth/login') foreignLoginRequests++; };
    page.on('request', observeLogin);
    await page.getByLabel('邮箱', { exact: true }).fill(otherSession.user.email);
    await page.getByLabel('密码', { exact: true }).fill(fixturePassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText(/请先重新登录原账号恢复/)).toBeVisible();
    expect(foreignLoginRequests, 'strict gate blocks B before authentication').toBe(0);
    page.off('request', observeLogin);
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
    await expect(page.getByText(fixtureRemark, { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /导出.*笔记|导出 JSON/ })).toHaveCount(0);
    expect(await page.evaluate(() => new Promise<boolean>(resolve => {
      const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => { const request = open.result.transaction('rows').objectStore('rows').get('identity'); request.onsuccess = () => { resolve(Boolean(request.result)); open.result.close(); }; };
    })), 'blocked B has no active offline identity').toBe(false);
    expect((await getAnnotation(otherApi, otherArticles.first.id)).marks).toEqual([]);
    await login(page, session.user.email);
    await openAnnotations(page, first.id);
    await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
    await expect.poll(async () => (await getAnnotation(api, first.id)).marks.map(mark => mark.text)).toContain(fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(synchronized);
    expect((await getAnnotation(otherApi, otherArticles.first.id)).marks).toEqual([]);
    // An explicit owner-authorized discard, not a foreign login, resolves the next draft.
    const recovered = await getAnnotation(api, first.id, 'feed', undefined, saveFault.witnessOrigin);
    await saveFault.fail(first.id);
    await addRemark(page, '明确放弃的未同步备注');
    await expect.poll(async () => (await saveFault.status()).failed).toBeGreaterThan(0);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    await expect(page.getByTestId('annotation-status')).not.toContainText(synchronized);
    const unchanged = await getAnnotation(api, first.id, 'feed', undefined, saveFault.witnessOrigin);
    expect(unchanged.revision).toBe(recovered.revision);
    expect(unchanged.marks).toEqual(recovered.marks);
    await openSettings(page);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '放弃未同步更改', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await saveFault.reset();
    await login(page, otherSession.user.email);
    await openAnnotations(page, otherArticles.first.id);
    await expect(page.getByTestId('annotations-panel')).not.toContainText(fixtureRemark);
    await expect(page.getByTestId('annotations-panel')).not.toContainText('明确放弃的未同步备注');
    expect((await getAnnotation(otherApi, otherArticles.first.id)).marks).toEqual([]);
  } finally {
    try { await saveFault.reset(); }
    finally { try { await setOffline(false); } finally { await otherApi.dispose(); } }
  }
});

test('manual logout offers cancellation and explicit export/discard for unsynchronized notes', async ({ page, context, browserName }) => {
  const api = context.request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  await openAnnotations(page, first.id);
  const setOffline = await browserNetworkFault(page, browserName);
  await setOffline(true);
  try {
    await addRemark(page, fixtureRemark);
    await expect(page.getByTestId('annotation-status')).toContainText(pending);
    await openSettings(page);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '取消退出', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出未同步笔记', exact: true }).click();
    const exported = await download;
    const stream = await exported.createReadStream();
    if (!stream) throw new Error('Unsynchronized notes export was not downloadable');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(JSON.stringify(backup).includes(fixtureRemark)).toBe(true);
    await page.getByRole('button', { name: '放弃未同步更改', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
  } finally { await setOffline(false); }
  await login(page, session.user.email);
  await openAnnotations(page, first.id);
  await expect(page.getByTestId('annotations-panel')).not.toContainText(fixtureRemark);
  expect((await getAnnotation(api, first.id)).marks).toEqual([]);
});

test('Markdown ZIP includes all quotes/remarks and decodable relative handwriting assets, not raw note HTML', async ({ request, page }) => {
  const session = await createAnnotationUser(request);
  const { first } = await seedAnnotationArticles(request, session);
  const empty = await getAnnotation(request, first.id);
  const saved = await putAnnotation(request, session, empty, annotationFixture(empty.context));
  const response = await request.get(`${annotationPath(first.id, 'feed', saved.contentHash, '/export')}&format=markdown`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/zip/);
  const entries = unzipSync(await response.body());
  const markdownNames = Object.keys(entries).filter(name => name.endsWith('.md'));
  expect(markdownNames).toHaveLength(1);
  for (const name of Object.keys(entries)) expect(name.startsWith('/') || name.split('/').includes('..') || name.includes('\\'), 'ZIP path is portable and bounded').toBe(false);
  const markdown = strFromU8(entries[markdownNames[0]]);
  // Markdown backslash escapes are presentation syntax, not changes to the plain-text note.
  const plainMarkdown = markdown.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  expect(plainMarkdown).toContain(fixtureQuote); expect(plainMarkdown).toContain(fixtureRemark); expect(plainMarkdown).toContain(fixtureUnlocatedQuote);
  expect(JSON.parse(strFromU8(entries['notes.json']))).toEqual(notesBackup(saved));
  for (const kind of [/高亮|highlight/i, /下划线|underline/i, /波浪线|wave/i, /备注|note/i]) expect(markdown).toMatch(kind);
  expect(markdown).not.toContain('<img src=x');
  expect(markdown).not.toMatch(/\]\(javascript:/i);
  expect(markdown).toMatch(/未定位|unlocated|原始预览|raw preview/i);
  const imageLinks = [...markdown.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
  expect(imageLinks.length).toBeGreaterThan(0);
  const rasters: Raster[] = [];
  for (const link of imageLinks) {
    expect(/^(?:[a-z]+:|\/|\\)/i.test(link), 'handwriting link must be relative').toBe(false);
    const name = posix.normalize(posix.join(posix.dirname(markdownNames[0]), decodeURIComponent(link)));
    expect(name.startsWith('../')).toBe(false);
    expect(Boolean(entries[name]), 'Markdown asset exists in ZIP').toBe(true);
    pngDimensions(entries[name]); rasters.push(await pngRaster(page, entries[name]));
  }
  assertAllStrokeColors(rasters);
  expect((await getAnnotation(request, first.id)).ink).toEqual(saved.ink);
});

test('UI JSON import/export and actual Chromium PDF retain every quote, remark and colored raw stroke', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Actual PDF is generated by Chromium; this does not waive other browser annotation cases');
  test.setTimeout(100_000);
  const api = page.context().request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  const empty = await getAnnotation(api, first.id);
  const saved = await putAnnotation(api, session, empty, annotationFixture(empty.context));
  await openAnnotations(page, first.id);
  await expect(page.getByTestId('annotations-panel')).toContainText(fixtureRemark);
  await expect(page.getByTestId('annotations-panel')).toContainText(fixtureLiteralNote);
  await expect(page.getByTestId('annotations-panel').locator('img[src="x"]')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream(); if (!stream) throw new Error('JSON download missing');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backupBytes = Buffer.concat(chunks);
  expect(backupBytes.includes(Buffer.from(session.csrfToken)), 'download contains no session capability').toBe(false);
  expect(JSON.parse(backupBytes.toString('utf8'))).toEqual(notesBackup(saved));
  const cleared = await api.delete(annotationPath(first.id, 'feed', saved.contentHash), { headers: { ...csrf(session), 'If-Match': `"${saved.revision}"` } });
  expect(cleared.status()).toBe(200);
  await page.reload(); await showAnnotations(page);
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('导入笔记 JSON', { exact: true }).setInputFiles({ name: 'owned-notes.json', mimeType: 'application/json', buffer: backupBytes });
  await expect.poll(async () => (await getAnnotation(api, first.id)).marks).toEqual(saved.marks);
  expect((await getAnnotation(api, first.id)).ink).toEqual(saved.ink);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打印 / PDF', exact: true }).click();
  const popup = await popupPromise;
  const directory = await mkdtemp(join(tmpdir(), 'feedink-annotation-pdf-'));
  try {
    await expect(popup.getByTestId('annotation-print-view')).toBeVisible();
    await popup.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, image => image.decode())); });
    await popup.emulateMedia({ media: 'print' });
    await expect(popup.getByTestId('annotation-print-view')).toContainText(fixtureUnlocatedQuote);
    await expect(popup.getByTestId('annotation-print-view')).toContainText(/未定位|原始预览/);
    const pdf = join(directory, 'notes.pdf');
    await popup.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
    const run = promisify(execFile);
    const info = await run('pdfinfo', [pdf], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    expect(pages).toBeGreaterThan(0); expect(pages).toBeLessThanOrEqual(12);
    expect(info.stdout).toMatch(/^Page size:\s+[\d.]+ x [\d.]+ pts/m);
    const textPath = join(directory, 'notes.txt');
    await run('pdftotext', ['-layout', pdf, textPath], { timeout: 15_000 });
    const text = (await readFile(textPath, 'utf8')).replace(/\s+/g, '');
    for (const expected of [fixtureTitle, fixtureQuote, fixtureRemark, fixtureLiteralNote, fixtureUnlocatedQuote, '未定位引文必须保留。']) expect(text).toContain(expected.replace(/\s+/g, ''));
    for (const kind of [/高亮|highlight/i, /下划线|underline/i, /波浪线|wave/i, /备注|note/i]) expect(text).toMatch(kind);
    for (const control of ['撤销笔迹', '重做笔迹', '保存备注', '退出登录']) expect(text).not.toContain(control);
    await run('pdftoppm', ['-r', '96', pdf, join(directory, 'page')], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const files = (await readdir(directory)).filter(name => name.endsWith('.ppm'));
    expect(files).toHaveLength(pages);
    assertAllStrokeColors(await Promise.all(files.map(async file => parsePpm(await readFile(join(directory, file))))));
    expect((await getAnnotation(api, first.id)).ink).toEqual(saved.ink);
  } finally { await popup.close(); await rm(directory, { recursive: true, force: true }); }
});

test('e-ink and narrow mobile annotation tools remain labelled, reachable and inside the viewport', async ({ page }) => {
  const api = page.context().request;
  const session = await createAnnotationUser(api);
  const { first } = await seedAnnotationArticles(api, session);
  expect((await api.patch('/api/settings', { headers: csrf(session), data: { theme: 'eink', fontSize: 22, tapToPage: true } })).status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAnnotations(page, first.id);
  await expect(page.locator('[data-theme="eink"]').first()).toBeAttached();
  await assertNoHorizontalOverflow(page);
  const toolbar = page.getByTestId('annotation-toolbar');
  for (const label of tools) {
    const button = toolbar.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    const geometry = await button.evaluate(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, reachable: Boolean(hit && element.contains(hit)), animation: style.animationName, shadow: style.boxShadow };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(391);
    expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(845);
    expect(geometry.width).toBeGreaterThanOrEqual(32); expect(geometry.height).toBeGreaterThanOrEqual(32);
    expect(geometry.reachable, `${label} is not covered by another surface`).toBe(true);
    expect(geometry.animation).toBe('none'); expect(geometry.shadow).toBe('none');
  }
  await addRemark(page, fixtureRemark);
  await waitForMarks(api, first.id, 1);
  await expect(page.getByTestId('reader-content')).toBeVisible();
  await assertNoHorizontalOverflow(page);
});
