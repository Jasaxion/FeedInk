import type { ArticleDetail, ArticleQuery, ArticleStatePatch, ArticleSummary, ReaderSettings, Session, Subscription, Folder, Tag, User } from '@feedink/shared';
import { cachedImageSource, rasterImageSource } from './imageData';
import { matchesArticle, ownedImageUrl, sortArticles, RASTER_IMAGE_MIME as rasterType, MAX_IMAGE_BYTES as maxImageBytes } from './logic';

export interface OfflineIdentity { user: User; settings: ReaderSettings }
export interface Library { subscriptions: Subscription[]; folders: Folder[]; tags: Tag[] }
export interface PendingState { articleId: string; patch: ArticleStatePatch; revision: string }
export interface CacheTicket { generation: string; enabled: boolean }
export type VersionedArticle = ArticleSummary & { stateVersion?: number };
interface StoredImage { type: string; bytes: ArrayBuffer | Uint8Array }
interface LocalState { patch: ArticleStatePatch; stateVersion?: number }
interface Lease { token: string; expires: number; mode?: 'web' | 'fallback' }
interface Row<T = unknown> { key: string; userId: string; kind: string; value: T }
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error('离线存储事务失败')); });
export class CacheInvalidatedError extends Error { constructor() { super('缓存策略已变更，已取消旧缓存任务'); } }

/** Owner, cache-policy and lease checks run in the same transaction as their writes. */
export class OfflineStore {
  private db: Promise<IDBDatabase>;
  constructor(name = 'feedink-private-v1', factory: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(name, 2);
      open.onupgradeneeded = () => {
        const rows = open.result.objectStoreNames.contains('rows') ? open.transaction!.objectStore('rows') : open.result.createObjectStore('rows', { keyPath: 'key' });
        if (!rows.indexNames.contains('ownerKind')) rows.createIndex('ownerKind', ['userId', 'kind']);
      };
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    void this.db.catch(() => {});
  }
  private async access<T>(owner: string | null, mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const tx = (await this.db).transaction('rows', mode); const finished = done(tx); void finished.catch(() => {});
    const store = tx.objectStore('rows');
    try {
      if (owner !== null && (await request(store.get('identity')) as Row<OfflineIdentity> | undefined)?.value.user.id !== owner) throw new Error('离线账号已变更，操作已取消');
      const result = await work(store); await finished; return result;
    } catch (error) { try { tx.abort(); } catch { /* already complete */ } throw error; }
  }
  private row<T>(userId: string, kind: string, id: string, value: T): Row<T> { return { key: `${userId}:${kind}:${id}`, userId, kind, value }; }
  async identity(): Promise<OfflineIdentity | undefined> { return this.access(null, 'readonly', async store => (await request(store.get('identity')) as Row<OfflineIdentity> | undefined)?.value); }
  async activate(session: Pick<Session, 'user' | 'settings'>, guard = () => {}): Promise<void> {
    return this.access(null, 'readwrite', async store => {
      guard(); const current = await request(store.get('identity')) as Row<OfflineIdentity> | undefined; guard();
      if (current?.value.user.id !== session.user.id) await request(store.clear());
      guard(); await request(store.put({ key: 'identity', userId: session.user.id, kind: 'identity', value: { user: session.user, settings: session.settings } }));
    });
  }
  async updateIdentity(session: Pick<Session, 'user' | 'settings'>, guard = () => {}): Promise<void> {
    return this.access(session.user.id, 'readwrite', async store => { guard(); await request(store.put({ key: 'identity', userId: session.user.id, kind: 'identity', value: { user: session.user, settings: session.settings } })); });
  }
  async clear(guard = () => {}, owner?: string): Promise<void> {
    return this.access(null, 'readwrite', async store => {
      guard();
      if (owner) { const current = (await request(store.get('identity')) as Row<OfflineIdentity> | undefined)?.value; guard(); if (current && current.user.id !== owner) return; }
      guard(); await request(store.clear());
    });
  }
  private async get<T>(userId: string, kind: string, id = ''): Promise<T | undefined> { return this.access(userId, 'readonly', async store => (await request(store.get(`${userId}:${kind}:${id}`)) as Row<T> | undefined)?.value); }
  private async rows<T>(userId: string, kind: string): Promise<Row<T>[]> { return this.access(userId, 'readonly', async store => await request(store.index('ownerKind').getAll([userId, kind])) as Row<T>[]); }
  library(userId: string) { return this.get<Library>(userId, 'library'); }
  async countEpoch(userId: string) { return await this.get<number>(userId, 'count-epoch') || 0; }
  private async bumpCounts(store: IDBObjectStore, userId: string) {
    const epoch = (await request(store.get(`${userId}:count-epoch:`)) as Row<number> | undefined)?.value || 0;
    await request(store.put(this.row(userId, 'count-epoch', '', epoch + 1)));
  }
  async saveLibrary(userId: string, value: Library, expectedEpoch?: number): Promise<Library> {
    return this.access(userId, 'readwrite', async store => {
      const previous = (await request(store.get(`${userId}:library:`)) as Row<Library> | undefined)?.value;
      const epoch = (await request(store.get(`${userId}:count-epoch:`)) as Row<number> | undefined)?.value || 0;
      const pending = await request(store.index('ownerKind').getAll([userId, 'queue'])) as Row<PendingState>[];
      const preserve = previous && (expectedEpoch !== undefined && expectedEpoch !== epoch || pending.some(row => row.value.patch.read !== undefined));
      const result = preserve ? { ...value, subscriptions: value.subscriptions.map(item => ({ ...item, unreadCount: previous.subscriptions.find(old => old.id === item.id)?.unreadCount ?? item.unreadCount })), folders: value.folders.map(item => ({ ...item, unreadCount: previous.folders.find(old => old.id === item.id)?.unreadCount ?? item.unreadCount })) } : value;
      await request(store.put(this.row(userId, 'library', '', result))); return result;
    });
  }
  async cacheTicket(userId: string): Promise<CacheTicket> { return await this.get<CacheTicket>(userId, 'policy') || { generation: 'initial', enabled: true }; }
  private async checkCache(store: IDBObjectStore, userId: string, ticket?: CacheTicket) {
    const policy = (await request(store.get(`${userId}:policy:`)) as Row<CacheTicket> | undefined)?.value || { generation: 'initial', enabled: true };
    if (!policy.enabled || ticket && ticket.generation !== policy.generation) throw new CacheInvalidatedError();
  }
  async article(userId: string, id: string): Promise<ArticleDetail | undefined> {
    const article = await this.get<ArticleDetail>(userId, 'article', id); if (!article) return;
    const state = await this.get<LocalState>(userId, 'state', id); const queued = await this.get<PendingState>(userId, 'queue', id);
    const library = await this.library(userId);
    return applyState(article, { ...state?.patch, ...queued?.patch }, library?.tags || article.tags);
  }
  async saveArticle(userId: string, article: ArticleDetail, ticket?: CacheTicket): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      await this.checkCache(store, userId, ticket);
      await request(store.put(this.row(userId, 'article', article.id, article)));
      const queued = await request(store.get(`${userId}:queue:${article.id}`));
      const state = (await request(store.get(`${userId}:state:${article.id}`)) as Row<LocalState> | undefined)?.value;
      const version = (article as VersionedArticle).stateVersion;
      // A body fetch started before an acknowledged mutation must not erase its newer state overlay.
      if (!queued && (!state || version !== undefined && (state.stateVersion === undefined || version >= state.stateVersion))) await request(store.delete(`${userId}:state:${article.id}`));
    });
  }
  async articles(userId: string, query: ArticleQuery) {
    const library = await this.library(userId); const rows = await this.rows<ArticleDetail>(userId, 'article');
    const states = new Map((await this.rows<LocalState>(userId, 'state')).map(row => [row.key.split(':state:')[1], row.value.patch]));
    const queued = new Map((await this.pending(userId)).map(value => [value.articleId, value.patch]));
    const articles = rows.map(row => applyState(row.value, { ...states.get(row.value.id), ...queued.get(row.value.id) }, library?.tags || row.value.tags));
    return sortArticles(articles.filter(article => matchesArticle(article, query, library?.subscriptions.filter(sub => sub.folderId === query.folderId).map(sub => sub.id))), query.sort);
  }
  async enqueue(userId: string, articleId: string, patch: ArticleStatePatch, summary?: ArticleSummary): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const key = `${userId}:queue:${articleId}`;
      const old = (await request(store.get(key)) as Row<PendingState> | undefined)?.value;
      const state = (await request(store.get(`${userId}:state:${articleId}`)) as Row<LocalState> | undefined)?.value;
      const base = summary || (await request(store.get(`${userId}:article:${articleId}`)) as Row<ArticleDetail> | undefined)?.value;
      const priorRead = old?.patch.read ?? state?.patch.read ?? base?.read;
      await request(store.put(this.row(userId, 'queue', articleId, { articleId, patch: { ...old?.patch, ...patch }, revision: crypto.randomUUID() })));
      if (patch.read !== undefined) await this.bumpCounts(store, userId);
      // Small state rows avoid rewriting a potentially megabyte-sized body under quota pressure.
      await request(store.put(this.row(userId, 'state', articleId, { ...state, patch: { ...state?.patch, ...patch } })));
      if (base && patch.read !== undefined && priorRead !== undefined && priorRead !== patch.read) {
        const library = (await request(store.get(`${userId}:library:`)) as Row<Library> | undefined)?.value;
        if (library) await request(store.put(this.row(userId, 'library', '', adjustCounts(library, base, patch.read ? -1 : 1))));
      }
    });
  }
  async pending(userId: string) { return (await this.rows<PendingState>(userId, 'queue')).map(row => row.value); }
  async currentPending(userId: string, pending: PendingState) { return (await this.get<PendingState>(userId, 'queue', pending.articleId))?.revision === pending.revision; }
  async discardPending(userId: string, articleId: string, revision?: string) {
    return this.access(userId, 'readwrite', async store => {
      const key = `${userId}:queue:${articleId}`;
      const current = (await request(store.get(key)) as Row<PendingState> | undefined)?.value;
      if (revision && current?.revision !== revision) return;
      await request(store.delete(key)); await request(store.delete(`${userId}:state:${articleId}`));
    });
  }
  async acknowledge(userId: string, pending: PendingState, result?: VersionedArticle): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const key = `${userId}:queue:${pending.articleId}`; const current = (await request(store.get(key)) as Row<PendingState> | undefined)?.value;
      if (current?.revision !== pending.revision) return;
      if (pending.patch.read !== undefined) await this.bumpCounts(store, userId);
      if (result) await request(store.put(this.row(userId, 'state', pending.articleId, { patch: { read: result.read, saved: result.saved, progress: result.progress, tagIds: result.tags.map(tag => tag.id) }, stateVersion: result.stateVersion })));
      await request(store.delete(key));
    });
  }
  private async imagePayload(userId: string, url: string): Promise<Blob | StoredImage | undefined> {
    if (!ownedImageUrl(url)) return;
    const value = await this.get<Blob | StoredImage>(userId, 'image', url);
    if (!value) return;
    // Read old Blob rows, but never write them: some WebKit storage backends cannot persist Blob/File data.
    if (value instanceof Blob) return rasterType.test(value.type) && value.size <= maxImageBytes ? value : undefined;
    if (!rasterType.test(value.type) || !(value.bytes instanceof ArrayBuffer || value.bytes instanceof Uint8Array) || value.bytes.byteLength > maxImageBytes) return;
    return value;
  }
  async image(userId: string, url: string): Promise<Blob | undefined> {
    const value = await this.imagePayload(userId, url); if (!value || value instanceof Blob) return value;
    const bytes = value.bytes instanceof Uint8Array ? value.bytes.slice().buffer : value.bytes;
    return new Blob([bytes], { type: value.type });
  }
  async imageSource(userId: string, url: string): Promise<string | undefined> {
    const value = await this.imagePayload(userId, url); if (!value) return;
    return value instanceof Blob ? cachedImageSource(value) : rasterImageSource(value.type, value.bytes);
  }
  async saveImage(userId: string, url: string, blob: Blob, ticket?: CacheTicket): Promise<void> {
    if (!ownedImageUrl(url) || !rasterType.test(blob.type) || blob.size > maxImageBytes) throw new Error('不支持的离线图片或图片超过 20 MB');
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength > maxImageBytes) throw new Error('离线图片超过 20 MB');
    return this.access(userId, 'readwrite', async store => { await this.checkCache(store, userId, ticket); await request(store.put(this.row(userId, 'image', url, { type: blob.type, bytes } satisfies StoredImage))); });
  }
  async removeArticles(userId: string, enabled?: boolean): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const old = (await request(store.get(`${userId}:policy:`)) as Row<CacheTicket> | undefined)?.value;
      await request(store.put(this.row(userId, 'policy', '', { generation: crypto.randomUUID(), enabled: enabled ?? old?.enabled ?? true })));
      for (const kind of ['article', 'image']) for (const key of await request(store.index('ownerKind').getAllKeys([userId, kind]))) await request(store.delete(key));
    });
  }
  async acquireLease(owner: string, token: string, now: number, duration: number, mode: 'web' | 'fallback' = 'fallback'): Promise<boolean> {
    return this.access(owner, 'readwrite', async store => {
      const key = `${owner}:lease:sync`; const current = (await request(store.get(key)) as Row<Lease> | undefined)?.value;
      if (current && current.token !== token && current.expires > now && !(mode === 'web' && current.mode === 'web')) return false;
      await request(store.put(this.row(owner, 'lease', 'sync', { token, expires: now + duration, mode }))); return true;
    });
  }
  async renewLease(owner: string, token: string, duration: number): Promise<boolean> {
    return this.access(owner, 'readwrite', async store => {
      const row = await request(store.get(`${owner}:lease:sync`)) as Row<Lease> | undefined;
      if (!row || row.value.token !== token || row.value.expires <= Date.now()) return false;
      row.value.expires = Date.now() + duration; await request(store.put(row)); return true;
    });
  }
  async ownsLease(owner: string, token: string): Promise<boolean> { const lease = await this.get<Lease>(owner, 'lease', 'sync'); return lease?.token === token && lease.expires > Date.now(); }
  async releaseLease(owner: string, token: string) { return this.access(owner, 'readwrite', async store => { const key = `${owner}:lease:sync`; if ((await request(store.get(key)) as Row<Lease> | undefined)?.value.token === token) await request(store.delete(key)); }); }
}
export function adjustCounts(library: Library, article: ArticleSummary, delta: number): Library {
  const sub = library.subscriptions.find(item => item.id === article.subscriptionId);
  return { ...library, subscriptions: library.subscriptions.map(item => item.id === sub?.id ? { ...item, unreadCount: Math.max(0, item.unreadCount + delta) } : item), folders: library.folders.map(item => item.id === sub?.folderId ? { ...item, unreadCount: Math.max(0, item.unreadCount + delta) } : item) };
}
export function applyState<T extends ArticleDetail>(article: T, patch: ArticleStatePatch, tags: Tag[]): T { const { tagIds, ...state } = patch; return { ...article, ...state, ...(tagIds ? { tags: tags.filter(tag => tagIds.includes(tag.id)) } : {}) }; }

/** Identity guard is also checked after the last acknowledgement, before caller side effects. */
export async function replayPending(store: OfflineStore, owner: string, verify: () => Promise<string>, send: (pending: PendingState) => Promise<VersionedArticle | void>, guard = () => {}): Promise<number> {
  guard(); if (await verify() !== owner || (await store.identity())?.user.id !== owner) throw new Error('账号不一致，未同步离线更改'); guard();
  let count = 0;
  for (const pending of await store.pending(owner)) {
    guard(); if ((await store.identity())?.user.id !== owner) throw new Error('账号已变更，已停止同步'); guard();
    if (!await store.currentPending(owner, pending)) continue;
    const result = await send(pending); guard();
    await store.acknowledge(owner, pending, result || undefined); guard(); count++;
  }
  guard(); return count;
}
