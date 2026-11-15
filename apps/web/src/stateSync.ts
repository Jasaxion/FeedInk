import type { ArticleStatePatch, ArticleSummary, Session } from '@feedink/shared';
import { api, HttpError } from './api';
import { assertAuthEpoch, getApiSession, updateCredentials } from './authEpoch';
import { OfflineStore, replayPending, type PendingState, type VersionedArticle } from './offline';

export class OwnerMismatchError extends Error { constructor() { super('服务器账号与离线账号不一致'); } }
export class ObsoleteMutationError extends Error { constructor() { super('更早的阅读状态已被新操作替代'); } }
class StorageUnavailableError extends Error { constructor() { super('离线协调存储不可用'); } }
const activeIntents = new Map<string, symbol>();
export interface OwnerLockOptions { locks?: Pick<LockManager, 'request'> | null; leaseMs?: number; waitMs?: number }
/** Web Locks serialize healthy tabs. A renewable IDB lease coordinates fallback tabs; HTTP If-Match fences late writes after takeover. */
export async function withOwnerLock<T>(store: OfflineStore, owner: string, action: (check: () => Promise<void>) => Promise<T>, options: OwnerLockOptions = {}): Promise<T> {
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
  async function leased(mode: 'web' | 'fallback') {
    const token = crypto.randomUUID(); const duration = options.leaseMs ?? 15_000; const deadline = Date.now() + (options.waitMs ?? 20_000);
    const acquire = async () => { try { return await store.acquireLease(owner, token, Date.now(), duration, mode); } catch { throw new StorageUnavailableError(); } };
    while (!await acquire()) {
      if (Date.now() >= deadline) throw new Error('另一标签页正在同步，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    let lost = false;
    const check = async () => { if (lost || !await store.ownsLease(owner, token)) throw new ObsoleteMutationError(); };
    const timer = setInterval(() => { void store.renewLease(owner, token, duration).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, Math.max(20, duration / 3));
    try { await check(); return await action(check); }
    finally { clearInterval(timer); await store.releaseLease(owner, token).catch(() => {}); }
  }
  // Holding the browser lock proves a previous web-lock holder is gone; reclaim its abandoned lease immediately.
  // A fallback holder is not covered by that proof and must release or expire normally.
  return locks ? locks.request(`feedink-state:${owner}`, { mode: 'exclusive' }, () => leased('web')) : leased('fallback');
}

export async function fencedState(articleId: string, patch: ArticleStatePatch, current: () => Promise<void>, retries = 3): Promise<VersionedArticle> {
  for (let attempt = 0; ; attempt++) {
    await current();
    const latest = await api<VersionedArticle>(`/articles/${articleId}`); await current();
    if (!Number.isInteger(latest.stateVersion)) throw new Error('服务器缺少阅读状态版本，请升级服务端后同步');
    try {
      const result = await api<VersionedArticle>(`/articles/${articleId}/state`, { method: 'PATCH', headers: { 'If-Match': `"${latest.stateVersion}"` }, body: JSON.stringify(patch) });
      await current(); return result;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 412 || attempt >= retries) throw error;
      // Never refetch/retry an intent that lost its lease, revision or authentication epoch.
      await current();
    }
  }
}
export async function synchronizeState(store: OfflineStore, owner: string, epoch: number, options?: OwnerLockOptions): Promise<number> {
  return withOwnerLock(store, owner, async check => {
    const guard = () => assertAuthEpoch(epoch);
    const verify = async () => {
      guard(); const session = await api<Session>('/session'); guard();
      if (session.user.id !== owner) throw new OwnerMismatchError();
      updateCredentials(session, epoch); return owner;
    };
    return replayPending(store, owner, verify, async (pending: PendingState) => {
      const current = async () => { guard(); await check(); if (!await store.currentPending(owner, pending)) throw new ObsoleteMutationError(); guard(); };
      return fencedState(pending.articleId, pending.patch, current);
    }, guard);
  }, options);
}

export interface QueueStateOptions extends OwnerLockOptions { onConfirmed?: (state: VersionedArticle) => void }
async function capturedState(article: VersionedArticle, patch: ArticleStatePatch, current: () => Promise<void>): Promise<VersionedArticle> {
  await current();
  if (!Number.isInteger(article.stateVersion)) throw new Error('无法安全同步旧版本文章，请联网重新打开文章后重试');
  const result = await api<VersionedArticle>(`/articles/${article.id}/state`, { method: 'PATCH', headers: { 'If-Match': `"${article.stateVersion}"` }, body: JSON.stringify(patch) });
  await current(); return result;
}

/** Optional IDB failure never grants an obsolete intent permission to fetch a newer version without coordination. */
export async function queueState(store: OfflineStore, owner: string, article: ArticleSummary, patch: ArticleStatePatch, online: boolean, epoch: number, warn: (message: string) => void, options: QueueStateOptions = {}): Promise<boolean> {
  const key = `${owner}:${article.id}`; const intent = Symbol(); activeIntents.set(key, intent);
  const local = () => {
    assertAuthEpoch(epoch);
    if (getApiSession()?.user.id !== owner) throw new OwnerMismatchError();
    if (activeIntents.get(key) !== intent) throw new ObsoleteMutationError();
  };
  local();
  try { await store.enqueue(owner, article.id, patch, article); local(); return true; }
  catch (error) {
    local(); if (!online) throw error;
    let available = false; let snapshot: PendingState | undefined;
    try {
      const identity = await store.identity(); local();
      if (identity?.user.id === owner) { snapshot = (await store.pending(owner)).find(item => item.articleId === article.id); local(); available = true; }
    } catch { local(); }
    const finish = (state: VersionedArticle) => { local(); options.onConfirmed?.(state); warn('阅读状态已保存到服务器，但此设备离线存储写入失败；请清理缓存后重试离线保存'); return false; };
    if (available) {
      let started = false;
      try {
        return await withOwnerLock(store, owner, async check => {
          started = true;
          const current = async () => {
            local(); await check(); local();
            const pending = (await store.pending(owner)).find(item => item.articleId === article.id); local();
            if (pending?.revision !== snapshot?.revision) throw new ObsoleteMutationError();
            await check(); local();
          };
          const result = await fencedState(article.id, { ...snapshot?.patch, ...patch }, current, 0);
          await current(); if (snapshot) await store.discardPending(owner, article.id, snapshot.revision);
          local(); await check(); return finish(result);
        }, options);
      } catch (failure) {
        local(); if (started || !(failure instanceof StorageUnavailableError)) throw failure;
      }
    }
    // No IDB access is required here. Native locking still orders this path with normal writers.
    const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
    const onlinePatch = { ...(available ? snapshot?.patch : {}), ...patch };
    const current = async () => {
      local();
      if (available) { const pending = (await store.pending(owner)).find(item => item.articleId === article.id); local(); if (pending?.revision !== snapshot?.revision) throw new ObsoleteMutationError(); }
    };
    const complete = async (result: VersionedArticle) => { local(); if (available && snapshot) await store.discardPending(owner, article.id, snapshot.revision); local(); return finish(result); };
    if (locks) return locks.request(`feedink-state:${owner}`, { mode: 'exclusive' }, async () => {
      local();
      const result = Number.isInteger((article as VersionedArticle).stateVersion)
        ? await capturedState(article, onlinePatch, current)
        : await fencedState(article.id, onlinePatch, current, 0);
      return complete(result);
    });
    // With neither storage nor an inter-tab lock, never GET a fresh version or retry a stale intent.
    return complete(await capturedState(article, onlinePatch, current));
  }
}
