import type { ArticleDetail, ArticleQuery, ArticleSummary, FeedPreferences, ReaderSettings } from '@feedink/shared';

export function articleQuery(search: string, settings: ReaderSettings, preference: FeedPreferences = {}): ArticleQuery {
  const params = new URLSearchParams(search);
  const scope = params.get('scope');
  return {
    scope: ['all', 'unread', 'saved', 'archive'].includes(scope || '') ? scope as ArticleQuery['scope'] : 'all',
    subscriptionId: params.get('subscription') || undefined,
    folderId: params.get('folder') || undefined,
    tagId: params.get('tag') || undefined,
    q: params.get('q') || undefined,
    sort: preference.sort || settings.sort,
    ...(!scope && (preference.unreadOnly ?? settings.unreadOnly) ? { scope: 'unread' as const } : {}),
    before: params.get('before') || undefined, after: params.get('after') || undefined, limit: 50,
  };
}

export function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  return params.toString();
}

export function matchesArticle(article: ArticleDetail, query: ArticleQuery, folderSubscriptions: string[] = []): boolean {
  if (query.scope === 'unread' && article.read || query.scope === 'saved' && !article.saved) return false;
  if (query.subscriptionId && article.subscriptionId !== query.subscriptionId) return false;
  if (query.folderId && !folderSubscriptions.includes(article.subscriptionId || '')) return false;
  if (query.tagId && !article.tags.some(tag => tag.id === query.tagId)) return false;
  if (query.before && article.publishedAt >= query.before || query.after && article.publishedAt <= query.after) return false;
  const text = `${article.title} ${article.summary} ${article.contentText}`.toLocaleLowerCase();
  return !query.q || text.includes(query.q.toLocaleLowerCase());
}

export function sortArticles(articles: ArticleSummary[], order: ArticleQuery['sort']): ArticleSummary[] {
  return [...articles].sort((a, b) => {
    const compare = a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id);
    return order === 'oldest' ? compare : -compare;
  });
}

export function shortcutAction(key: string, target: EventTarget | null, modifiers = false): string | undefined {
  const element = target as HTMLElement | null;
  if (modifiers || element?.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
  if ((key === 'Enter' || key === ' ') && element?.closest?.('button,a[href],summary,audio,video,[role="button"],[role="link"]')) return;
  return ({ j: 'next', k: 'previous', Enter: 'open', u: 'back', o: 'back', ' ': 'page', y: 'save', m: 'read', v: 'original', g: 'feed', '?': 'help' } as Record<string, string>)[key];
}

export function progressAt(scrollTop: number, scrollHeight: number, height: number): number {
  return Math.max(0, Math.min(1, scrollHeight <= height ? 1 : scrollTop / (scrollHeight - height)));
}

export function safeExternalUrl(raw: string): string | null {
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function ownedAssetUrl(raw: string): string | null {
  // No query strings, external hosts, traversal or arbitrary image proxies.
  return /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

export const RASTER_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function ownedImageUrl(raw: string): string | null {
  return ownedAssetUrl(raw) || (/^\/api\/feed-icons\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null);
}

export function newestArticleState<T extends ArticleSummary & { stateVersion?: number }>(incoming: T, known?: (ArticleSummary & { stateVersion?: number }) | null): T {
  if (!known || known.id !== incoming.id || known.stateVersion === undefined || known.stateVersion <= (incoming.stateVersion ?? -1)) return incoming;
  return { ...incoming, read: known.read, saved: known.saved, tags: known.tags, progress: known.progress, stateVersion: known.stateVersion };
}

export function formatDate(value: string, short = false): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知日期' : new Intl.DateTimeFormat('zh-CN', short ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
