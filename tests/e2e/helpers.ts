import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
export async function detail(api: APIRequestContext, id: string): Promise<ArticleDetail> {
  const response = await api.get(`/api/articles/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
export async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
}
