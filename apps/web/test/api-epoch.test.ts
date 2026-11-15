import test from 'node:test';
import assert from 'node:assert/strict';
import { api, HttpError } from '../src/api';
import { assertAuthEpoch, authEpoch, beginAuthTransition, getApiSession, setApiSession, ObsoleteSessionError } from '../src/authEpoch';
import { OfflineStore, replayPending } from '../src/offline';
import { IDBFactory } from 'fake-indexeddb';
import { article, session } from './fixtures';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
for (const status of [200, 401]) test(`auth epoch rejects delayed ${status} JSON and never invalidates a newer session`, async () => {
  beginAuthTransition(); setApiSession(session()); const body = deferred<unknown>(); const headers = deferred<void>(); let unauthorized = 0;
  const originalFetch = globalThis.fetch; const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { if (event.type === 'feedink:unauthorized') unauthorized++; return true; } } });
  globalThis.fetch = async () => { headers.resolve(); return { ok: status === 200, status, json: () => body.promise } as Response; };
  try {
    const pending = api('/articles'); await headers.promise; await Promise.resolve();
    beginAuthTransition(); setApiSession(session('bob'));
    body.resolve(status === 200 ? { items: ['private'] } : { error: { message: 'old unauthorized' } });
    await assert.rejects(pending, ObsoleteSessionError); assert.equal(unauthorized, 0); assert.equal(getApiSession()?.user.id, 'bob');
  } finally { globalThis.fetch = originalFetch; if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window'); }
});
test('logout during final acknowledgement cannot authorize a later session/identity side effect', async () => {
  beginAuthTransition(); setApiSession(session()); const epoch = authEpoch(); const db = new OfflineStore('epoch', new IDBFactory()); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true });
  const ack = deferred<void>(); const reached = deferred<void>(); const original = db.acknowledge.bind(db);
  db.acknowledge = async (...args) => { await original(...args); reached.resolve(); await ack.promise; };
  const replay = replayPending(db, 'alice', async () => 'alice', async () => {}, () => assertAuthEpoch(epoch));
  await reached.promise; beginAuthTransition(); setApiSession(session('bob')); await db.activate(session('bob')); ack.resolve();
  await assert.rejects(replay, ObsoleteSessionError); assert.equal((await db.identity())?.user.id, 'bob');
  await assert.rejects(db.activate(session(), () => assertAuthEpoch(epoch)), ObsoleteSessionError); assert.equal((await db.identity())?.user.id, 'bob');
});
test('429 preserves authentication and surfaces Retry-After instead of a connectivity error', async () => {
  beginAuthTransition(); setApiSession(session()); const epoch = authEpoch(); const original = fetch;
  globalThis.fetch = async () => Response.json({ error: { code: 'RATE_LIMITED', message: '请求频繁' } }, { status: 429, headers: { 'Retry-After': '12' } });
  try { await assert.rejects(api('/articles'), error => error instanceof HttpError && error.status === 429 && /12 秒后/.test(error.message)); assert.equal(authEpoch(), epoch); assert.equal(getApiSession()?.user.id, 'alice'); }
  finally { globalThis.fetch = original; }
});

test('a delayed logout purge cannot clear a newer account cache', async () => {
  const db = new OfflineStore('purge-epoch', new IDBFactory()); beginAuthTransition(); setApiSession(session()); const epoch = authEpoch(); await db.activate(session());
  beginAuthTransition(); setApiSession(session('bob')); await db.activate(session('bob'));
  await assert.rejects(db.clear(() => assertAuthEpoch(epoch), 'alice'), ObsoleteSessionError);
  await db.clear(() => {}, 'alice'); assert.equal((await db.identity())?.user.id, 'bob');
});

test('clear distinguishes an ownership skip from confirmed deletion of private rows', async () => {
  const store = new OfflineStore('clear-outcome', new IDBFactory()); await store.activate(session()); await store.saveArticle('alice', article()); await store.enqueue('alice', 'one', { saved: true });
  assert.equal(await store.clear(() => {}, 'bob'), 'ownership-skipped');
  assert.equal((await store.identity())?.user.id, 'alice'); assert.equal((await store.article('alice', 'one'))?.saved, true); assert.equal((await store.pending('alice')).length, 1);
  assert.equal(await store.clear(() => {}, 'alice'), 'cleared'); assert.equal(await store.identity(), undefined);
});

test('same-account logout and relogin invalidate an earlier epoch too', () => {
  beginAuthTransition(); setApiSession(session()); const epoch = authEpoch(); beginAuthTransition(); setApiSession(session()); assert.throws(() => assertAuthEpoch(epoch), ObsoleteSessionError);
});
