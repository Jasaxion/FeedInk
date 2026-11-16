// Called by the existing hosted-only AI browser runner; synthetic management/lifecycle coverage.
import assert from 'node:assert/strict';
import { deferred } from './audit-fixture.mjs';
import { aiResultsFixture } from './ai-results-fixture.mjs';

export async function aiResultsRegressions(browser, expect) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('AI result fixtures require approved GitHub-hosted execution.');
  const calls = (fixture, method) => fixture.results.calls.filter(call => call.method === method);
  const panel = page => page.getByTestId('ai-results');
  const selected = (page, id) => panel(page).locator(`[data-result-id="${id}"] input[type=checkbox]`);
  const changePath = (page, path) => page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  async function openSettings(page) {
    await changePath(page, '/settings/ai?article=one');
    await expect(page.getByRole('form', { name: 'AI 模型设置' })).toBeVisible();
  }
  async function openResults(page) {
    await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    await expect(panel(page).getByTestId('ai-results-total')).toBeVisible();
  }
  async function confirmDelete(page, accept = true) {
    const dialog = page.waitForEvent('dialog');
    const click = panel(page).getByRole('button', { name: /^清理所选结果/ }).click();
    const prompt = await dialog;
    assert.match(prompt.message(), /可能产生模型请求费用/);
    assert.match(prompt.message(), /不会取消运行中的任务/);
    assert.equal(prompt.type(), 'confirm');
    if (accept) await prompt.accept(); else await prompt.dismiss();
    await click;
  }
  async function startSummary(page) {
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click();
    await page.getByRole('button', { name: '生成摘要', exact: true }).click();
  }
  async function scenario(name, action, setup = () => {}) {
    const fixture = await aiResultsFixture(), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [], gates = [];
    context.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const gate = () => { const value = deferred(); gates.push(value); return value; };
    try {
      // Keep late responses observable even when the UI aborts their original fetch.
      await context.addInitScript(() => {
        const original = window.fetch;
        window.fetch = (input, init) => String(input).includes('/ai') ? original(input, { ...init, signal: undefined }) : original(input, init);
        window.__aiRetirements = [];
        window.addEventListener('feedink:ai-results-retired', event => window.__aiRetirements.push(event.detail));
      });
      await setup({ fixture, context, page });
      await page.goto(`${fixture.url}/?article=one`);
      await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
      await action({ fixture, context, page, gate });
      assert.deepEqual(errors, []); assert.deepEqual(fixture.routeErrors, []); assert.equal(fixture.control.rejectedCsrf, 0);
      console.log(`PASS ai-results-browser: ${name}`);
    } finally { gates.forEach(gate => gate.resolve()); await context.close(); await fixture.close(); }
  }

  await scenario('collapsed by default, exact owned metadata pages, old results, cancel and selected cleanup', async ({ fixture, page }) => {
    fixture.ai.config.enabled = false; fixture.ai.config.hasKey = false;
    const source = structuredClone({ html: fixture.control.articles[0].contentHtml, images: fixture.control.articles[0].images, config: fixture.ai.config });
    fixture.results.rows.get('retained-23').sourceTitle = 'Retained source 23 <img src="https://injected.invalid/metadata">';
    assert.equal(fixture.results.calls.length, 0);
    await openSettings(page); await expect(panel(page)).toHaveCount(0); assert.equal(fixture.results.calls.length, 0);
    await openResults(page);
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText('本次查询共 23 条已结束记录');
    await expect(panel(page).locator('[data-result-id]')).toHaveCount(20);
    await expect(panel(page)).not.toContainText('Bob-only'); await expect(panel(page)).not.toContainText('Running task');
    const row = panel(page).locator('[data-result-id="retained-23"]');
    await expect(row).toContainText('摘要 · zh-CN · 已取消'); await expect(row).toContainText('retained-synthetic-model');
    await expect(row).toContainText('<img src='); await expect(panel(page).locator('img')).toHaveCount(0);
    await expect(row.locator('time').first()).toHaveAttribute('datetime', '2010-01-01T00:00:00.000023Z');
    assert.equal(calls(fixture, 'GET').length, 1);
    await selected(page, 'retained-23').check();
    await panel(page).getByRole('button', { name: '下一页结果', exact: true }).click();
    await expect(panel(page).locator('[data-result-id]')).toHaveCount(3);
    const cursor = calls(fixture, 'GET')[1].cursor;
    assert.deepEqual(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')), ['2010-01-01T00:00:00.000004Z', 'retained-04']);
    await selected(page, 'retained-01').check();
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 2 条');
    await confirmDelete(page, false);
    assert.equal(calls(fixture, 'DELETE').length, 0); assert.equal(await page.evaluate(() => window.__aiRetirements.length), 0);
    assert.equal(fixture.results.rows.size, 25); await expect(selected(page, 'retained-01')).toBeChecked();
    await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText('本次查询共 21 条已结束记录');
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    assert.deepEqual(calls(fixture, 'DELETE')[0].ids, ['retained-23', 'retained-01']);
    assert.equal(fixture.results.rows.has('retained-23'), false); assert.equal(fixture.results.rows.has('retained-01'), false);
    assert.equal(fixture.results.rows.has('foreign-result'), true); assert.equal(fixture.results.rows.get('active-result').status, 'running');
    assert.deepEqual({ html: fixture.control.articles[0].contentHtml, images: fixture.control.articles[0].images, config: fixture.ai.config }, source);
    assert.equal(fixture.ai.providerCalls, 0); assert.equal(fixture.ai.annotationWrites.length, 0); assert.equal(fixture.ai.calls.some(call => call.kind === 'cancel'), false);
    for (const width of [320, 390, 768]) { await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
  });

  for (const mismatch of ['foreign', 'missing', 'active']) await scenario(`mixed ${mismatch} selection is rejected atomically and remains selected`, async ({ fixture, page }) => {
    await openSettings(page); await openResults(page);
    await selected(page, 'retained-23').check(); await selected(page, 'retained-22').check();
    if (mismatch === 'foreign') fixture.results.rows.get('retained-22').owner = 'bob';
    else if (mismatch === 'active') fixture.results.rows.get('retained-22').status = 'running';
    else fixture.results.rows.delete('retained-22');
    await confirmDelete(page);
    await expect(panel(page).getByRole('alert')).toContainText('已保留选择');
    await expect(selected(page, 'retained-23')).toBeChecked(); await expect(selected(page, 'retained-22')).toBeChecked();
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 2 条');
    assert.equal(fixture.results.rows.has('retained-23'), true); assert.deepEqual(fixture.results.deleted, []);
    assert.equal(calls(fixture, 'GET').length, 1); assert.equal(fixture.ai.providerCalls, 0);
    await panel(page).getByRole('button', { name: '刷新并返回首页', exact: true }).click();
    await expect(selected(page, 'retained-22')).toHaveCount(0);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 2 条');
    await panel(page).getByRole('button', { name: '清空选择', exact: true }).click();
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    await selected(page, 'retained-23').check(); await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    assert.deepEqual(calls(fixture, 'DELETE').at(-1).ids, ['retained-23']);
    assert.equal(fixture.results.rows.has('retained-23'), false);
  });

  await scenario('committed DELETE with lost reply retains hidden selection until explicit clear, then valid cleanup succeeds', async ({ fixture, page }) => {
    await openSettings(page); await openResults(page); await selected(page, 'retained-23').check();
    fixture.results.loseDeleteReply = true; await confirmDelete(page);
    await expect(panel(page).getByRole('alert')).toContainText('已保留选择');
    assert.equal(fixture.results.rows.has('retained-23'), false);
    await panel(page).getByRole('button', { name: '刷新并返回首页', exact: true }).click();
    await expect(selected(page, 'retained-23')).toHaveCount(0);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 1 条');
    assert.equal(calls(fixture, 'DELETE').length, 1);
    await panel(page).getByRole('button', { name: '清空选择', exact: true }).click();
    await selected(page, 'retained-22').check(); await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    assert.deepEqual(calls(fixture, 'DELETE').map(call => call.ids), [['retained-23'], ['retained-22']]);
    assert.equal(fixture.ai.providerCalls, 0);
  });

  await scenario('failed list preserves selections and failed post-delete refresh never repeats DELETE', async ({ fixture, page }) => {
    await openSettings(page); await openResults(page); await selected(page, 'retained-23').check();
    fixture.results.failList = true;
    await panel(page).getByRole('button', { name: '下一页结果', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('无法读取'); await expect(selected(page, 'retained-23')).toBeChecked();
    await confirmDelete(page);
    await expect(panel(page).getByRole('alert')).toContainText('清理已完成，但列表刷新失败');
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    assert.equal(calls(fixture, 'DELETE').length, 1);
    fixture.results.failList = false;
    await panel(page).getByRole('button', { name: '读取已保存结果', exact: true }).click();
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText('本次查询共 22 条已结束记录');
    assert.equal(calls(fixture, 'DELETE').length, 1); assert.equal(fixture.ai.providerCalls, 0);
  });

  await scenario('collapsed manager retires late metadata without adding idle reloads', async ({ fixture, page, gate }) => {
    fixture.results.holdList = gate(); const held = fixture.results.holdList;
    await openSettings(page); await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    await expect.poll(() => calls(fixture, 'GET').length).toBe(1);
    await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    fixture.results.rows.clear(); await openResults(page);
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText('本次查询共 0 条已结束记录');
    held.resolve(); await page.waitForTimeout(100);
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText('本次查询共 0 条已结束记录');
    await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    assert.equal(calls(fixture, 'GET').length, 2); assert.equal(fixture.ai.providerCalls, 0);
  });

  await scenario('cancel keeps selected reader result; cleanup failure retires only its presentation and keeps selection', async ({ fixture, page }) => {
    fixture.ai.autoComplete = true; await startSummary(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    const id = [...fixture.ai.jobs.keys()][0];
    await openSettings(page); await openResults(page); await selected(page, id).check();
    await confirmDelete(page, false);
    await expect(page.getByTestId('ai-summary')).toHaveCount(1); assert.equal(await page.evaluate(() => window.__aiRetirements.length), 0);
    fixture.results.rejectDelete = true; await confirmDelete(page);
    await expect(panel(page).getByRole('alert')).toContainText('已保留选择'); await expect(selected(page, id)).toBeChecked();
    await expect(page.getByTestId('ai-card')).toHaveCount(0); assert.equal(fixture.ai.jobs.has(id), true);
    await changePath(page, '/?article=one'); await startSummary(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    assert.equal(fixture.ai.providerCalls, 1, 'explicit retrieval can reuse the retained result after failed cleanup');
    assert.equal(fixture.ai.calls.some(call => call.kind === 'cancel'), false);
  });

  await scenario('unrelated cleanup preserves reader result and active job without provider or cancellation calls', async ({ fixture, page }) => {
    fixture.ai.autoComplete = true; await startSummary(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    const id = [...fixture.ai.jobs.keys()][0];
    await openSettings(page); await openResults(page); await selected(page, 'retained-23').check(); await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    await changePath(page, '/?article=one'); await expect(page.getByTestId('ai-summary')).toBeVisible();
    assert.equal(fixture.ai.jobs.has(id), true); assert.equal(fixture.results.rows.get('active-result').status, 'running');
    assert.equal(fixture.ai.providerCalls, 1); assert.equal(fixture.ai.calls.some(call => call.kind === 'cancel'), false);
  });

  await scenario('cleaning a terminal record does not retire or cancel a different running reader job', async ({ fixture, page }) => {
    await startSummary(page); await expect(page.getByTestId('ai-progress')).toContainText('1 / 131');
    const id = [...fixture.ai.jobs.keys()][0];
    await openSettings(page); await openResults(page);
    await expect(panel(page).locator(`[data-result-id="${id}"]`)).toHaveCount(0);
    await selected(page, 'retained-23').check(); await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    await changePath(page, '/?article=one'); await expect(page.getByTestId('ai-progress')).toContainText('1 / 131');
    assert.equal(fixture.ai.jobs.get(id).status, 'running'); assert.equal(fixture.ai.providerCalls, 1);
    assert.equal(fixture.ai.calls.some(call => call.kind === 'cancel'), false);
  });

  await scenario('confirmed selected cleanup stays retired when settings closes before the DELETE reply', async ({ fixture, page, gate }) => {
    fixture.ai.autoComplete = true; await startSummary(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    const id = [...fixture.ai.jobs.keys()][0];
    await page.getByTestId('reader-content').evaluate(root => { window.__cleanupOriginal = root; window.__cleanupHtml = root.innerHTML; });
    await openSettings(page); await openResults(page); await selected(page, id).check();
    fixture.results.holdDeleteReply = gate(); const held = fixture.results.holdDeleteReply;
    await confirmDelete(page); await expect.poll(() => fixture.results.deleted.length).toBe(1);
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
    const reads = calls(fixture, 'GET').length;
    await changePath(page, '/?article=one'); held.resolve(); await page.waitForTimeout(100);
    await expect(page.getByTestId('ai-card')).toHaveCount(0); assert.equal(calls(fixture, 'GET').length, reads);
    assert.equal(fixture.ai.providerCalls, 1); assert.equal(fixture.ai.calls.some(call => call.kind === 'cancel'), false);
    assert.equal(await page.getByTestId('reader-content').evaluate(root => root === window.__cleanupOriginal && root.innerHTML === window.__cleanupHtml), true);
  });

  await scenario('deleted terminal ID in a late initial POST reply cannot resurface after cleanup', async ({ fixture, page, gate }) => {
    fixture.ai.autoComplete = true; fixture.ai.holdPost = gate(); const held = fixture.ai.holdPost;
    await startSummary(page); await expect.poll(() => fixture.ai.providerCalls).toBe(1);
    const id = [...fixture.ai.jobs.keys()][0];
    await openSettings(page); await openResults(page); await selected(page, id).check(); await confirmDelete(page);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 0 条');
    held.resolve(); await changePath(page, '/?article=one'); await page.waitForTimeout(100);
    await expect(page.getByTestId('ai-card')).toHaveCount(0); assert.equal(fixture.ai.providerCalls, 1);
  });

  for (const operation of ['list', 'delete']) for (const nextOwner of ['bob', 'alice']) await scenario(`late ${operation} cannot cross ${nextOwner === 'alice' ? 'same-owner reauthentication' : 'accounts'}`, async ({ fixture, page, gate }) => {
    fixture.control.articles[0].title = 'Same synthetic article for auth-race fixture';
    await openSettings(page);
    let held;
    if (operation === 'list') {
      fixture.results.rows.get('retained-23').sourceTitle = 'Old-epoch metadata must not return';
      fixture.results.holdList = gate(); held = fixture.results.holdList;
      await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click(); await expect.poll(() => calls(fixture, 'GET').length).toBe(1);
    } else {
      await openResults(page); await selected(page, 'retained-23').check();
      fixture.results.holdDeleteReply = gate(); held = fixture.results.holdDeleteReply;
      await confirmDelete(page); await expect.poll(() => fixture.results.deleted.length).toBe(1);
    }
    fixture.results.rows.get('retained-22').sourceTitle = 'Current-epoch retained source';
    if (fixture.results.rows.has('retained-23')) fixture.results.rows.get('retained-23').sourceTitle = 'Current-epoch newest source';
    fixture.route('/api/auth/login', async ({ json }) => {
      fixture.control.user = { ...fixture.control.user, id: nextOwner, name: nextOwner, email: `${nextOwner}@example.test` }; fixture.control.loggedIn = true;
      return json({ user: fixture.control.user, settings: fixture.control.settings, csrfToken: `csrf-${nextOwner}` });
    });
    fixture.control.loggedIn = false; await page.evaluate(() => window.dispatchEvent(new Event('feedink:unauthorized')));
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await page.getByLabel('邮箱', { exact: true }).fill(`${nextOwner}@example.test`); await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openSettings(page); await expect(panel(page)).toHaveCount(0); await openResults(page);
    const currentId = nextOwner === 'bob' ? 'foreign-result' : 'retained-22';
    await selected(page, currentId).check();
    const total = nextOwner === 'bob' ? 1 : operation === 'delete' ? 22 : 23;
    const reads = calls(fixture, 'GET').length, retirements = await page.evaluate(() => window.__aiRetirements.length);
    held.resolve(); await page.waitForTimeout(100);
    await expect(panel(page).getByTestId('ai-results-total')).toHaveText(`本次查询共 ${total} 条已结束记录`);
    await expect(panel(page).getByTestId('ai-results-selected')).toContainText('已选 1 条'); await expect(selected(page, currentId)).toBeChecked();
    await expect(panel(page)).not.toContainText('Old-epoch metadata'); await expect(panel(page)).not.toContainText('已清理');
    assert.equal(calls(fixture, 'GET').length, reads); assert.equal(await page.evaluate(() => window.__aiRetirements.length), retirements);
    if (operation === 'delete') {
      const old = await page.evaluate(() => window.__aiRetirements[0]);
      await changePath(page, '/?article=one'); fixture.ai.autoComplete = true;
      await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
      await startSummary(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
      const id = [...fixture.ai.jobs.keys()][0];
      await page.evaluate(({ old, id }) => window.dispatchEvent(new CustomEvent('feedink:ai-results-retired', { detail: { ...old, ids: [id] } })), { old, id });
      await expect(page.getByTestId('ai-summary')).toBeVisible();
    }
  });

  await scenario('offline and demo management never issue metadata or cleanup calls', async ({ fixture, context, page }) => {
    await openSettings(page); await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    await expect(panel(page)).toContainText('离线时无法读取或清理'); assert.equal(fixture.results.calls.length, 0);
    await context.setOffline(false);
  });
  await scenario('demo management is unavailable without probing results', async ({ fixture, page }) => {
    await openSettings(page); await page.getByRole('button', { name: '管理已保存 AI 结果', exact: true }).click();
    await expect(panel(page)).toContainText('演示账号不能管理'); assert.equal(fixture.results.calls.length, 0);
  }, async ({ fixture }) => { fixture.control.user.isDemo = true; });
}
