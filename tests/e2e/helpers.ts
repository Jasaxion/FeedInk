import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ArticleDetail, ArticlePage, Session, Subscription } from '../../packages/shared/src/index.js';

export const upstream = process.env.FEEDINK_FIXTURE_URL || 'http://127.0.0.1:8899';
export const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
export async function register(api: APIRequestContext): Promise<Session> {
  const response = await api.post('/api/auth/register', { data: { email: `test-${randomUUID()}@example.test`, password: 'FeedInk-test-password-2026!', name: '阅读测试用户' } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}
export function csrf(session: Session) { return { 'X-CSRF-Token': session.csrfToken }; }
export async function resetUpstream(api: APIRequestContext, data: Record<string, unknown> = {}) {
  const response = await api.post(`${upstream}/__control`, { data: { offline: false, version: 1, reset: true, ...data } });
  expect(response.ok()).toBeTruthy();
}
export async function subscribe(api: APIRequestContext, session: Session, path = '/feed.xml'): Promise<Subscription> {
  const response = await api.post('/api/subscriptions', { headers: csrf(session), data: { url: `${upstream}${path}${path.includes('?') ? '&' : '?'}run=${randomUUID()}` } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}
export async function articles(api: APIRequestContext, subscriptionId?: string): Promise<ArticlePage> {
  const response = await api.get('/api/articles', { params: subscriptionId ? { subscriptionId } : {} });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
export async function waitForArticles(api: APIRequestContext, subscriptionId: string, minimum = 1): Promise<ArticlePage> {
  await expect.poll(async () => (await articles(api, subscriptionId)).items.length, { timeout: 45_000 }).toBeGreaterThanOrEqual(minimum);
  return articles(api, subscriptionId);
}
export async function detail(api: APIRequestContext, id: string, origin?: string): Promise<ArticleDetail> {
  const path = `/api/articles/${id}`;
  const response = await api.get(origin ? new URL(path, origin).href : path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
export async function browserNetworkFault(page: Page, browserName: 'chromium' | 'firefox' | 'webkit') {
  if (browserName !== 'webkit') return (offline: boolean) => page.context().setOffline(offline);
  // WPE's protocol switch and request routing do not reliably intercept worker-owned traffic.
  // Stop the actual test-origin listener; the upstream API remains an independent witness.
  const file = process.env.FEEDINK_NETWORK_CONTROL_FILE;
  if (!file || (await stat(file)).size > 4096) throw new Error('Run the WebKit project through tests/run-project.mjs for a controlled offline origin');
  const control = JSON.parse(await readFile(file, 'utf8')) as { controlUrl: string; token: string; publicUrl: string };
  const endpoint = new URL(control.controlUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/state' || !/^[a-f0-9]{64}$/.test(control.token) || new URL(control.publicUrl).origin !== new URL(baseURL).origin) throw new Error('Invalid offline-origin test control');
  const marker = 'feedink-test-network-fault';
  await page.context().addInitScript(key => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')?.get;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => localStorage.getItem(key) === '1' ? false : original?.call(navigator) ?? true });
  }, marker);
  return async (offline: boolean) => {
    const response = await fetch(control.controlUrl, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ offline }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok || (await response.json() as { offline?: boolean }).offline !== offline) throw new Error('Test origin could not transition connectivity');
    await page.evaluate(({ key, value }) => {
      localStorage.setItem(key, value ? '1' : '0');
      window.dispatchEvent(new Event(value ? 'offline' : 'online'));
    }, { key: marker, value: offline });
  };
}

export async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
}
