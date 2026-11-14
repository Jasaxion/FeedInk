// Real consecutive Vite builds, with a public-manifest-only edit, and browser SW activation.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium, webkit, expect } = await import(process.env.FEEDINK_PLAYWRIGHT_MODULE || '@playwright/test');
const engine = process.env.FEEDINK_BROWSER === 'webkit' ? webkit : chromium;
const executablePath = process.env.FEEDINK_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
import { auditFixture } from './audit-fixture.mjs';
const exec = promisify(execFile); const cwd = fileURLToPath(new URL('../', import.meta.url));
const manifest = new URL('../public/manifest.webmanifest', import.meta.url); const original = await readFile(manifest, 'utf8');
const build = () => exec('npm', ['run', 'build'], { cwd, timeout: 90_000, maxBuffer: 1024 * 1024 });
const fixture = await auditFixture(); let browser;
try {
  browser = await engine.launch({ executablePath, headless: true, timeout: 20_000 });
  const context = await browser.newContext(); context.setDefaultTimeout(15_000); const page = await context.newPage();
  await page.goto(`${fixture.url}/?article=one`); await expect(page.getByTestId('offline-status')).toContainText('离线可用'); await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const previousWorker = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8'); const previousAssets = await readdir(new URL('../dist/assets', import.meta.url));
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), description: 'FeedInk shell-only update regression' }));
  await build();
  assert.deepEqual(await readdir(new URL('../dist/assets', import.meta.url)), previousAssets, 'JavaScript/CSS asset names remain unchanged');
  assert.notEqual(await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8'), previousWorker, 'manifest-only build changes worker');
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await expect(page.getByRole('button', { name: '更新并重新载入', exact: true })).toBeVisible();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 20_000 }), page.getByRole('button', { name: '更新并重新载入', exact: true }).click()]);
  await expect(page.getByTestId('reader-content')).toContainText('第一篇持久存档');
  await context.setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('reader-content')).toContainText('第一篇持久存档');
  assert.equal(await page.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()).description), 'FeedInk shell-only update regression');
  await context.close(); console.log('PASS manifest-only production rebuild changes worker, prompts update, activates and restarts offline with new public shell.');
} finally {
  await browser?.close(); await fixture.close(); await writeFile(manifest, original); await build();
}
