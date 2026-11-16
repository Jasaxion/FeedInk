// Hosted-only synthetic UI acceptance. Build the integrated web/shared/ink workspaces first.
import assert from 'node:assert/strict';
import { aiFixture } from './ai-fixture.mjs';
import { closeAiSettings, openAiSettings, signInToAiReader } from './ai-browser-ui.mjs';
import { aiResultsRegressions } from './ai-results-browser.mjs';
import { aiReadingRegressions } from './ai-reading-regressions.mjs';
import { deferred, emptyAnnotationDocument } from './audit-fixture.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('AI browser fixtures run only on approved GitHub-hosted runners.');
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true, executablePath: process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const counts = (ai, kind) => ai.calls.filter(call => call.kind === kind).length;
async function scenario(name, action, setup = () => {}) {
  const fixture = await aiFixture(), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [], gates = [];
  context.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  try {
    await setup({ fixture, context, page });
    await page.goto(`${fixture.url}/?article=one`);
    await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
    await action({ fixture, ai: fixture.ai, context, page, gate });
    assert.deepEqual(errors, []); assert.deepEqual(fixture.routeErrors, []); assert.equal(fixture.control.rejectedCsrf, 0);
    console.log(`PASS ai-browser: ${name}`);
  } finally { gates.forEach(gate => gate.resolve()); await context.close(); await fixture.close(); }
}
async function openAi(page, operation = 'summary') {
  await page.getByRole('button', { name: operation === 'summary' ? 'AI 摘要' : 'AI 双语翻译', exact: true }).click();
  await expect(page.getByTestId('ai-card').getByLabel('本次目标语言')).toBeVisible();
}
async function startAi(page, operation = 'summary') {
  await openAi(page, operation);
  await page.getByRole('button', { name: operation === 'summary' ? '生成摘要' : '生成双语翻译', exact: true }).click();
}
async function fulltext(page, label) {
  const direct = page.locator(`.reader-toolbar button[aria-label="${label}"]:visible`);
  if (await direct.count()) await direct.click();
  else { await page.getByRole('button', { name: '更多文章操作', exact: true }).click(); await page.getByRole('button', { name: label, exact: true }).click(); }
}
async function ignoreAiAbort(context) {
  await context.addInitScript(() => { const original = window.fetch; window.fetch = (input, init) => String(input).includes('/ai') ? original(input, { ...init, signal: undefined }) : original(input, init); });
}
try {
  await scenario('idle-free responsive icons and unchanged fulltext toggle', async ({ page, fixture, ai }) => {
    await expect(page.getByTestId('ai-card')).toHaveCount(0); assert.equal(ai.calls.length, 0);
    for (const width of [320, 360, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['AI 摘要', 'AI 双语翻译']) {
        const button = page.getByRole('button', { name, exact: true }); await expect(button).toBeVisible();
        const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, `target at ${width}`);
        assert.ok(box.x >= 0 && box.x + box.width <= width, `reachable at ${width}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await fulltext(page, '显示全文'); await expect(page.getByTestId('reader-content')).toContainText('Fulltext original tail');
    await fulltext(page, '取消全文显示'); await expect(page.getByTestId('reader-content')).toContainText('Original long tail witness');
    await page.getByRole('button', { name: '下一篇 (J)', exact: true }).click(); await expect(page.getByTestId('reader-content')).toContainText('第二篇独立阅读正文');
    assert.equal(ai.calls.length, 0);
    assert.equal(fixture.ai.providerCalls, 0);
    const summary = page.getByRole('button', { name: 'AI 摘要', exact: true }); await summary.focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('ai-card')).toBeFocused(); await page.keyboard.press('Escape');
    await expect(page.getByTestId('ai-card')).toHaveCount(0); await expect(summary).toBeFocused(); assert.equal(fixture.ai.providerCalls, 0);
  });
  await scenario('collapsed eink toolbar keeps both AI and original annotation targets reachable', async ({ page, ai }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const name of ['AI 摘要', 'AI 双语翻译', '批注与笔记', '手写批注']) {
      const button = page.getByRole('button', { name, exact: true }); await expect(button).toBeVisible();
      const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 320);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: '显示工具栏', exact: true }).click();
    await fulltext(page, '显示全文'); await expect(page.getByTestId('reader-content')).toContainText('Fulltext original tail');
    assert.equal(ai.calls.length, 0);
  }, async ({ fixture }) => { fixture.control.settings.theme = 'eink'; fixture.control.settings.hideToolbar = true; });
  await scenario('masked config, omitted/replaced/cleared keys, failed draft preservation, explicit saved-config test', async ({ page, ai }) => {
    await openAiSettings(page, expect);
    const settings = page.getByRole('form', { name: 'AI 模型设置' });
    await expect(page.getByTestId('ai-key-status')).toHaveText('已保存密钥（不可读取）');
    await expect(settings.getByLabel('替换 API 密钥')).toHaveValue('');
    assert.equal(counts(ai, 'test'), 0);
    await settings.getByLabel('模型名称').fill('new-unsaved-model');
    await settings.getByLabel('默认目标语言').selectOption('en');
    await settings.getByRole('button', { name: '测试已保存配置（会发送请求）', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('连接测试成功');
    assert.equal(ai.calls.find(call => call.kind === 'test').model, 'synthetic-model');
    ai.saveFails = true;
    await settings.getByLabel('替换 API 密钥').fill('fixture-only-key-not-a-secret');
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(settings.getByRole('alert')).toBeVisible();
    await expect(settings.getByLabel('替换 API 密钥')).toHaveValue('fixture-only-key-not-a-secret');
    await expect(settings.getByLabel('模型名称')).toHaveValue('new-unsaved-model');
    ai.saveFails = false;
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(settings.getByLabel('替换 API 密钥')).toHaveValue('');
    assert.equal(ai.calls.filter(call => call.kind === 'save').at(-1).data.apiKey, 'fixture-only-key-not-a-secret');
    assert.equal(ai.config.targetLanguage, 'en');
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(settings.getByRole('button', { name: '保存 AI 配置', exact: true })).toBeEnabled();
    assert.equal(Object.hasOwn(ai.calls.filter(call => call.kind === 'save').at(-1).data, 'apiKey'), false);
    await settings.getByLabel('清除已保存密钥（保存后生效）').check();
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(page.getByTestId('ai-key-status')).toHaveText('尚未保存密钥');
    assert.equal(ai.calls.filter(call => call.kind === 'save').at(-1).data.apiKey, null);
    await expect(settings.getByRole('button', { name: '测试已保存配置（会发送请求）', exact: true })).toBeDisabled();
  });
  await scenario('saving a new configuration retires the previous selected request without losing saved drafts', async ({ page, ai, gate }) => {
    ai.autoComplete = true; ai.holdPost = gate(); const held = ai.holdPost;
    await startAi(page); await expect.poll(() => counts(ai, 'post')).toBe(1);
    await openAiSettings(page, expect);
    const settings = page.getByRole('form', { name: 'AI 模型设置' });
    await settings.getByLabel('模型名称').fill('replacement-model');
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('AI 配置已保存');
    await closeAiSettings(page, expect); held.resolve();
    await page.waitForTimeout(200); await expect(page.getByTestId('ai-card')).toHaveCount(0);
    await startAi(page); await expect(page.getByTestId('ai-summary')).toBeVisible(); assert.equal(ai.providerCalls, 2);
  }, async ({ context }) => ignoreAiAbort(context));
  await scenario('explicit owned cached summary, complete long bilingual tail, safe images/links and original annotation identity', async ({ page, ai, context, fixture }) => {
    ai.autoComplete = true;
    let external = 0;
    await context.route('https://injected.invalid/**', route => { external++; return route.abort(); });
    const original = page.getByTestId('reader-content');
    await original.evaluate(root => { window.__aiOriginal = root; window.__aiSourceText = root.textContent; });
    await openAi(page); assert.equal(counts(ai, 'post'), 0);
    await expect(page.getByLabel('本次目标语言')).toHaveValue('zh-CN');
    await page.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect(page.getByTestId('ai-summary')).toContainText('long tail');
    assert.equal(counts(ai, 'poll'), 0);
    assert.equal(ai.calls.find(call => call.kind === 'post').data.contentHash, 'a'.repeat(64));
    await expect(page.getByTestId('ai-summary').locator('img')).toHaveCount(0);
    assert.ok((await page.getByTestId('ai-summary').boundingBox()).y < (await original.boundingBox()).y);
    await page.getByRole('button', { name: '收起 AI', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
    await startAi(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    assert.equal(ai.providerCalls, 1, 'owned matching completion reused only on explicit POST');
    // Seed only synthetic owned bytes; failed network images must not hide the IDB replacement.
    await page.evaluate(async () => {
      const bytes = await (await fetch('/api/assets/image-one')).arrayBuffer();
      await new Promise((resolve, reject) => { const open = indexedDB.open('feedink-private-v1'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('rows', 'readwrite'); tx.objectStore('rows').put({ key: 'alice:image:/api/assets/image-one', userId: 'alice', kind: 'image', value: { type: 'image/png', bytes } }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
    });
    fixture.route('/api/assets/image-one', ({ json }) => json({ error: { code: 'SYNTHETIC_OFFLINE', message: 'asset unavailable' } }, 503));
    await startAi(page, 'translate');
    await expect(page.getByTestId('ai-bilingual')).toContainText('译文末尾覆盖见证');
    await expect(page.locator('.ai-bilingual .feedink-ai-pair')).toHaveCount(131);
    await expect(page.locator('.ai-bilingual div.feedink-ai-target[lang="zh-CN"]')).toHaveCount(131);
    await expect(page.getByTestId('ai-progress')).toContainText('131 / 131');
    await expect(page.locator('.ai-bilingual img')).toHaveCount(1);
    await expect(page.locator('.ai-bilingual img')).toHaveJSProperty('complete', true);
    await expect(page.locator('.ai-bilingual img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('.ai-bilingual a[href]')).toHaveCount(1);
    await expect(page.locator('.ai-bilingual [data-annotation-context],.ai-bilingual [style],.ai-bilingual .injected-class,.ai-bilingual script')).toHaveCount(0);
    assert.equal(external, 0); assert.equal(await page.evaluate(() => !!window.__aiInjected), false);
    assert.equal(await original.evaluate(root => root === window.__aiOriginal && root.textContent === window.__aiSourceText && root.dataset.annotationContext === 'a'.repeat(64)), true);
    await page.getByRole('button', { name: '返回原文与批注', exact: true }).click();
    await expect(page.getByTestId('ai-bilingual')).toHaveCount(0); await expect(original).toBeFocused();
    await page.getByTestId('annotation-toggle').click();
    await page.getByRole('button', { name: '整篇备注', exact: true }).click();
    await page.getByTestId('note-editor').fill('Synthetic original-only note');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    await expect.poll(() => ai.annotationWrites.length).toBeGreaterThan(0);
    assert.equal(ai.annotationWrites.at(-1).data.contentHash, 'a'.repeat(64));
    assert.ok(ai.annotationWrites.at(-1).data.marks.some(mark => mark.text === 'Synthetic original-only note'));
    await expect(page.getByTestId('ai-card')).toBeVisible(); // ordinary note autosave must not retire the same source
  });
  await scenario('progress, cancel failure/retry, incomplete errors, per-action language, no idle corpus polling', async ({ page, ai }) => {
    await openAi(page, 'translate'); await page.getByLabel('本次目标语言').selectOption('ja');
    await page.getByRole('button', { name: '生成双语翻译', exact: true }).click();
    await expect(page.getByTestId('ai-progress')).toContainText('1 / 131');
    assert.equal(ai.calls.find(call => call.kind === 'post').data.targetLanguage, 'ja');
    ai.cancelFails = true;
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(page.getByTestId('ai-card').getByRole('alert')).toBeVisible();
    ai.cancelFails = false;
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(page.getByTestId('ai-progress')).toContainText('任务已取消');
    await page.getByRole('button', { name: '重试任务（会发送请求）', exact: true }).click();
    await expect.poll(() => ai.providerCalls).toBe(2);
    const id = [...ai.jobs.keys()].at(-1); ai.jobs.set(id, { ...ai.jobs.get(id), status: 'failed', completedChunks: 130, error: { code: 'AI_INCOMPLETE', message: 'missing final segment' } });
    await expect(page.getByTestId('ai-progress')).toContainText('尚缺 1 段');
    await expect(page.getByTestId('ai-bilingual')).toHaveCount(0);
    await page.getByRole('button', { name: '收起 AI', exact: true }).click();
    const polls = counts(ai, 'poll'); await page.waitForTimeout(2300); assert.equal(counts(ai, 'poll'), polls);
  });
  await scenario('poll error pauses; explicit resume does not bill again; terminal skip is not translated output', async ({ page, ai }) => {
    ai.pollFails = true; await startAi(page, 'translate');
    await expect(page.getByRole('button', { name: '继续查询进度', exact: true })).toBeVisible();
    const polls = counts(ai, 'poll'); await page.waitForTimeout(2300); assert.equal(counts(ai, 'poll'), polls);
    ai.pollFails = false; const id = [...ai.jobs.keys()][0]; ai.jobs.set(id, { ...ai.jobs.get(id), status: 'skipped', completedChunks: 0, totalChunks: 0, detectedLanguage: 'zh-CN' });
    await page.getByRole('button', { name: '继续查询进度', exact: true }).click();
    await expect(page.getByTestId('ai-progress')).toContainText('已是目标语言');
    assert.equal(ai.providerCalls, 1); await expect(page.getByTestId('ai-bilingual')).toHaveCount(0);
  });
  await scenario('bounded polling window requires explicit resume', async ({ page, ai }) => {
    await startAi(page); await expect(page.getByTestId('ai-progress')).toContainText('1 / 131');
    await page.clock.fastForward(5 * 60_000 + 1);
    await expect(page.getByRole('button', { name: '继续查询进度', exact: true })).toBeVisible();
    const polls = counts(ai, 'poll'); await page.clock.fastForward(60_000); assert.equal(counts(ai, 'poll'), polls);
    assert.equal(ai.providerCalls, 1);
  }, async ({ page }) => { await page.clock.install(); });
  await scenario('retained historical annotation context retires results and refuses paid requests', async ({ page, ai }) => {
    ai.autoComplete = true; await startAi(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    await page.getByTestId('annotation-toggle').click();
    await page.getByText('正文版本 · 当前正文', { exact: true }).click();
    await page.getByRole('button', { name: /^dddddddddddd ·/ }).click();
    await expect(page.getByTestId('reader-content')).toContainText('Retained historical source');
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
    const calls = ai.calls.length;
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toContainText('返回最新正文后使用 AI'); assert.equal(ai.calls.length, calls);
    await page.getByRole('button', { name: '返回最新正文版本', exact: true }).click();
    await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
  }, async ({ fixture }) => {
    const latest = emptyAnnotationDocument(fixture.control.articles[0]);
    latest.versions = [{ contentHash: 'd'.repeat(64), revision: 1, updatedAt: '2026-01-01T00:00:00Z', markCount: 0, strokeCount: 0 }];
    const historical = { ...latest, contentHash: 'd'.repeat(64), context: { ...latest.context, contentHash: 'd'.repeat(64), contentHtml: '<p>Retained historical source</p>' } };
    fixture.route('/api/articles/one/annotations', ({ url, json }) => json(url.searchParams.get('contentHash') === historical.contentHash ? historical : latest));
  });
  await scenario('late source/mode/article completion cannot replace the selected original', async ({ page, ai, gate }) => {
    ai.autoComplete = true; ai.holdPost = gate(); const held = ai.holdPost;
    await startAi(page); await expect.poll(() => counts(ai, 'post')).toBe(1);
    await fulltext(page, '显示全文'); await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'b'.repeat(64));
    held.resolve(); await page.waitForTimeout(200); await expect(page.getByTestId('ai-card')).toHaveCount(0);
    await startAi(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    assert.equal(ai.calls.filter(call => call.kind === 'post').at(-1).data.mode, 'fulltext');
    await page.getByRole('button', { name: '下一篇 (J)', exact: true }).click(); await expect(page.getByTestId('reader-content')).toContainText('第二篇独立阅读正文');
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
  }, async ({ context }) => ignoreAiAbort(context));
  await scenario('a retired selected poll cannot publish a late completion on another article', async ({ page, ai, gate }) => {
    await startAi(page); await expect(page.getByTestId('ai-progress')).toBeVisible();
    const id = [...ai.jobs.keys()][0]; ai.complete(id); ai.holdPoll = gate(); const held = ai.holdPoll;
    await expect.poll(() => counts(ai, 'poll')).toBeGreaterThan(0);
    await page.getByRole('button', { name: '下一篇 (J)', exact: true }).click(); await expect(page.getByTestId('reader-content')).toContainText('第二篇独立阅读正文');
    held.resolve(); await page.waitForTimeout(2300);
    await expect(page.getByTestId('ai-card')).toHaveCount(0); assert.equal(counts(ai, 'poll'), 1);
  }, async ({ context }) => ignoreAiAbort(context));
  await scenario('server source drift is rejected before paid POST; mismatched completion is not rendered', async ({ page, fixture, ai }) => {
    await openAi(page);
    fixture.control.articles[0].contentHtml += '<p>new server source</p>';
    await page.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect(page.getByTestId('ai-card').getByRole('alert')).toBeVisible(); assert.equal(counts(ai, 'post'), 0);
    fixture.control.articles[0].contentHtml = fixture.control.articles[0].contentHtml.replace('<p>new server source</p>', '');
    ai.autoComplete = true; ai.responsePatch = { contentHash: 'd'.repeat(64) };
    await page.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect.poll(() => counts(ai, 'post')).toBe(1);
    await expect(page.getByTestId('ai-card').getByRole('alert')).toBeVisible(); await expect(page.getByTestId('ai-summary')).toHaveCount(0);
  });
  await scenario('late config and paid responses cannot cross auth epochs or accounts', async ({ page, fixture, ai, gate }) => {
    ai.holdConfig = gate(); const config = ai.holdConfig;
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click(); await expect.poll(() => counts(ai, 'config')).toBe(1);
    fixture.control.loggedIn = false;
    await page.evaluate(() => window.dispatchEvent(new Event('feedink:unauthorized')));
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    config.resolve();
    await signInToAiReader(page, expect, 'bob');
    await expect(page.getByTestId('ai-card')).toHaveCount(0);
    assert.equal(counts(ai, 'post'), 0);
    ai.autoComplete = true; ai.holdPost = gate(); const paid = ai.holdPost;
    await startAi(page); await expect.poll(() => counts(ai, 'post')).toBe(1);
    fixture.control.loggedIn = false;
    await page.evaluate(() => window.dispatchEvent(new Event('feedink:unauthorized')));
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    paid.resolve();
    await signInToAiReader(page, expect, 'bob');
    await expect(page.getByTestId('ai-summary')).toHaveCount(0); assert.equal(fixture.control.user.id, 'bob');
  }, async ({ context }) => ignoreAiAbort(context));
  await scenario('unconfigured action leads to UI configuration and explicit generation; offline action sends nothing', async ({ page, context, ai }) => {
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toContainText('启用模型并保存密钥'); assert.equal(counts(ai, 'post'), 0);
    await page.getByTestId('ai-card').getByRole('button', { name: 'AI 模型设置', exact: true }).click();
    const settings = page.getByRole('form', { name: 'AI 模型设置' });
    await settings.getByLabel('启用 AI 阅读', { exact: true }).check();
    await settings.getByLabel('替换 API 密钥', { exact: true }).fill('fixture-only-key-not-a-secret');
    await settings.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('AI 配置已保存');
    assert.equal(ai.providerCalls, 0); assert.equal(counts(ai, 'test'), 0);
    await closeAiSettings(page, expect);
    ai.autoComplete = true; await startAi(page);
    await expect(page.getByTestId('ai-summary')).toBeVisible(); assert.equal(ai.providerCalls, 1);
    await page.getByRole('button', { name: '收起 AI', exact: true }).click();
    await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const calls = ai.calls.length;
    await page.getByRole('button', { name: 'AI 双语翻译', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toContainText('离线时无法请求'); assert.equal(ai.calls.length, calls);
    await context.setOffline(false);
  }, async ({ fixture }) => { fixture.ai.config.enabled = false; fixture.ai.config.hasKey = false; });
  await scenario('demo never probes config or invokes AI', async ({ page, ai }) => {
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toContainText('演示账号不能调用'); assert.equal(ai.calls.length, 0);
    await openAiSettings(page, expect); await expect(page.getByRole('form', { name: 'AI 模型设置' })).toContainText('演示账号不能配置密钥'); assert.equal(ai.calls.length, 0);
  }, async ({ fixture }) => { fixture.control.user.isDemo = true; });
  await scenario('webpage mode is rejected by the displayed-source gate without AI requests', async ({ page, ai }) => {
    await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
    await page.getByRole('button', { name: '正文与排版', exact: true }).click();
    await page.getByLabel('正文模式', { exact: true }).selectOption('webpage');
    await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
    await page.getByRole('button', { name: 'AI 摘要', exact: true }).click();
    await expect(page.getByTestId('ai-card')).toContainText('AI 只处理已归档正文');
    assert.equal(ai.calls.length, 0); assert.equal(ai.providerCalls, 0);
  });
  await aiReadingRegressions(browser, expect);
  await aiResultsRegressions(browser, expect);
} finally { await browser.close(); }
