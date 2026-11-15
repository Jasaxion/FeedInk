// Controlled client-only regressions; run by annotations-browser.mjs in hosted CI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditFixture, deferred } from './audit-fixture.mjs';

export async function annotationRegressions(browser, expect) {
  async function scenario(name, run) {
    const fixture = await auditFixture(), context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage(); context.setDefaultTimeout(15000);
    const article = fixture.control.articles[0], hash = 'a'.repeat(64);
    const state = { document: { schemaVersion: 1, id: null, revision: 0, updatedAt: null, versions: [], contentHash: hash, context: { articleId: article.id, mode: 'feed', contentHash: hash, sourceUrl: article.url, title: article.title, contentHtml: article.contentHtml }, ink: null, marks: [] }, writes: 0, preconditionFailures: 0, failure: 0, hold: null, ackHold: null, historyStatus: 409, historyCode: 'ANNOTATION_CONTEXT', historyRequests: [], loadHold: null, loads: 0 };
    fixture.route(/^\/api\/articles\/one\/annotations(?:\/import)?$/, async ({ request, url, body, json }) => {
      if (url.pathname.endsWith('/import')) {
        assert.equal(url.search, '', 'import context is carried by the backup');
        assert.equal(request.headers['if-match'], `"${state.document.revision}"`);
        const backup = await body(); state.document = { ...state.document, ink: backup.ink, marks: backup.marks, revision: state.document.revision + 1 };
      } else if (request.method === 'PUT') {
        assert.deepEqual([...url.searchParams.keys()], ['mode'], 'PUT hash is carried by the payload');
        const payload = await body();
        if (request.headers['if-match'] !== `"${state.document.revision}"`) { state.preconditionFailures++; return json({ error: { code: 'ANNOTATION_CONFLICT', message: '版本冲突' } }, 412); }
        state.writes++; if (state.hold) await state.hold.promise;
        if (state.failure) return json({ error: { code: 'UNAVAILABLE', message: '受控保存失败' } }, state.failure);
        state.document = { ...state.document, ...payload, revision: state.document.revision + 1 };
        if (state.ackHold) await state.ackHold.promise;
      } else if (url.searchParams.has('contentHash') && url.searchParams.get('contentHash') !== state.document.contentHash) {
        state.historyRequests.push({ contentHash: url.searchParams.get('contentHash'), status: state.historyStatus, code: state.historyCode });
        return json({ error: { code: state.historyCode, message: '历史上下文不可用' } }, state.historyStatus);
      }
      if (request.method === 'GET') { state.loads++; if (state.loadHold) await state.loadHold.promise; }
      return json(state.document);
    });
    try {
      await page.goto(`${fixture.url}/?article=one`);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await page.getByTestId('annotation-toggle').click();
      await expect(page.getByTestId('annotation-status')).toContainText('已同步');
      // Let the initial workspace verification finish before targeting annotation-only paths.
      await expect.poll(() => fixture.control.sessionCalls).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('offline-status')).not.toContainText('正在同步');
      await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeEnabled();
      await run({ page, context, fixture, state });
      assert.deepEqual(fixture.routeErrors, []); assert.equal(fixture.control.rejectedCsrf, 0);
      console.log(`PASS annotation regression: ${name}`);
    } finally { state.hold?.resolve(); state.ackHold?.resolve(); state.loadHold?.resolve(); await context.close(); await fixture.close(); }
  }
  async function newNote(page, text) {
    await page.getByRole('button', { name: '整篇备注', exact: true }).click();
    await page.getByTestId('note-editor').fill(text);
  }
  async function draw(page, selectTool = true) {
    if (selectTool) {
      if (!await page.getByTestId('annotation-toolbar').isVisible()) await page.getByTestId('ink-toggle').click();
      await page.getByRole('button', { name: '钢笔', exact: true }).click();
    }
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
  await scenario('floating editor receives focus after its first visible layout', async ({ page }) => {
    await page.getByRole('button', { name: '整篇备注', exact: true }).click();
    await expect(page.getByTestId('note-editor')).toBeFocused();
    await page.keyboard.type('j remains note text, not article navigation');
    await expect(page.getByTestId('note-editor')).toHaveValue('j remains note text, not article navigation');
    await expect(page.getByTestId('reader-content')).toContainText('第一篇');
  });
  await scenario('closed tools still expose an unwritten note warning and recovery export', async ({ page }) => {
    await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) { if (value.kind === 'annotations') throw new DOMException('Controlled note quota', 'QuotaExceededError'); return put.call(this, value, ...args); };
    });
    await page.getByTestId('reader-content').evaluate(root => {
      const text = root.querySelector('p').firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(6, text.length));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    await page.getByTestId('selection-annotation-toolbar').getByRole('button', { name: '高亮', exact: true }).click();
    await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
    await expect(page.locator('.annotation-notice').getByRole('alert')).toContainText('笔记未保存');
    await page.getByRole('button', { name: '查看恢复选项', exact: true }).click();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
    const backup = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    assert.equal(backup.marks.length, 1); assert.equal(backup.marks[0].kind, 'highlight');
  });
  await scenario('reader ink stays below floating controls and inside the reading clip', async ({ page, state }) => {
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(1);
    await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByTestId('annotation-toggle').click();
    const layers = await page.locator('.annotation-drawer').evaluate(drawer => { const ink = document.querySelector('[data-webink-overlay]'); return { sameParent: ink.parentElement === drawer.parentElement, topLayer: ink.hasAttribute('popover'), ink: Number(getComputedStyle(ink).zIndex), drawer: Number(getComputedStyle(drawer).zIndex) }; });
    assert.equal(layers.sameParent, true); assert.equal(layers.topLayer, false); assert.ok(layers.drawer > layers.ink);
    await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
    await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
    await expect(page.locator('#reader-options')).toBeVisible();
    assert.equal(await page.locator('#reader-options').evaluate(node => node.matches(':popover-open')), true);
  });
  for (const width of [1280, 390]) await scenario(`contextual selection geometry and keyboard at ${width}px`, async ({ page, state }) => {
    await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
    await page.setViewportSize({ width, height: 844 });
    const body = page.getByTestId('reader-content');
    await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
    await expect(page.getByTestId('annotation-toolbar')).toHaveCount(0);
    const initial = await body.boundingBox();
    await page.getByTestId('annotation-toggle').click();
    const after = await body.boundingBox();
    assert.equal(after.y, initial.y, 'drawer must not push the body down');
    assert.equal(after.width, initial.width, 'drawer must not reflow text');
    await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
    await page.getByTestId('ink-toggle').click();
    assert.equal((await body.boundingBox()).y, initial.y, 'ink palette is out of flow');
    await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await expect(page.getByTestId('ink-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
    async function select() {
      await body.locator('p').first().scrollIntoViewIfNeeded();
      await body.evaluate(root => {
        const node = root.querySelector('p').firstChild, range = document.createRange();
        range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 6));
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect(page.getByTestId('selection-annotation-toolbar')).toBeVisible();
    }
    async function bounded(testId) {
      await expect.poll(() => page.getByTestId(testId).evaluate(node => {
        const box = node.getBoundingClientRect(), reader = document.querySelector('.reader-scroll').getBoundingClientRect(), viewport = window.visualViewport;
        const minX = Math.max(reader.left, viewport.offsetLeft), maxX = Math.min(reader.right, viewport.offsetLeft + viewport.width), minY = Math.max(reader.top, viewport.offsetTop), maxY = Math.min(reader.bottom, viewport.offsetTop + viewport.height);
        return box.left >= minX && box.right <= maxX + 1 && box.top >= minY && box.bottom <= maxY + 1 && node.parentElement.classList.contains('app-shell');
      })).toBe(true);
    }
    await select(); await bounded('selection-annotation-toolbar');
    await page.keyboard.press('Alt+Enter');
    await expect(page.getByTestId('selection-annotation-toolbar').getByRole('button', { name: '高亮', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('note-editor')).toHaveCount(0);
    await expect.poll(() => state.document.marks.length).toBe(1);
    assert.equal(state.document.marks[0].kind, 'highlight');
    await select(); await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection-annotation-toolbar')).toHaveCount(0);
    await expect(body).toBeVisible(); await expect(page).toHaveURL(/article=one/);
    await select(); await page.getByTestId('selection-annotation-toolbar').getByRole('button', { name: '备注', exact: true }).click();
    await expect(page.getByTestId('note-editor')).toBeFocused();
    await page.getByTestId('note-editor').fill('outside dismissal retains draft');
    await page.locator('.article-source').click();
    await expect(page.getByTestId('note-editor')).toHaveCount(0);
    await expect.poll(() => state.document.marks[1]?.text).toBe('outside dismissal retains draft');
    await body.evaluate(node => { node.style.minHeight = '1800px'; });
    await select();
    await page.locator('.reader-scroll').evaluate(node => { node.scrollTop += 35; });
    await bounded('selection-annotation-toolbar');
    await page.locator('.reader-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.getByTestId('selection-annotation-toolbar')).toHaveCount(0);
    await body.evaluate(node => { node.style.minHeight = ''; });
    await page.locator('.reader-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.getByTestId('annotation-toggle').click();
    await expect(page.getByTestId('annotations-panel')).toContainText('outside dismissal retains draft');
    await page.locator('.annotation-list-item').last().click();
    await expect(page.getByTestId('annotations-panel')).toBeVisible();
    await expect(page.getByTestId('note-editor')).toHaveValue('outside dismissal retains draft');
    await page.setViewportSize({ width, height: 460 });
    await expect(page.getByTestId('note-editor')).toBeVisible();
    await bounded('annotation-note-popover');
    await page.getByTestId('note-editor').press('Escape');
    await page.getByRole('button', { name: '关闭批注与笔记', exact: true }).click();
    await page.reload();
    await expect(page.locator('.text-mark')).not.toHaveCount(0);
    await expect(page.getByTestId('annotations-panel')).toHaveCount(0);
    await expect(page.getByTestId('annotation-toolbar')).toHaveCount(0);
  });
  for (const verification of ['401', '401-marker-failure', 'owner-mismatch']) await scenario(`focused annotation session ${verification} locks pending notes`, async ({ page, state, fixture }) => {
    state.failure = 503;
    await newNote(page, '必须隔离的草稿');
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    if (verification === '401-marker-failure') await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (['feedink-private-purge-pending', 'feedink-logout-pending'].includes(key)) throw new DOMException('marker unavailable', 'QuotaExceededError'); return set.call(this, key, value); };
    });
    fixture.route('/api/session', ({ json }) => verification.startsWith('401')
      ? json({ error: { code: 'UNAUTHORIZED', message: '登录失效' } }, 401)
      : json({ user: { ...fixture.control.user, id: 'bob' }, settings: fixture.control.settings, csrfToken: 'csrf-bob' }));
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => { const req = open.result.transaction('rows').objectStore('rows').getAll(); req.onsuccess = () => { resolve({ active: req.result.some(row => row.key === 'identity'), recovery: req.result.some(row => row.kind === 'annotation-recovery' && row.value.document.marks.some(mark => mark.text === '必须隔离的草稿')) }); open.result.close(); }; };
    }))).toEqual({ active: false, recovery: true });
  });
  await scenario('raw Markdown 401 locks without focus/reconnect', async ({ page, fixture }) => {
    fixture.route('/api/articles/one/annotations/export', ({ json }) => json(null, 401));
    await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
  });
  await scenario('same-context current-version reload and import restore paint and input', async ({ page, state }) => {
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(1);
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    if (await page.getByTestId('annotation-toolbar').isVisible()) await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByTestId('annotation-toggle').click();
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
    await expect.poll(() => painted(page)).toBe(true);
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(2);
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByTestId('annotation-toggle').click();
    const backup = { format: 'feedink-notes', version: 1, source: { url: state.document.context.sourceUrl, title: state.document.context.title, mode: 'feed', contentHash: state.document.contentHash }, ink: state.document.ink, marks: state.document.marks };
    const importedRevision = state.document.revision + 1;
    page.once('dialog', dialog => dialog.accept());
    await page.getByLabel('导入笔记 JSON', { exact: true }).setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.getByTestId('annotation-status')).toContainText(`修订 ${importedRevision}`);
    await page.getByTestId('reader-content').scrollIntoViewIfNeeded();
    await expect.poll(() => painted(page)).toBe(true);
    await draw(page); await expect.poll(() => state.document.ink?.strokes.length).toBe(3);
  });
  await scenario('slow successful A automatically sends B, failures do not spin', async ({ page, state, fixture }) => {
    // Keep note controls in view: auto-scrolling also queues an independent
    // workspace progress sync, which is not the annotation debounce under test.
    await page.setViewportSize({ width: 1280, height: 2000 });
    const stateWrites = fixture.control.writes.length;
    state.hold = deferred();
    await newNote(page, 'save A'); await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect.poll(() => state.writes).toBe(1);
    await page.locator('.annotation-list-item').click(); await page.getByTestId('note-editor').fill('save B');
    assert.equal(await page.locator('.reader-scroll').evaluate(element => element.scrollHeight <= element.clientHeight), true, 'debounce controls fit without scrolling');
    // Deliberately let B's one-second debounce expire while A is in flight.
    await page.waitForTimeout(1300); assert.equal(state.writes, 1);
    state.hold.resolve(); state.hold = null;
    await expect.poll(() => state.document.marks[0]?.text).toBe('save B');
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    assert.equal(state.writes, 2, 'one PUT each for A and B');
    state.failure = 503; await page.getByTestId('note-editor').fill('failed C');
    await expect(page.getByTestId('annotations-panel')).toContainText('未同步：');
    assert.equal(state.writes, 3, 'one failed PUT for C');
    // Observe beyond two debounce periods: failure must not self-rearm.
    await page.waitForTimeout(2300);
    assert.equal(fixture.control.writes.length, stateWrites, 'no independent progress sync during the debounce probe');
    assert.equal(state.writes, 3);
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    await expect(page.getByTestId('reader-content')).toBeVisible();
  });
  await scenario('manual failed save consumes its earlier pending debounce', async ({ page, state, fixture }) => {
    await page.setViewportSize({ width: 1280, height: 2000 });
    const stateWrites = fixture.control.writes.length;
    state.failure = 503;
    await newNote(page, 'manual save must not retry itself');
    assert.equal(await page.locator('.reader-scroll').evaluate(element => element.scrollHeight <= element.clientHeight), true, 'manual-save controls fit without scrolling');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect(page.getByTestId('annotations-panel')).toContainText('未同步：');
    assert.equal(state.writes, 1);
    // Two one-second debounce periods plus scheduling margin, not an eventual-success wait.
    await page.waitForTimeout(2300);
    assert.equal(fixture.control.writes.length, stateWrites, 'no independent progress sync during the manual-save probe');
    assert.equal(state.writes, 1);
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    assert.equal(state.document.revision, 0);
    await expect(page.getByTestId('annotations-panel')).toContainText('manual save must not retry itself');
  });
  await scenario('reload waits for its own server commit acknowledgement without a false conflict', async ({ page, state }) => {
    await page.setViewportSize({ width: 1280, height: 2400 });
    state.ackHold = deferred();
    await newNote(page, 'committed while acknowledgement is held');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect.poll(() => state.document.revision).toBe(1);
    if (await page.getByTestId('annotation-toolbar').isVisible()) await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    const loads = state.loads;
    const reload = page.getByRole('button', { name: '返回最新正文版本', exact: true });
    await reload.click(); await expect(reload).toBeDisabled();
    await page.waitForTimeout(1300);
    assert.equal(state.loads, loads, 'GET/local reconciliation cannot overtake the pending acknowledgement');
    state.ackHold.resolve(); state.ackHold = null;
    await expect.poll(() => state.loads).toBe(loads + 1);
    await expect(reload).toBeEnabled();
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await expect(page.getByTestId('annotation-status')).not.toContainText('冲突');
    assert.equal(state.writes, 1);
    await expect(page.getByTestId('annotations-panel')).toContainText('committed while acknowledgement is held');
  });
  await scenario('lost acknowledgement is confirmed by exact server data without a duplicate write', async ({ page, state }) => {
    await page.setViewportSize({ width: 1280, height: 2400 });
    const heldAck = deferred(); state.ackHold = heldAck;
    await newNote(page, 'durable note with lost response');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect.poll(() => state.document.revision).toBe(1);
    // Destroy the old document while its server response is withheld: IDB has no ACK.
    await page.reload(); heldAck.resolve(); state.ackHold = null;
    await page.getByTestId('annotation-toggle').click();
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await expect(page.getByTestId('annotation-status')).not.toContainText('冲突');
    await expect(page.getByTestId('annotations-panel')).toContainText('durable note with lost response');
    assert.ok(state.preconditionFailures <= 1, 'automatic authoritative load can confirm the lost acknowledgement before a stale PUT');
    assert.equal(state.document.revision, 1); assert.equal(state.writes, 1);
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
    await page.getByTestId('reader').getByRole('button', { name: '返回', exact: true }).focus();
    await page.getByTestId('reader').getByRole('button', { name: '返回', exact: true }).press('Enter');
    await expect(page.getByTestId('note-editor')).toBeDisabled();
    await expect(page.getByTestId('note-editor')).toHaveValue('draft B');
    await page.evaluate(() => window.releaseDraftA());
    await expect(page.getByText(/未切换页面：/)).toBeVisible();
    await expect(page.getByTestId('note-editor')).toBeEnabled();
    await expect(page.getByTestId('note-editor')).toHaveValue('draft B');
    await page.getByTestId('note-editor').press('Escape');
    const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
    const backup = JSON.parse(await readFile(await (await downloaded).path(), 'utf8')); assert.equal(backup.marks[0].text, 'draft B');
    await page.evaluate(() => { window.restoreNoteWrites(); window.dispatchEvent(new Event('online')); });
    await page.getByTestId('annotations-panel').getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
    await page.getByTestId('reader').getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
  });
  await scenario('slow same-context load rearms pending debounce when editing resumes', async ({ page, state, fixture }) => {
    await page.setViewportSize({ width: 1280, height: 2400 });
    const stateWrites = fixture.control.writes.length;
    state.loadHold = deferred();
    await newNote(page, 'pending through slow load');
    await page.getByTestId('note-editor').press('Escape');
    if (await page.getByTestId('annotation-toolbar').isVisible()) await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    const loads = state.loads;
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await expect.poll(() => state.loads).toBe(loads + 1);
    assert.equal(await page.locator('.reader-scroll').evaluate(element => element.scrollHeight <= element.clientHeight), true);
    await page.waitForTimeout(1300);
    assert.equal(fixture.control.writes.length, stateWrites, 'no progress-triggered workspace sync during the paused debounce');
    assert.equal(state.writes, 0);
    state.loadHold.resolve(); state.loadHold = null;
    await expect.poll(() => state.document.marks[0]?.text).toBe('pending through slow load');
    await expect(page.getByTestId('annotation-status')).toContainText('已同步');
  });
  await scenario('already-rejected retirement resumes the retained pen without switching tools', async ({ page, fixture }) => {
    const heldDetail = deferred();
    fixture.control.holdDetail = heldDetail;
    try {
    await page.getByRole('button', { name: '下一篇 (J)', exact: true }).click();
    await expect.poll(() => fixture.control.detailCaptured).toBe(true);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (value.kind === 'annotations') throw new DOMException('Controlled immediate pen failure', 'QuotaExceededError');
        return put.call(this, value, ...args);
      };
    });
    await draw(page);
    await expect(page.getByTestId('annotation-status')).toContainText('未保存');
    heldDetail.resolve();
    await expect(page.getByRole('alert').filter({ hasText: 'Controlled immediate pen failure' }).last()).toBeVisible();
    // Wait for the replacement attempt to finish; the old article and selected tool must survive.
    await expect(page.locator('.reader-loading')).toHaveCount(0);
    await expect(page.getByTestId('reader-content')).toContainText('第一篇');
    await expect(page.getByRole('button', { name: '钢笔', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await draw(page, false);
    await page.getByRole('button', { name: '退出手写', exact: true }).click();
    await page.getByTestId('annotation-toggle').click();
    await expect(page.getByTestId('annotations-panel').getByRole('heading', { name: /手写 2 笔/ })).toBeVisible();
    const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
    assert.equal(JSON.parse(await readFile(await (await downloaded).path(), 'utf8')).ink.strokes.length, 2);
    } finally { heldDetail.resolve(); }
  });
  for (const blockedMarker of [false, true]) await scenario(`locked exit quarantines durable notes (marker-only failure: ${blockedMarker})`, async ({ page, state, fixture }) => {
    state.failure = 503; await newNote(page, 'durable locked exit witness');
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    if (blockedMarker) await page.evaluate(() => { Storage.prototype.setItem = function() { throw new DOMException('marker-only failure', 'QuotaExceededError'); }; });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '锁定笔记并退出', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => new Promise(resolve => {
      const open = indexedDB.open('feedink-private-v1'); open.onsuccess = () => {
        const read = open.result.transaction('rows').objectStore('rows').getAll();
        read.onsuccess = () => { resolve({ identity: read.result.some(row => row.key === 'identity'), ordinaryCache: read.result.some(row => ['article', 'image'].includes(row.kind)), recovery: read.result.some(row => row.kind === 'annotation-recovery' && row.value.document.marks.some(mark => mark.text === 'durable locked exit witness')) }); open.result.close(); };
      };
    }))).toEqual({ identity: false, ordinaryCache: false, recovery: true });
    if (blockedMarker) {
      assert.equal(fixture.control.logouts, 0);
      let foreignLogins = 0;
      fixture.route('/api/auth/login', ({ json }) => { foreignLogins++; return json({}, 401); });
      await page.getByLabel('邮箱', { exact: true }).fill('bob@example.test');
      await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '请先登录原账号' })).toBeVisible();
      assert.equal(foreignLogins, 0);
    } else assert.equal(await page.evaluate(() => localStorage.getItem('feedink-private-purge-pending')), '1');
  });
  for (const blockedMarker of [false, true]) await scenario(`unreadable storage locked exit preserves memory, guard and recovery (marker blocked: ${blockedMarker})`, async ({ page, fixture, state }) => {
    state.failure = 503;
    await newNote(page, 'locked exit memory witness');
    await expect(page.getByTestId('annotation-status')).toContainText('本地待同步');
    let logins = 0;
    fixture.route('/api/auth/login', ({ json }) => {
      logins++; fixture.control.loggedIn = true;
      return json({ user: fixture.control.user, settings: fixture.control.settings, csrfToken: 'csrf-alice' });
    });
    await page.evaluate(blockedMarker => {
      const transaction = IDBDatabase.prototype.transaction, setItem = Storage.prototype.setItem;
      IDBDatabase.prototype.transaction = function(...args) { if (this.name === 'feedink-private-v1') throw new DOMException('Controlled unreadable notes', 'UnknownError'); return transaction.apply(this, args); };
      if (blockedMarker) Storage.prototype.setItem = function() { throw new DOMException('Controlled marker failure', 'QuotaExceededError'); };
      window.restoreExitStorage = () => { IDBDatabase.prototype.transaction = transaction; Storage.prototype.setItem = setItem; };
    }, blockedMarker);
    // This latest edit exists only in the mounted component, not the old persisted row.
    await page.getByTestId('note-editor').fill('latest memory-only locked exit witness');
    await expect(page.getByTestId('annotation-status')).toContainText('未保存');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '锁定笔记并退出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await expect(page.getByTestId('reader-content')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '导出 JSON', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: '无法确认存储已持久保存时' })).toBeVisible();
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    if (blockedMarker) assert.equal(fixture.control.logouts, 0);
    else assert.equal(await page.evaluate(() => localStorage.getItem('feedink-private-purge-pending')), '1');
    await page.getByLabel('邮箱', { exact: true }).fill('bob@example.test');
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '请先登录原账号' })).toBeVisible(); assert.equal(logins, 0);
    await page.getByLabel('邮箱', { exact: true }).fill('alice@example.test');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Controlled unreadable notes' })).toBeVisible(); assert.equal(logins, 0);
    await page.evaluate(() => window.restoreExitStorage()); state.failure = 0;
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByTestId('article-card').filter({ hasText: '第一篇' }).click();
    await page.getByTestId('annotation-toggle').click();
    await expect(page.getByTestId('annotations-panel')).toContainText('latest memory-only locked exit witness');
    // The older persisted version is preserved as a conflict, never silently overwritten.
    await expect(page.getByTestId('annotation-status')).toContainText('冲突');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '保留本地版本', exact: true }).click();
    await expect.poll(() => state.document.marks[0]?.text).toBe('latest memory-only locked exit witness');
    assert.equal(logins, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('feedink-private-purge-pending')), null);
  });
  await scenario('only explicit owned cached history opens on precise 409 or 404', async ({ page, state }) => {
    state.failure = 503; await newNote(page, 'H1 local pending');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect(page.getByTestId('annotations-panel')).toContainText('未同步：');
    state.document = { ...state.document, contentHash: 'b'.repeat(64), context: { ...state.document.context, contentHash: 'b'.repeat(64), contentHtml: '<p>H2 current body</p>' } };
    if (await page.getByTestId('annotation-toolbar').isVisible()) await page.getByRole('button', { name: '退出手写', exact: true }).click();
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
    const requests = state.historyRequests.length;
    await page.getByRole('button', { name: /^aaaaaaaaaaaa ·/ }).click();
    await expect.poll(() => state.historyRequests.length).toBe(requests + 1);
    assert.deepEqual(state.historyRequests.at(-1), { contentHash: 'a'.repeat(64), status: 409, code: 'OTHER_CONFLICT' });
    // A background refresh may report the still-active H2 as synchronized; the
    // persistent load error and unchanged body prove the rejected history was not opened.
    await expect(page.getByTestId('annotations-panel').getByRole('alert')).toHaveText('历史上下文不可用');
    await expect(page.getByTestId('reader-content')).toContainText('H2 current body');
    await expect(page.getByTestId('annotations-panel')).not.toContainText('H1 local pending');
  });
}
