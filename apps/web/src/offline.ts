import type { ArticleDetail, ArticleQuery, ArticleStatePatch, Folder, ReaderSettings, Session, Subscription, Tag, User } from '@feedink/shared';
import { matchesArticle, ownedAssetUrl, sortArticles } from './logic';

export interface OfflineIdentity { user: User; settings: ReaderSettings }
export interface Library { subscriptions: Subscription[]; folders: Folder[]; tags: Tag[] }
export interface PendingState { articleId: string; patch: ArticleStatePatch; revision: string }
interface Row<T = unknown> { key: string; userId: string; kind: string; value: T }
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error('离线存储事务失败')); });

/** All private rows share a transaction with the active-owner check, including late image fetches. */
export class OfflineStore {
  private db: Promise<IDBDatabase>;
  constructor(name = 'feedink-private-v1', factory: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(name, 2);
      open.onupgradeneeded = () => {
        const rows = open.result.objectStoreNames.contains('rows') ? open.transaction!.objectStore('rows') : open.result.createObjectStore('rows', { keyPath: 'key' });
        if (!rows.indexNames.contains('ownerKind')) rows.createIndex('ownerKind', ['userId', 'kind']);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  private async access<T>(owner: string | null, mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.db;
    const tx = db.transaction('rows', mode);
    const finished = done(tx);
    // Consume rejection even when an ownership check throws before awaiting completion.
    void finished.catch(() => {});
    const store = tx.objectStore('rows');
    try {
      if (owner !== null) {
        const current = await request(store.get('identity')) as Row<OfflineIdentity> | undefined;
        if (current?.value.user.id !== owner) throw new Error('离线账号已变更，操作已取消');
      }
      const result = await work(store);
      await finished;
      return result;
    } catch (error) { try { tx.abort(); } catch { /* transaction already completed */ } throw error; }
  }
  async identity(): Promise<OfflineIdentity | undefined> {
    return this.access(null, 'readonly', async store => (await request(store.get('identity')) as Row<OfflineIdentity> | undefined)?.value);
  }
  async activate(session: Pick<Session, 'user' | 'settings'>): Promise<void> {
    return this.access(null, 'readwrite', async store => {
      const current = await request(store.get('identity')) as Row<OfflineIdentity> | undefined;
      if (current?.value.user.id !== session.user.id) await request(store.clear());
      await request(store.put({ key: 'identity', userId: session.user.id, kind: 'identity', value: { user: session.user, settings: session.settings } }));
    });
  }
  async clear(): Promise<void> { return this.access(null, 'readwrite', async store => { await request(store.clear()); }); }
  private async get<T>(userId: string, kind: string, id = ''): Promise<T | undefined> {
    return this.access(userId, 'readonly', async store => (await request(store.get(`${userId}:${kind}:${id}`)) as Row<T> | undefined)?.value);
  }
  private async put<T>(userId: string, kind: string, id: string, value: T): Promise<void> {
    return this.access(userId, 'readwrite', async store => { await request(store.put({ key: `${userId}:${kind}:${id}`, userId, kind, value })); });
  }
  private async rows<T>(userId: string, kind: string): Promise<T[]> {
    return this.access(userId, 'readonly', async store => (await request(store.index('ownerKind').getAll([userId, kind])) as Row<T>[]).map(row => row.value));
  }
  library(userId: string) { return this.get<Library>(userId, 'library'); }
  saveLibrary(userId: string, value: Library) { return this.put(userId, 'library', '', value); }
  article(userId: string, id: string) { return this.get<ArticleDetail>(userId, 'article', id); }
  async saveArticle(userId: string, article: ArticleDetail): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const pending = (await request(store.get(`${userId}:queue:${article.id}`)) as Row<PendingState> | undefined)?.value;
      const library = (await request(store.get(`${userId}:library:`)) as Row<Library> | undefined)?.value;
      const value = applyState(article, pending?.patch || {}, library?.tags || article.tags);
      await request(store.put({ key: `${userId}:article:${article.id}`, userId, kind: 'article', value }));
    });
  }
  async articles(userId: string, query: ArticleQuery) {
    const library = await this.library(userId);
    const articles = await this.rows<ArticleDetail>(userId, 'article');
    const folderSubscriptions = library?.subscriptions.filter(sub => sub.folderId === query.folderId).map(sub => sub.id);
    return sortArticles(articles.filter(article => matchesArticle(article, query, folderSubscriptions)), query.sort);
  }
  async enqueue(userId: string, articleId: string, patch: ArticleStatePatch): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const key = `${userId}:queue:${articleId}`;
      const old = (await request(store.get(key)) as Row<PendingState> | undefined)?.value;
      const value: PendingState = { articleId, patch: { ...old?.patch, ...patch }, revision: crypto.randomUUID() };
      await request(store.put({ key, userId, kind: 'queue', value }));
      const articleRow = await request(store.get(`${userId}:article:${articleId}`)) as Row<ArticleDetail> | undefined;
      if (articleRow) {
        const library = (await request(store.get(`${userId}:library:`)) as Row<Library> | undefined)?.value;
        articleRow.value = applyState(articleRow.value, patch, library?.tags || articleRow.value.tags);
        await request(store.put(articleRow));
      }
    });
  }
  pending(userId: string) { return this.rows<PendingState>(userId, 'queue'); }
  async acknowledge(userId: string, pending: PendingState): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      const key = `${userId}:queue:${pending.articleId}`;
      const current = (await request(store.get(key)) as Row<PendingState> | undefined)?.value;
      if (current?.revision === pending.revision) await request(store.delete(key));
    });
  }
  async image(userId: string, url: string) { return this.get<Blob>(userId, 'image', url); }
  async saveImage(userId: string, url: string, blob: Blob): Promise<void> {
    if (!ownedAssetUrl(url) || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(blob.type) || blob.size > 20 * 1024 * 1024) throw new Error('不支持的离线图片或图片超过 20 MB');
    return this.put(userId, 'image', url, blob);
  }
  async removeArticles(userId: string): Promise<void> {
    return this.access(userId, 'readwrite', async store => {
      for (const kind of ['article', 'image']) {
        const keys = await request(store.index('ownerKind').getAllKeys([userId, kind]));
        for (const key of keys) await request(store.delete(key));
      }
    });
  }
}

export function applyState<T extends ArticleDetail>(article: T, patch: ArticleStatePatch, tags: Tag[]): T {
  const { tagIds, ...state } = patch;
  return { ...article, ...state, ...(tagIds ? { tags: tags.filter(tag => tagIds.includes(tag.id)) } : {}) };
}

/** Caller must obtain server identity before replay; CSRF binds each mutation to that session. */
export async function replayPending(store: OfflineStore, owner: string, verify: () => Promise<string>, send: (pending: PendingState) => Promise<void>): Promise<number> {
  if (await verify() !== owner || (await store.identity())?.user.id !== owner) throw new Error('账号不一致，未同步离线更改');
  let count = 0;
  for (const pending of await store.pending(owner)) {
    if ((await store.identity())?.user.id !== owner) throw new Error('账号已变更，已停止同步');
    await send(pending);
    await store.acknowledge(owner, pending);
    count++;
  }
  return count;
}
