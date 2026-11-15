// Controlled client-only regressions; run by annotations-browser.mjs in hosted CI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditFixture, deferred } from './audit-fixture.mjs';

export async function annotationRegressions(browser, expect) {
  async function scenario(name, run) {
    const fixture = await auditFixture(), context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage(); context.setDefaultTimeout(15000);
    const article = fixture.control.articles[0], hash = 'a'.repeat(64);
    const state = { document: { schemaVersion: 1, id: null, revision: 0, updatedAt: null, versions: [], contentHash: hash, context: { articleId: article.id, mode: 'feed', contentHash: hash, sourceUrl: article.url, title: article.title, contentHtml: article.contentHtml }, ink: null, marks: [] }, writes: 0, failure: 0, hold: null, historyStatus: 409, historyCode: 'ANNOTATION_CONTEXT' };
    await context.route('**/api/articles/one/annotations**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/import')) {
        const backup = request.postDataJSON(); state.document = { ...state.document, ink: backup.ink, marks: backup.marks, revision: state.document.revision + 1 };
      } else if (request.method() === 'PUT') {
        state.writes++; if (state.hold) await state.hold.promise;
        if (state.failure) return route.fulfill({ status: state.failure, json: { error: { code: 'UNAVAILABLE', message: '受控保存失败' } } });
        state.document = { ...state.document, ...request.postDataJSON(), revision: state.document.revision + 1 };
      } else if (url.searchParams.has('contentHash') && url.searchParams.get('contentHash') !== state.document.contentHash) return route.fulfill({ status: state.historyStatus, json: { error: { code: state.historyCode, message: '历史上下文不可用' } } });
      await route.fulfill({ json: state.document });
    });
    try {
      await page.goto(`${fixture.url}/?article=one`);
      await page.getByTestId('annotation-toggle').click();
      await expect(page.getByTestId('annotation-status')).toContainText('已同步');
      // Let the initial workspace verification finish before targeting annotation-only paths.
      await expect.poll(() => fixture.control.sessionCalls).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('offline-status')).not.toContainText('正在同步');
      await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeEnabled();
      await run({ page, context, fixture, state });
      console.log(`PASS annotation regression: ${name}`);
    } finally { state.hold?.resolve(); await context.close(); await fixture.close(); }
  }
  async function newNote(page, text) {
    await page.getByRole('button', { name: '备注', exact: true }).click();
    await page.getByTestId('note-editor').fill(text);
  }
  async function draw(page) {
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
    await page.getByTestId('reader-content').evaluate(root => {
      const target = root.querySelector('p'), box = target.getBoundingClientRect();
      for (const [type, x, pressure] of [['pointerdown', 12, .3], ['pointermove', 35, .8], ['pointerup', 55, 0]]) target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'pen', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: box.left + x, clientY: box.top + 10, pressure }));
    });
  }
  async function painted(page) {
    return page.locator('[data-webink-overlay]').evaluateAll(roots => roots.some(root => {
      const canvas = root.shadowRoot?.querySelector('canvas'); if (!canvas) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
      return false;
    }));
  }
  for (const verification of ['401', 'owner-mismatch']) await scenario(`focused annotation session ${verification} locks pending notes`, async ({ page, context, state, fixture }) => {
    state.failure = 503;
    await newNote(page, '必须隔离的草稿');
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    await context.route('**/api/session', route => verification === '401'
      ? route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: '登录失效' } } })
      : route.fulfill({ json: { user: { ...fixture.control.user, id: 'bob' }, settings: fixture.control.settings, csrfToken: 'csrf-bob' } }));
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => { const req = open.result.transaction('rows').objectStore('rows').getAll(); req.onsuccess = () => { resolve({ active: req.result.some(row => row.key === 'identity'), recovery: req.result.some(row => row.kind === 'annotation-recovery' && row.value.document.marks.some(mark => mark.text === '必须隔离的草稿')) }); open.result.close(); }; };
    }))).toEqual({ active: false, recovery: true });
  });
  await scenario('raw Markdown 401 locks without focus/reconnect', async ({ page, context }) => {
    await context.route('**/annotations/export?*', route => route.fulfill({ status: 401, body: '' }));
    await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
  });
  await scenario('same-context current-version reload and import restore paint and input', async ({ page, state }) => {
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(1);
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
    await expect.poll(() => painted(page)).toBe(true);
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(2);
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    const backup = { format: 'feedink-notes', version: 1, source: { url: state.document.context.sourceUrl, title: state.document.context.title, mode: 'feed', contentHash: state.document.contentHash }, ink: state.document.ink, marks: state.document.marks };
    const importedRevision = state.document.revision + 1;
    page.once('dialog', dialog => dialog.accept());
    await page.getByLabel('导入笔记 JSON', { exact: true }).setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.getByTestId('annotation-status')).toContainText(`修订 ${importedRevision}`);
    await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
    await expect.poll(() => painted(page)).toBe(true);
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(3);
  });
  await scenario('slow successful A automatically sends B, failures do not spin', async ({ page, state }) => {
    state.hold = deferred();
    await newNote(page, 'save A'); await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect.poll(() => state.writes).toBe(1);
    await page.locator('.annotation-list-item').click(); await page.getByTestId('note-editor').fill('save B');
    // Deliberately let B's one-second debounce expire while A is in flight.
    await page.waitForTimeout(1300); assert.equal(state.writes, 1);
    state.hold.resolve(); state.hold = null;
    await expect.poll(() => state.document.marks[0]?.text).toBe('save B');
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    state.failure = 503; await page.getByTestId('note-editor').fill('failed C');
    await expect(page.getByTestId('annotations-panel')).toContainText('未同步：');
    const count = state.writes; await page.waitForTimeout(2300); assert.equal(state.writes, count);
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    await expect(page.getByTestId('reader-content')).toBeVisible();
  });
  await scenario('retirement freezes edits and keeps latest B on local failure', async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await newNote(page, 'initial'); await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        const text = value.kind === 'annotations' && value.value.document.marks[0]?.text;
        if (text === 'draft B') throw new DOMException('Controlled draft B failure', 'QuotaExceededError');
        const req = put.call(this, value, ...args);
        if (text === 'draft A') Object.defineProperty(req, 'onsuccess', { set(callback) { req.addEventListener('success', event => { window.releaseDraftA = () => callback.call(req, event); }); } });
        return req;
      };
      window.restoreNoteWrites = () => { IDBObjectStore.prototype.put = put; };
    });
    await page.getByTestId('note-editor').fill('draft A');
    await expect.poll(() => page.evaluate(() => !!window.releaseDraftA)).toBe(true);
    await page.getByTestId('note-editor').fill('draft B');
    await page.getByTestId('reader').getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByTestId('note-editor')).toBeDisabled();
    await expect(page.getByTestId('note-editor')).toHaveValue('draft B');
    await page.evaluate(() => window.releaseDraftA());
    await expect(page.getByText(/未切换页面：/)).toBeVisible();
    await expect(page.getByTestId('note-editor')).toBeEnabled();
    await expect(page.getByTestId('note-editor')).toHaveValue('draft B');
    const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
    const backup = JSON.parse(await readFile(await (await downloaded).path(), 'utf8')); assert.equal(backup.marks[0].text, 'draft B');
    await page.evaluate(() => { window.restoreNoteWrites(); window.dispatchEvent(new Event('online')); });
    await page.getByTestId('annotations-panel').getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await page.getByTestId('reader').getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
  });
  await scenario('only explicit owned cached history opens on precise 409 or 404', async ({ page, state }) => {
    state.failure = 503; await newNote(page, 'H1 local pending');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect(page.getByTestId('annotations-panel')).toContainText('未同步：');
    state.document = { ...state.document, contentHash: 'b'.repeat(64), context: { ...state.document.context, contentHash: 'b'.repeat(64), contentHtml: '<p>H2 current body</p>' } };
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    for (const status of [409, 404]) {
      state.historyStatus = status;
      await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
      await expect(page.getByTestId('reader-content')).toContainText('H2 current body');
      await page.getByRole('button', { name: /^aaaaaaaaaaaa ·/ }).click();
      await expect(page.getByTestId('annotations-panel')).toContainText('H1 local pending');
      await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
      await expect(page.getByTestId('annotation-status')).not.toContainText('已同步');
      await expect(page.getByTestId('reader-content')).not.toContainText('H2 current body');
    }
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await expect(page.getByTestId('reader-content')).toContainText('H2 current body');
    // Cached conflict metadata is not an acknowledgement and must survive the fallback too.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('feedink-private-v1'); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('rows', 'readwrite'), rows = tx.objectStore('rows'), all = rows.getAll();
        all.onsuccess = () => { const cached = all.result.find(row => row.kind === 'annotations' && row.value.document.contentHash === 'a'.repeat(64)); cached.value.conflict = { ...cached.value.document, revision: 4, marks: [] }; rows.put(cached); };
        tx.oncomplete = () => { open.result.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    }));
    await page.getByRole('button', { name: /^aaaaaaaaaaaa ·/ }).click();
    await expect(page.getByTestId('annotation-status')).toContainText('冲突');
    await expect(page.getByTestId('annotations-panel')).toContainText('H1 local pending');
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await expect(page.getByTestId('reader-content')).toContainText('H2 current body');
    state.historyStatus = 409; state.historyCode = 'OTHER_CONFLICT';
    await page.getByRole('button', { name: /^aaaaaaaaaaaa ·/ }).click();
    await expect(page.getByTestId('annotation-status')).toContainText('载入失败');
    await expect(page.getByTestId('reader-content')).toContainText('H2 current body');
  });
}
