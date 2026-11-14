import { DEFAULT_SETTINGS, type ArticleDetail, type Session } from '@feedink/shared';
export function session(id = 'alice'): Session { return { user: { id, email: `${id}@example.test`, name: id, isAdmin: false, isDemo: false, createdAt: '2026-01-01T00:00:00Z' }, settings: { ...DEFAULT_SETTINGS }, csrfToken: `secret-${id}` }; }
export function article(id = 'one'): ArticleDetail {
  return { id, feedId: 'feed', subscriptionId: 'sub', feedTitle: '测试订阅', title: '墨水屏与 durable archives', url: 'https://example.test/article', author: null, publishedAt: '2026-01-02T12:00:00Z', summary: '正文存档', thumbnailUrl: '/api/assets/image-one', read: false, saved: false, tags: [], wordCount: 100, archivedAt: '2026-01-02T12:00:00Z', progress: 0, enclosures: [], contentHtml: '<p>持久存档</p>', fulltextHtml: null, contentText: '持久存档正文', fetchedAt: '2026-01-02T12:00:00Z', contentHash: 'a'.repeat(64), images: [], fulltextError: null };
}
