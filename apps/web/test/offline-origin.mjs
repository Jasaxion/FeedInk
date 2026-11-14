// Actual offline-origin restart: stop only this owned HTTP fixture, without WebKit's protocol-level offline Blob-I/O bug.
import { auditFixture } from './audit-fixture.mjs';
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const fixture = await auditFixture(); let browser; let stopped = false;
try {
  browser = await engine.launch({ executablePath: process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true, timeout: 20_000 });
  const context = await browser.newContext(); context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(20_000); const page = await context.newPage();
  await page.goto(`${fixture.url}/?article=one`); await expect(page.getByTestId('offline-status')).toContainText('离线可用', { timeout: 15_000 }); await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await fixture.close(); stopped = true;
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('reader-content')).toContainText('第一篇持久存档'); await expect(page.getByTestId('offline-status')).toContainText('离线');
  const image = page.locator('.article-content img[alt="归档图片"]'); await expect.poll(() => image.evaluate(image => image.src.startsWith('data:image/') && image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  await page.locator('.reader-scroll').focus(); await page.keyboard.press('y'); await expect(page.getByTestId('offline-status')).toContainText('待同步');
  console.log(`PASS ${process.env.FEEDINK_BROWSER || 'chromium'} service-worker shell restart after owned origin shutdown, cached body/image decode and queued offline saved state. Engine ${browser.version()}.`); await context.close();
} finally { await browser?.close(); if (!stopped) await fixture.close(); }
