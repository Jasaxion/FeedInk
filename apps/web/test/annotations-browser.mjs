// Client-only lifecycle regression fixture. Real REST/MCP/PDF acceptance remains a separate CI gate.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFixture } from './audit-fixture.mjs';
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true, executablePath: process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const fixture = await auditFixture();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
context.setDefaultTimeout(15000);
const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
const docs = new Map(); let conflict = false; let writes = 0;
await context.route('**/api/articles/*/annotations?*', async route => {
  const request = route.request(), url = new URL(request.url()), id = url.pathname.split('/')[3], mode = url.searchParams.get('mode') || 'feed';
  const article = fixture.control.articles.find(item => item.id === id), key = `${id}:${mode}`;
  if (!docs.has(key)) docs.set(key, { schemaVersion: 1, id: null, revision: 0, updatedAt: null, versions: [], contentHash: 'a'.repeat(64), context: { articleId: id, mode, contentHash: 'a'.repeat(64), sourceUrl: article.url, title: article.title, contentHtml: article.contentHtml }, ink: null, marks: [] });
  if (!fixture.control.loggedIn) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: '请登录' } } });
  const current = docs.get(key);
  if (request.method() === 'PUT') {
    writes++;
    assert.equal(request.headers()['x-csrf-token'], `csrf-${fixture.control.user.id}`);
    if (conflict || request.headers()['if-match'] !== `"${current.revision}"`) return route.fulfill({ status: 412, json: { error: { code: 'ANNOTATION_CONFLICT', message: '版本冲突' } } });
    docs.set(key, { ...current, ...request.postDataJSON(), id: key, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  }
  return route.fulfill({ json: docs.get(key) });
});
async function selectText() {
  await page.getByTestId('reader-content').evaluate(root => { const text = root.querySelector('p').firstChild; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(text.length, 8)); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
}
try {
  await page.goto(`${fixture.url}/?article=one`); await expect(page.getByTestId('reader-content')).toBeVisible();
  // An existing host is not used or overwritten by browser annotation persistence.
  await page.evaluate(() => { window.__hostCalls = 0; window.__existingHost = { postMessage() { window.__hostCalls++; } }; window.WebInkHost = window.__existingHost; });
  await page.getByTestId('annotation-toggle').click(); await expect(page.getByTestId('annotation-toolbar')).toBeVisible(); await expect(page.getByTestId('annotations-panel')).toBeVisible();
  await expect(page.getByTestId('annotation-status')).toContainText('已同步');
  for (const label of ['高亮', '下划线', '波浪线']) { await selectText(); await page.getByRole('button', { name: label, exact: true }).click(); await page.getByTestId('note-editor').fill(`${label} <img src=x onerror=alert(1)>`); await page.getByRole('button', { name: '保存备注', exact: true }).click(); await expect(page.getByTestId('annotation-status')).toContainText('已同步'); }
  await page.getByRole('button', { name: '备注', exact: true }).click(); await page.getByTestId('note-editor').fill('整篇备注保留'); await page.getByRole('button', { name: '保存备注', exact: true }).click(); await expect(page.getByTestId('annotation-status')).toContainText('已同步');
  assert.equal(docs.get('one:feed').marks.length, 4); assert.equal(await page.locator('.annotations-panel img').count(), 0);
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
  await page.getByTestId('reader-content').evaluate(root => {
    const target = root.querySelector('p'), r = target.getBoundingClientRect(); const base = { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'pen', isPrimary: true, button: 0, buttons: 1 };
    for (const [type, dx, dy, pressure] of [['pointerdown', 12, 10, .2], ['pointermove', 35, 12, .85], ['pointerup', 55, 10, 0]]) target.dispatchEvent(new PointerEvent(type, { ...base, clientX: r.left + dx, clientY: r.top + dy, pressure, buttons: type === 'pointerup' ? 0 : 1 }));
  });
  await expect.poll(() => docs.get('one:feed').ink?.strokes.length).toBe(1);
  const points = docs.get('one:feed').ink.strokes[0].points; assert.ok(points.some(point => point.p < .4)); assert.ok(points.some(point => point.p > .7));
  assert.equal(docs.get('one:feed').ink.url, fixture.control.articles[0].url);
  await page.getByTestId('reader-content').evaluate(root => { root.querySelector('img').dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType: 'pen' })); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Pen contact on navigation must not be swallowed or recorded by the reader engine.
  const outside = await page.getByTestId('annotation-toggle').evaluate(button => { const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 99, button: 0 }); button.dispatchEvent(event); return event.defaultPrevented; });
  assert.equal(outside, false);
  await page.getByRole('button', { name: '撤销笔迹', exact: true }).click(); await expect.poll(() => docs.get('one:feed').ink?.strokes.length).toBe(0);
  await page.getByRole('button', { name: '重做笔迹', exact: true }).click(); await expect.poll(() => docs.get('one:feed').ink?.strokes.length).toBe(1);
  assert.deepEqual(await page.evaluate(() => [window.WebInkHost === window.__existingHost, window.__hostCalls, !!window.WebInk]), [true, 0, false]);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click(); const download = await downloadPromise;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8')); assert.equal(backup.marks.length, 4); assert.equal(backup.ink.strokes.length, 1); assert.notEqual(backup.ink.strokes[0].anchor.kind, 'render-v1');
  const popupPromise = page.waitForEvent('popup'); await page.getByRole('button', { name: '打印 / PDF', exact: true }).click(); const popup = await popupPromise; await expect(popup.getByTestId('annotation-print-view')).toBeVisible(); await expect(popup.locator('blockquote')).toHaveCount(3); await expect(popup.locator('img')).toHaveCount(1); await expect(popup.locator('body')).toContainText('不是可恢复备份');
  if (process.env.FEEDINK_BROWSER !== 'webkit') { const dir = await mkdtemp(join(tmpdir(), 'feedink-annotation-pdf-')); const path = join(dir, 'report.pdf'); await popup.pdf({ path, printBackground: true }); assert.equal((await readFile(path)).subarray(0, 5).toString(), '%PDF-'); }
  await popup.close();
  // Explicit conflict: repeated retry must retain local data and must not adopt the new revision.
  conflict = true; docs.get('one:feed').revision += 1;
  await page.getByRole('button', { name: '备注', exact: true }).click(); await page.getByTestId('note-editor').fill('冲突草稿'); await page.getByRole('button', { name: '保存备注', exact: true }).click(); await expect(page.getByTestId('annotation-status')).toContainText('冲突');
  const before = writes; await page.getByRole('button', { name: '重试同步', exact: true }).click(); await expect(page.getByTestId('annotation-status')).toContainText('冲突'); assert.equal(writes, before); await expect(page.getByTestId('annotations-panel')).toContainText('冲突草稿');
  // Forced expiry must remove active identity, hide content and retain pending notes in quarantine.
  fixture.control.loggedIn = false;
  await page.getByTestId('reader').getByRole('button', { name: '稍后阅读', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible(); await expect(page.getByTestId('reader-content')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => { const request = open.result.transaction('rows').objectStore('rows').getAll(); request.onsuccess = () => { const rows = request.result; resolve({ identity: rows.some(row => row.key === 'identity'), recovery: rows.some(row => row.kind === 'annotation-recovery'), article: rows.some(row => row.kind === 'article') }); open.result.close(); }; }; }))).toEqual({ identity: false, recovery: true, article: false });
  assert.deepEqual(errors, []);
  console.log('PASS annotations-browser: text/pressure/CAS/export/print/forced-auth client fixtures');
} finally { await context.close(); await fixture.close(); await browser.close(); }
