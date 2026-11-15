import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore } from '../src/offline';
import { beginAuthTransition, setApiSession, authEpoch, updateCredentials, mergeSessionMetadata, getApiSession } from '../src/authEpoch';
import { article, session } from './fixtures';
import { coordinateAuthentication, checkAuthOperation, resetAuthCoordination, AuthCoordinationError } from '../src/authCoordinator';
import { createLogoutIntent, readLogoutIntent, isCurrentLogout, clearLogoutIntent } from '../src/logoutIntent';

test('R2 settings and profile metadata retain authoritative reconnect credentials', () => {
  beginAuthTransition(); const stale = { ...session(), csrfToken: '' }; setApiSession(stale); const epoch = authEpoch();
  updateCredentials({ ...session(), csrfToken: 'refreshed-test-token' }, epoch);
  const changed = mergeSessionMetadata({ ...stale, user: { ...stale.user, name: 'Updated name' }, settings: { ...stale.settings, fontSize: 24 } }, epoch);
  setApiSession(changed, epoch); assert.equal(getApiSession()?.csrfToken, 'refreshed-test-token'); assert.equal(getApiSession()?.settings.fontSize, 24); assert.equal(getApiSession()?.user.name, 'Updated name');
});

test('R3 logout markers bind owner and transition; old cleanup cannot consume a newer request', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    const alice = createLogoutIntent('alice'); const bob = createLogoutIntent('bob'); assert.equal(isCurrentLogout(alice), false); clearLogoutIntent(alice); assert.deepEqual(readLogoutIntent(), bob); clearLogoutIntent(bob); assert.equal(readLogoutIntent(), null);
    localStorage.setItem('feedink-logout-pending', '1'); assert.equal(readLogoutIntent()?.owner, null);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('R3 explicit auth-mutex recovery invalidates its global generation without deleting queued reader state', async () => {
  const locks = Object.getOwnPropertyDescriptor(navigator, 'locks'); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'); const factory = new IDBFactory(); Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const store = new OfflineStore('reader-preserved', factory); await store.activate(session()); await store.saveArticle('alice', article()); await store.enqueue('alice', 'one', { saved: true });
  try {
    const operation = coordinateAuthentication(async () => { enter(); await held; await checkAuthOperation(); }, 'login'); const rejected = assert.rejects(operation, AuthCoordinationError);
    await entered; await resetAuthCoordination(); release(); await rejected; assert.equal((await store.pending('alice')).length, 1); assert.equal((await store.article('alice', 'one'))?.saved, true);
  } finally { release?.(); if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB'); if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks'); }
});

test('R6 online reconciliation retains fresh content and monotonic acknowledged state after cache writes', async () => {
  const store = new OfflineStore('reconcile', new IDBFactory()); await store.activate(session());
  await store.enqueue('alice', 'one', { saved: true }); const pending = (await store.pending('alice'))[0];
  const tag = { id: 'new-tag', name: '标签', color: '#861dd4', count: 1 };
  await store.acknowledge('alice', pending, { ...article(), saved: true, tags: [tag], stateVersion: 3 });
  await store.saveArticle('alice', { ...article(), saved: true, tags: [tag], stateVersion: 3 } as never);
  const stale = { ...article(), contentHtml: '<p>Fresh body, old state snapshot</p>', stateVersion: 2 };
  const result = await store.reconcileArticle('alice', stale);
  assert.equal(result.contentHtml, stale.contentHtml); assert.equal(result.saved, true); assert.equal(result.stateVersion, 3); assert.deepEqual(result.tags, [tag]);
  const newer = await store.reconcileArticle('alice', { ...article(), stateVersion: 4 }); assert.equal(newer.saved, false); assert.equal(newer.stateVersion, 4);
  await store.enqueue('alice', 'one', { progress: 0.7 }); const overlaid = await store.reconcileArticle('alice', { ...article(), stateVersion: 4 }); assert.equal(overlaid.progress, 0.7);
  await store.activate(session('bob')); await assert.rejects(store.reconcileArticle('alice', stale), /账号已变更/);
});
