// Actual browser/IndexedDB binary compatibility. No backend durability claim.
import assert from 'node:assert/strict';
import { auditFixture } from './audit-fixture.mjs';
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const fixture = await auditFixture(); let browser;
try {
  browser = await engine.launch({ executablePath: process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true, timeout: 20_000 });
  const context = await browser.newContext(); context.setDefaultTimeout(15_000); const page = await context.newPage();
  await page.goto(`${fixture.url}/?article=one`); await expect(page.getByTestId('offline-status')).toContainText('离线可用', { timeout: 15_000 });
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('feedink-private-v1'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const read = open.result.transaction('rows').objectStore('rows').get('alice:image:/api/assets/image-one'); read.onsuccess = () => { const value = read.result.value; resolve({ isBlob: value instanceof Blob, isArrayBuffer: value.bytes instanceof ArrayBuffer, size: value.bytes?.byteLength, type: value.type }); open.result.close(); }; read.onerror = () => reject(read.error); };
  }));
  assert.equal(stored.isBlob, false); assert.equal(stored.isArrayBuffer, true); assert.equal(stored.type, 'image/png'); assert.ok(stored.size > 0 && stored.size <= 20 * 1024 * 1024);
  await context.setOffline(true); await page.locator('.article-content img[alt="归档图片"]').click();
  const preview = page.locator('.image-preview img'); await expect(preview).toBeAttached();
  console.log('portable record:', stored, 'preview:', await preview.evaluate(image => ({ src: image.src.slice(0, 40), loading: image.loading, complete: image.complete, width: image.naturalWidth, box: image.getBoundingClientRect().toJSON() })));
  await expect.poll(() => preview.evaluate(image => image.src.startsWith('data:image/') && image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  console.log(`PASS ${process.env.FEEDINK_BROWSER || 'chromium'} portable image ArrayBuffer write/read, MIME/size metadata and offline reconstructed-raster preview decoding. Engine ${browser.version()}.`);
  await context.close();
} finally { await browser?.close(); await fixture.close(); }
