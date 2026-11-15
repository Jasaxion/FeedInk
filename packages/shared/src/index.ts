export type ViewMode = 'magazine' | 'list' | 'grid';
export type SortOrder = 'newest' | 'oldest';
export type ArticleMode = 'feed' | 'fulltext' | 'webpage';
export type Theme = 'system' | 'light' | 'dark' | 'sepia' | 'eink';
export type Scope = 'all' | 'unread' | 'saved' | 'archive';

export interface ReaderSettings {
  theme: Theme;
  accent: string;
  fontFamily: 'system' | 'serif' | 'sans';
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  view: ViewMode;
  mobileView: ViewMode;
  sort: SortOrder;
  unreadOnly: boolean;
  showFeedIcons: boolean;
  showThumbnails: boolean;
  hideReadFeeds: boolean;
  markReadOnScroll: boolean;
  autoFulltext: boolean;
  lazyImages: boolean;
  hideToolbar: boolean;
  tapToPage: boolean;
  wrapCode: boolean;
  customCss: string;
  sidebarWidth: number;
  listWidth: number;
  speechRate: number;
  speechVoice: string;
  language: 'zh-CN' | 'en';
  offlineEnabled: boolean;
  ebookEmail: string;
  ebookAutoSend: boolean;
  ebookIntervalDays: number;
  ebookHour: number;
  ebookMinArticles: number;
  ebookMaxArticles: number;
  ebookLanguage: string;
  ebookKeepLinks: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'system', accent: '#861dd4', fontFamily: 'system', fontSize: 18,
  lineHeight: 1.8, contentWidth: 800, view: 'magazine', mobileView: 'magazine',
  sort: 'newest', unreadOnly: false, showFeedIcons: true, showThumbnails: true,
  hideReadFeeds: false, markReadOnScroll: false, autoFulltext: false,
  lazyImages: true, hideToolbar: false, tapToPage: false, wrapCode: true,
  customCss: '', sidebarWidth: 256, listWidth: 338, speechRate: 1,
  speechVoice: '', language: 'zh-CN', offlineEnabled: true,
  ebookEmail: '', ebookAutoSend: false, ebookIntervalDays: 1, ebookHour: 5,
  ebookMinArticles: 1, ebookMaxArticles: 50, ebookLanguage: 'zh-CN', ebookKeepLinks: true,
};

export interface User {
  id: string; email: string; name: string; isAdmin: boolean; isDemo: boolean;
  createdAt: string;
}
export interface Session { user: User; settings: ReaderSettings; csrfToken: string }
export interface FeedPreferences {
  view?: ViewMode; sort?: SortOrder; unreadOnly?: boolean; articleMode?: ArticleMode;
  pinned?: boolean; muted?: boolean;
}
export interface Folder {
  id: string; name: string; position: number; unreadCount: number;
  settings: FeedPreferences;
}
export interface Tag { id: string; name: string; color: string; count: number }
export interface Subscription {
  id: string; feedId: string; title: string; url: string; siteUrl: string;
  description: string; iconUrl: string | null; folderId: string | null;
  unreadCount: number; totalCount: number; settings: FeedPreferences;
  status: 'ok' | 'pending' | 'error'; lastFetchedAt: string | null;
  lastError: string | null; position: number;
}
export interface Enclosure { url: string; type: string; length?: number }
export interface ArticleSummary {
  id: string; feedId: string | null; subscriptionId: string | null;
  feedTitle: string; title: string; url: string; author: string | null;
  publishedAt: string; summary: string; thumbnailUrl: string | null;
  read: boolean; saved: boolean; tags: Tag[]; wordCount: number;
  archivedAt: string; progress: number; enclosures: Enclosure[];
  /** Always emitted by the server; optional only for pre-upgrade offline rows. */
  stateVersion?: number;
}
export interface ArchivedImage {
  id: string; originalUrl: string; url: string;
  status: 'cached' | 'pending' | 'failed'; contentType: string | null;
}
export interface ArticleDetail extends ArticleSummary {
  contentHtml: string;
  fulltextHtml: string | null;
  contentText: string;
  fetchedAt: string;
  contentHash: string;
  images: ArchivedImage[];
  fulltextError: string | null;
}
export interface ArticlePage { items: ArticleSummary[]; nextCursor: string | null; total: number }
export interface ArticleStatePatch { read?: boolean; saved?: boolean; tagIds?: string[]; progress?: number }
export interface ArticleQuery {
  scope?: Scope; subscriptionId?: string; folderId?: string; tagId?: string;
  q?: string; sort?: SortOrder; cursor?: string; limit?: number;
  before?: string; after?: string;
}
export interface DiscoveryFeed { url: string; title: string; description: string; siteUrl: string }
export interface DiscoveryResult { feeds: DiscoveryFeed[] }
export interface Ebook { id: string; title: string; createdAt: string; articleCount: number; downloadUrl: string; sentAt: string | null; error: string | null }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
export const API_VERSION = 1;
export * from './annotations.js';
