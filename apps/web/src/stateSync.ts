import type { ArticleStatePatch, ArticleSummary, Session } from '@feedink/shared';
import { api, HttpError } from './api';
import { assertAuthEpoch, updateCredentials } from './authEpoch';
import { OfflineStore, replayPending, type PendingState, type VersionedArticle } from './offline';

export class OwnerMismatchError extends Error { constructor() { super('服务器账号与离线账号不一致'); } }
export class ObsoleteMutationError extends Error { constructor() { super('更早的阅读状态已被新操作替代'); } }
export interface OwnerLockOptions { locks?: Pick<LockManager, 'request'> | null; leaseMs?: number; waitMs?: number }
/** Web Locks serialize healthy tabs. A renewable IDB lease coordinates fallback tabs; HTTP If-Match fences late writes after takeover. */
export async function withOwnerLock<T>(store: OfflineStore, owner: string, action: (check: () => Promise<void>) => Promise<T>, options: OwnerLockOptions = {}): Promise<T> {
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
  async function leased(mode: 'web' | 'fallback') {
    const token = crypto.randomUUID(); const duration = options.leaseMs ?? 15_000; const deadline = Date.now() + (options.waitMs ?? 20_000);
    while (!await store.acquireLease(owner, token, Date.now(), duration, mode)) {
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

/** Optional quota failures cannot suppress a successful online mutation. Offline failures still reject. */
export async function queueState(store: OfflineStore, owner: string, article: ArticleSummary, patch: ArticleStatePatch, online: boolean, epoch: number, warn: (message: string) => void): Promise<boolean> {
  assertAuthEpoch(epoch);
  try { await store.enqueue(owner, article.id, patch, article); assertAuthEpoch(epoch); return true; }
  catch (error) {
    assertAuthEpoch(epoch); if (!online) throw error;
    const identity = await store.identity(); assertAuthEpoch(epoch);
    const run = async () => {
      // Failed account-cache activation cannot make another owner's rows a prerequisite for online writes.
      const pending = identity?.user.id === owner ? (await store.pending(owner)).find(item => item.articleId === article.id) : undefined;
      await fencedState(article.id, { ...pending?.patch, ...patch }, async () => assertAuthEpoch(epoch), 0);
      // Only a confirmed write supersedes the old queue entry. Deletes allocate no new state/body rows under quota pressure.
      // Compare revisions so a newer intent queued during this network request survives.
      if (pending) await store.discardPending(owner, article.id, pending.revision);
    };
    // Web Locks do not depend on IDB allocation and still order this exceptional online path with normal replay.
    if (globalThis.navigator?.locks) await navigator.locks.request(`feedink-state:${owner}`, { mode: 'exclusive' }, run);
    else if (identity?.user.id === owner) await withOwnerLock(store, owner, async check => { await check(); await run(); });
    else await run(); // No owned persistent queue exists; one-shot If-Match still rejects late competing writes.
    assertAuthEpoch(epoch); warn('阅读状态已保存到服务器，但此设备离线存储写入失败；请清理缓存后重试离线保存'); return false;
  }
}
