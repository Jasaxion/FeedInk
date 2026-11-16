// Hosted-only source/lifecycle contracts. Synthetic HTTP is not backend/provider acceptance.
import assert from 'node:assert/strict';
import { aiFixture } from './ai-fixture.mjs';
import { deferred } from './audit-fixture.mjs';

export async function aiReadingRegressions(browser, expect) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('AI reading fixtures require approved GitHub-hosted execution.');
  const calls = (ai, kind) => ai.calls.filter(call => call.kind === kind);
  const card = page => page.getByTestId('ai-card');
  const changePath = (page, path) => page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  async function open(page, operation = 'summary') {
    await page.getByRole('button', { name: operation === 'summary' ? 'AI 摘要' : 'AI 双语翻译', exact: true }).click();
    await expect(card(page).getByLabel('本次目标语言')).toBeVisible();
  }
  async function generate(page, operation = 'summary') { await card(page).getByRole('button', { name: operation === 'summary' ? '生成摘要' : '生成双语翻译', exact: true }).click(); }
  async function saveInSecondTab(context, fixture) {
    const second = await context.newPage(); await second.goto(`${fixture.url}/settings/ai`);
    const form = second.getByRole('form', { name: 'AI 模型设置' });
    await form.getByLabel('模型名称').fill('second-tab-model');
    await form.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('AI 配置已保存');
    return second;
  }
  async function scenario(name, action, setup = () => {}) {
    const fixture = await aiFixture(), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [], gates = [];
    context.setDefaultTimeout(15000); context.on('page', tab => tab.on('pageerror', error => errors.push(error.message))); page.on('pageerror', error => errors.push(error.message));
    const gate = () => { const value = deferred(); gates.push(value); return value; };
    try {
      await setup({ page, context, fixture });
      await page.goto(`${fixture.url}/?article=one`);
      await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
      await action({ page, context, fixture, ai: fixture.ai, gate });
      assert.deepEqual(errors, []); assert.deepEqual(fixture.routeErrors, []); assert.equal(fixture.control.rejectedCsrf, 0);
      console.log(`PASS ai-reading-regressions: ${name}`);
    } finally { gates.forEach(value => value.resolve()); await context.close(); await fixture.close(); }
  }

  for (const outcome of ['failed', 'cancelled', 'lost-response']) await scenario(`AI_INTERRUPTED after ${outcome} exposes one explicit force retry without retained job`, async ({ page, ai }) => {
    if (outcome === 'lost-response') ai.losePostReply = true;
    await open(page); await generate(page);
    await expect.poll(() => ai.jobs.size).toBe(1);
    const id = [...ai.jobs.keys()][0];
    if (outcome === 'lost-response') await expect(card(page).getByRole('alert')).toBeVisible();
    else {
      await expect(page.getByTestId('ai-progress')).toBeVisible();
      if (outcome === 'cancelled') {
        await card(page).getByRole('button', { name: '取消任务', exact: true }).click();
        await expect(page.getByTestId('ai-progress')).toContainText('任务已取消');
      }
    }
    if (outcome !== 'cancelled') ai.jobs.set(id, { ...ai.jobs.get(id), status: 'failed', result: undefined });
    if (outcome === 'failed') await expect(page.getByTestId('ai-progress')).toContainText('任务失败');
    await card(page).getByRole('button', { name: '收起 AI', exact: true }).click();
    await open(page); assert.equal(calls(ai, 'post').length, 1);
    await generate(page);
    await expect(card(page).getByRole('alert')).toContainText('上次任务已失败、取消或结果未知');
    await expect(page.getByTestId('ai-progress')).toHaveCount(0);
    const retry = card(page).getByRole('button', { name: '重试任务（可能产生费用）', exact: true });
    await expect(retry).toBeEnabled(); await page.waitForTimeout(2200);
    assert.equal(ai.providerCalls, 1); assert.equal(calls(ai, 'post').length, 2);
    await retry.click(); await expect(page.getByTestId('ai-progress')).toContainText('1 / 131');
    assert.equal(ai.providerCalls, 2); assert.equal(calls(ai, 'post').length, 3); assert.equal(calls(ai, 'post').at(-1).data.force, true);
  });

  await scenario('held failed local write rejects navigation without replacing known source or AI session', async ({ page, ai }) => {
    ai.autoComplete = true; await open(page); await generate(page); await expect(page.getByTestId('ai-summary')).toBeVisible();
    await card(page).evaluate(node => { window.__retainedAiCard = node; });
    await page.getByTestId('annotation-toggle').click();
    await page.getByRole('button', { name: '整篇备注', exact: true }).click();
    await expect.poll(() => ai.annotationWrites.length).toBeGreaterThan(0);
    await expect(page.getByTestId('annotation-status')).toContainText('服务器已确认修订 1');
    const noteWrites = ai.annotationWrites.length;
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        const request = put.call(this, value, ...args);
        if (value.kind === 'annotations' && value.value.pending) {
          IDBObjectStore.prototype.put = put;
          Object.defineProperty(request, 'onerror', { configurable: true, set(callback) {
            request.addEventListener('error', event => { window.__rejectHeldNoteWrite = () => callback.call(request, event); });
          } });
          queueMicrotask(() => this.transaction.abort());
        }
        return request;
      };
    });
    await page.getByTestId('note-editor').fill('Retained draft during held local failure');
    await expect.poll(() => page.evaluate(() => typeof window.__rejectHeldNoteWrite)).toBe('function');
    const reads = calls(ai, 'config').length;
    await changePath(page, '/settings/ai?article=one'); await page.waitForTimeout(150);
    assert.equal(await card(page).evaluate(node => node === window.__retainedAiCard), true);
    await expect(page.getByRole('form', { name: 'AI 模型设置' })).toHaveCount(0);
    await page.evaluate(() => window.__rejectHeldNoteWrite());
    await expect(page).toHaveURL(/\/\?article=one$/);
    await expect(page.getByRole('alert').filter({ hasText: '未切换页面' })).toBeVisible();
    await expect(page.getByTestId('annotations-panel')).toContainText('Retained draft during held local failure');
    assert.equal(await card(page).evaluate(node => node === window.__retainedAiCard), true);
    assert.equal(calls(ai, 'config').length, reads); assert.equal(ai.providerCalls, 1); assert.equal(ai.annotationWrites.length, noteWrites);
  });

  await scenario('second-tab change between configuration GET and paid POST rejects stale admission even without notification', async ({ page, context, fixture, ai, gate }) => {
    await open(page); ai.holdContext = gate(); const held = ai.holdContext;
    await generate(page); await expect.poll(() => ai.holdContext).toBe(null);
    await saveInSecondTab(context, fixture); assert.equal(ai.config.revision, 2);
    held.resolve(); await expect(card(page).getByRole('alert')).toContainText('AI 配置已变更');
    assert.equal(ai.rejectedAdmissions, 1); assert.equal(ai.providerCalls, 0);
    assert.equal(calls(ai, 'post')[0].data.configRevision, 1);
    await expect(card(page).getByRole('button', { name: '重新读取配置', exact: true })).toBeVisible();
    assert.equal(calls(ai, 'post').length, 1);
  }, async ({ page }) => {
    await page.addInitScript(() => {
      const Channel = window.BroadcastChannel;
      // Suppress only this tab's config notifications, not auth coordination.
      window.BroadcastChannel = class extends Channel {
        constructor(name) { super(name); if (name === 'feedink-ai-config') this.addEventListener('message', event => event.stopImmediatePropagation()); }
      };
    });
  });

  await scenario('owner/revision-scoped second-tab invalidation retires a held terminal response without navigation', async ({ page, context, fixture, ai, gate }) => {
    ai.autoComplete = true; ai.holdPost = gate(); const held = ai.holdPost;
    await open(page); await generate(page); await expect.poll(() => ai.providerCalls).toBe(1);
    await card(page).evaluate(node => { window.__heldAiCard = node; });
    const sender = await context.newPage(); await sender.goto(`${fixture.url}/`);
    await sender.evaluate(() => {
      const channel = new BroadcastChannel('feedink-ai-config');
      channel.postMessage({ owner: 'bob', revision: 100 }); channel.postMessage({ owner: 'alice', revision: 1 }); channel.close();
    });
    await page.waitForTimeout(100); assert.equal(await card(page).evaluate(node => node === window.__heldAiCard), true);
    await saveInSecondTab(context, fixture);
    await expect(card(page)).toHaveCount(0); held.resolve(); await page.waitForTimeout(150);
    await expect(card(page)).toHaveCount(0); await expect(page.getByTestId('ai-summary')).toHaveCount(0);
    assert.equal(ai.providerCalls, 1); assert.equal(calls(ai, 'post').length, 1);
    const messages = await context.pages().at(-1).evaluate(() => window.__configMessages);
    assert.deepEqual(messages, [{ owner: 'alice', revision: 2 }]);
  }, async ({ context }) => {
    await context.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = (input, init) => String(input).includes('/ai') ? originalFetch(input, { ...init, signal: undefined }) : originalFetch(input, init);
      window.__configMessages = [];
      const post = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function(data) { if (this.name === 'feedink-ai-config') window.__configMessages.push(data); return post.call(this, data); };
    });
  });

  await scenario('focus fallback rechecks only explicitly open AI and returned job revision is mandatory', async ({ page, ai }) => {
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(calls(ai, 'config').length, 0);
    ai.autoComplete = true; ai.responsePatch = { configRevision: 99 };
    await open(page); await generate(page);
    await expect(card(page).getByRole('alert')).toContainText('返回的结果与所选正文不匹配');
    await expect(page.getByTestId('ai-summary')).toHaveCount(0);
    assert.equal(calls(ai, 'post')[0].data.configRevision, 1);
    ai.config = { ...ai.config, revision: 2 };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(card(page)).toHaveCount(0);
    const reads = calls(ai, 'config').length;
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(100); assert.equal(calls(ai, 'config').length, reads); assert.equal(ai.providerCalls, 1);
  });

  await scenario('focused-mode Escape closes AI first and returns focus without exiting focused reading', async ({ page }) => {
    await page.getByRole('button', { name: '更多文章操作', exact: true }).click();
    await page.getByRole('button', { name: '专注阅读', exact: true }).click();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-focus', 'true');
    await open(page); await expect(card(page)).toBeFocused(); await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'AI 摘要', exact: true })).toBeFocused();
    await expect(page.getByTestId('reader')).toHaveAttribute('data-focus', 'true');
  });

  await scenario('native API disclosure activation preserves only scoped span markers and safe language', async ({ page, ai }) => {
    ai.autoComplete = true; await open(page, 'translate'); await generate(page, 'translate');
    const disclosure = page.locator('.ai-bilingual details'), summary = disclosure.locator(':scope > summary');
    await expect(summary).toHaveCount(1);
    await expect(summary.locator('span.feedink-ai-source')).toHaveAttribute('lang', 'en');
    await expect(summary.locator('span.feedink-ai-target')).toHaveAttribute('lang', 'zh-CN');
    await expect(disclosure).not.toHaveAttribute('open');
    await summary.click(); await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.getByText('Disclosure original and translated body 详情正文', { exact: true })).toBeVisible();
    await summary.focus(); await page.keyboard.press('Enter'); await expect(disclosure).not.toHaveAttribute('open');
    await expect(page.locator('.ai-bilingual [style],.ai-bilingual .injected-class')).toHaveCount(0);
  });

  await scenario('disclosure sanitizer rejects extra controls, unscoped markers, unsafe languages and generated URLs', async ({ page, ai, fixture }) => {
    ai.autoComplete = true;
    ai.responsePatch = { result: { sourceTitle: fixture.control.articles[0].title, sourceUrl: fixture.control.articles[0].url, bilingualHtml: '<details><summary><span class="feedink-ai-source arbitrary" lang="en" style="display:none" href="https://injected.invalid">Source</span><span class="feedink-ai-target arbitrary" lang="zh-CN" onclick="alert(1)">译文</span><span class="feedink-ai-target" lang="javascript:invalid">Bad language</span></summary><summary>Not another activation target</summary><p>Body</p></details><span class="feedink-ai-target" lang="zh-CN">Not a summary pair</span><div><summary>Misnested summary</summary></div>' } };
    await open(page, 'translate'); await generate(page, 'translate');
    const result = page.getByTestId('ai-bilingual');
    await expect(result.locator('summary')).toHaveCount(1);
    await expect(result.locator('span.feedink-ai-source[lang="en"]')).toHaveCount(1);
    await expect(result.locator('span.feedink-ai-target[lang="zh-CN"]')).toHaveCount(1);
    await expect(result.locator('span').filter({ hasText: 'Bad language' })).not.toHaveAttribute('lang');
    await expect(result.locator('span').filter({ hasText: 'Not a summary pair' })).not.toHaveAttribute('class');
    await expect(result.locator('[style],[href],[src],[onclick],.arbitrary')).toHaveCount(0);
  });

  for (const width of [1280, 390]) for (const firstTag of ['h2', 'p']) await scenario(`${firstTag}-first original progress and visible Space paging at ${width}px`, async ({ page, ai, fixture }) => {
    const scroll = page.locator('.reader-scroll'), source = page.getByTestId('reader-content');
    const offset = 80;
    const position = index => source.evaluate((root, { index, offset }) => {
      const scroll = root.closest('.reader-scroll');
      const witness = [...root.querySelectorAll('p')].find(node => node.textContent.startsWith(`Margin witness ${index}:`));
      scroll.scrollTop += witness.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
      return { top: scroll.scrollTop, range: scroll.scrollHeight - scroll.clientHeight, y: witness.getBoundingClientRect().top - scroll.getBoundingClientRect().top };
    }, { index, offset });
    const typography = await source.evaluate(root => {
      window.__marginOriginal = root; window.__marginHtml = root.innerHTML;
      const original = root.firstElementChild, meta = document.querySelector('.article-meta');
      const text = getComputedStyle(document.querySelector('.article-document')), leading = getComputedStyle(original);
      return { fontSize: text.fontSize, color: text.color, fontFamily: text.fontFamily, lineHeight: text.lineHeight,
        gap: original.getBoundingClientRect().top - meta.getBoundingClientRect().bottom, leadingMargin: parseFloat(leading.marginTop), metadataFont: getComputedStyle(meta).fontSize };
    });
    // Legacy no-AI spacing: metadata's 24px/18px margin collapses with the first
    // source block's margin, rather than being summed or globally zeroed.
    assert.ok(Math.abs(typography.gap - Math.max(width > 700 ? 24 : 18, typography.leadingMargin)) < 1);
    assert.equal(typography.metadataFont, '12px');

    await scroll.focus();
    const beforeSpace = await scroll.evaluate(node => ({ top: node.scrollTop, step: node.clientHeight * 0.85 }));
    await page.keyboard.press('Space');
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeSpace.top + beforeSpace.step - 2);
    await expect(page).toHaveURL(/article=one$/);

    // Both references are measured BEFORE any AI exists. No transient-host height
    // or implementation helper is used to derive either expected progress value.
    const first = await position(10), firstProgress = first.top / first.range;
    assert.ok(Math.abs(first.y - offset) < 1);
    await expect.poll(() => Math.abs(fixture.control.articles[0].progress - firstProgress) * first.range).toBeLessThan(2);
    const second = await position(30), secondProgress = second.top / second.range;
    assert.ok(Math.abs(second.y - offset) < 1);
    await expect.poll(() => Math.abs(fixture.control.articles[0].progress - secondProgress) * second.range).toBeLessThan(2);

    ai.autoComplete = true; await open(page, 'translate'); await generate(page, 'translate');
    await expect(page.getByTestId('ai-bilingual')).toBeVisible();
    assert.equal(await source.evaluate(root => root === window.__marginOriginal && root.innerHTML === window.__marginHtml), true);
    const aiTypography = await card(page).evaluate(node => {
      const style = getComputedStyle(node);
      return { fontSize: style.fontSize, color: style.color, fontFamily: style.fontFamily, lineHeight: style.lineHeight };
    });
    assert.deepEqual(aiTypography, { fontSize: typography.fontSize, color: typography.color, fontFamily: typography.fontFamily, lineHeight: typography.lineHeight });
    // Space must advance through visible bilingual content, not jump to original
    // text or treat the original-progress coordinate as the paging coordinate.
    const bilingualStart = page.locator('.ai-bilingual .feedink-ai-pair').first();
    await bilingualStart.evaluate((node, offset) => {
      const scroll = node.closest('.reader-scroll');
      scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
    }, offset);
    await scroll.focus();
    const beforeAiSpace = await scroll.evaluate(node => ({ top: node.scrollTop, step: node.clientHeight * 0.85 }));
    await page.keyboard.press('Space');
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeAiSpace.top + beforeAiSpace.step - 2);
    await expect(page).toHaveURL(/article=one$/);
    assert.ok(await source.evaluate(root => root.getBoundingClientRect().top > root.closest('.reader-scroll').getBoundingClientRect().bottom));

    const firstWithAi = await position(10);
    assert.ok(Math.abs(firstWithAi.y - first.y) < 1);
    await expect.poll(() => Math.abs(fixture.control.articles[0].progress - firstProgress) * first.range).toBeLessThan(2);
    // Position and click in ONE browser task, before the 700ms Reader debounce.
    // The first/second references differ, so a stale persisted first value fails.
    const secondWithAiY = await page.getByRole('button', { name: '下一篇 (J)', exact: true }).evaluate((button, offset) => {
      const scroll = document.querySelector('.reader-scroll');
      const witness = [...document.querySelectorAll('[data-reader-root] p')].find(node => node.textContent.startsWith('Margin witness 30:'));
      scroll.scrollTop += witness.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
      const y = witness.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      button.click(); return y;
    }, offset);
    assert.ok(Math.abs(secondWithAiY - second.y) < 1);
    await expect(page.getByTestId('reader-content')).toContainText('第二篇独立阅读正文');
    await expect.poll(() => Math.abs(fixture.control.articles[0].progress - secondProgress) * second.range).toBeLessThan(2);
    await page.getByRole('button', { name: '上一篇 (K)', exact: true }).click();
    await expect(source).toContainText('Margin witness 30:'); await expect(card(page)).toHaveCount(0);
    await expect.poll(() => source.evaluate((root, offset) => {
      const witness = [...root.querySelectorAll('p')].find(node => node.textContent.startsWith('Margin witness 30:'));
      return Math.abs(witness.getBoundingClientRect().top - root.closest('.reader-scroll').getBoundingClientRect().top - offset);
    }, offset)).toBeLessThan(2);
  }, async ({ page, fixture }) => {
    await page.setViewportSize({ width, height: 900 });
    // No images/fonts with deferred geometry: the witness isolates boundary margin
    // collapse, at both metadata breakpoints, without mutating archived source UI.
    fixture.control.articles[0].contentHtml = `<${firstTag}>Leading original block</${firstTag}>` + Array.from({ length: 60 }, (_, index) => `<p>Margin witness ${index}: ${'Original source prose '.repeat(18)}</p>`).join('');
  });

  await scenario('Space traverses a long bilingual result even when the original already fits the viewport', async ({ page, ai }) => {
    const scroll = page.locator('.reader-scroll');
    assert.equal(await scroll.evaluate(node => node.scrollHeight <= node.clientHeight), true);
    ai.autoComplete = true; await open(page, 'translate'); await generate(page, 'translate');
    await expect(page.getByTestId('ai-bilingual')).toBeVisible();
    await scroll.evaluate(node => { node.scrollTop = 0; }); await scroll.focus();
    const step = await scroll.evaluate(node => node.clientHeight * 0.85);
    await page.keyboard.press('Space');
    await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(step - 2);
    await expect(page).toHaveURL(/article=one$/);
    assert.ok(await page.getByTestId('reader-content').evaluate(root => root.getBoundingClientRect().top > root.closest('.reader-scroll').getBoundingClientRect().bottom));
  }, async ({ fixture }) => { fixture.control.articles[0].contentHtml = '<p>Short original source.</p>'; });
}
