import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore } from '../src/offline';
import { queueState, ObsoleteMutationError } from '../src/stateSync';
import { HttpError } from '../src/api';
import { beginAuthTransition, setApiSession, authEpoch } from '../src/authEpoch';
import { article, session } from './fixtures';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function identity() { beginAuthTransition(); setApiSession(session()); return authEpoch(); }

test('R4 quota queueState cannot send after its held detail read loses the fallback lease', async () => {
  const epoch = identity(); const store = new OfflineStore('quota-lease', new IDBFactory()); await store.activate(session()); await store.enqueue('alice', 'one', { saved: true });
  const enqueue = store.enqueue.bind(store); store.enqueue = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const entered = deferred(); const release = deferred(); const original = fetch; let writes = 0; let latest = { ...article(), saved: false, stateVersion: 2 };
  globalThis.fetch = async (_url, init) => { if (init?.method !== 'PATCH') { entered.resolve(); await release.promise; return Response.json(latest); } writes++; latest = { ...latest, ...JSON.parse(init.body as string), stateVersion: latest.stateVersion + 1 }; return Response.json(latest); };
  try {
    const pending = queueState(store, 'alice', { ...article(), stateVersion: 1 } as never, { saved: true }, true, epoch, () => {}, { locks: null });
    const result = pending.then(() => null, error => error);
    await entered.promise; await store.acquireLease('alice', 'new-owner', Date.now() + 60_000, 60_000); await enqueue('alice', 'one', { saved: false });
    const newer = (await store.pending('alice'))[0]; await store.acknowledge('alice', newer, latest); release.resolve();
    assert.ok(await result instanceof ObsoleteMutationError); assert.equal(writes, 0); assert.equal(latest.saved, false);
  } finally { release.resolve(); globalThis.fetch = original; }
});

test('R4 quota fallback checks the current persisted revision after every detail await', async () => {
  const epoch = identity(); const store = new OfflineStore('quota-revision', new IDBFactory()); await store.activate(session()); await store.enqueue('alice', 'one', { saved: true });
  const enqueue = store.enqueue.bind(store); store.enqueue = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const entered = deferred(); const release = deferred(); const original = fetch; let writes = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method === 'PATCH') writes++; else { entered.resolve(); await release.promise; } return Response.json({ ...article(), stateVersion: 2 }); };
  try { const operation = queueState(store, 'alice', article(), { saved: true }, true, epoch, () => {}, { locks: null }).then(() => null, error => error); await entered.promise; await enqueue('alice', 'one', { saved: false }); release.resolve(); assert.ok(await operation instanceof ObsoleteMutationError); assert.equal(writes, 0); }
  finally { release.resolve(); globalThis.fetch = original; }
});

test('R5 unavailable IDB still uses an available native owner lock', async () => {
  const epoch = identity(); const store = new OfflineStore('native-only', new IDBFactory()); store.enqueue = store.identity = async () => { throw new Error('IDB unavailable'); };
  const original = fetch; let locks = 0; let confirmed = 0;
  const manager = { request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => { locks++; return callback(); } } as unknown as LockManager;
  globalThis.fetch = async (_url, init) => { assert.equal(init?.method, 'PATCH'); assert.equal(new Headers(init.headers).get('If-Match'), '"4"'); return Response.json({ ...article(), saved: true, stateVersion: 5 }); };
  try { await queueState(store, 'alice', { ...article(), stateVersion: 4 } as never, { saved: true }, true, epoch, () => {}, { locks: manager, onConfirmed: state => { confirmed = state.stateVersion!; } }); assert.equal(locks, 1); assert.equal(confirmed, 5); }
  finally { globalThis.fetch = original; }
});

test('R4 coordination-write quota uses captured fencing and supersedes only its still-current queued snapshot', async () => {
  const epoch = identity(); const store = new OfflineStore('coord-quota', new IDBFactory()); await store.activate(session()); await store.enqueue('alice', 'one', { read: true, saved: true });
  store.enqueue = async () => { throw new DOMException('quota', 'QuotaExceededError'); }; store.acquireLease = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const original = fetch; let reads = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method !== 'PATCH') { reads++; return Response.json({ ...article(), stateVersion: 4 }); } assert.equal(new Headers(init.headers).get('If-Match'), '"3"'); assert.deepEqual(JSON.parse(init.body as string), { read: true, saved: false }); return Response.json({ ...article(), read: true, saved: false, stateVersion: 4 }); };
  try { await queueState(store, 'alice', { ...article(), stateVersion: 3 } as never, { saved: false }, true, epoch, () => {}, { locks: null }); assert.equal(reads, 0); assert.equal((await store.pending('alice')).length, 0); }
  finally { globalThis.fetch = original; }
});

test('R5 total IDB read failure still allows a captured-version conditional online mutation without a lock', async () => {
  const epoch = identity(); const store = new OfflineStore('unavailable', new IDBFactory());
  store.enqueue = store.identity = async () => { throw new Error('IDB unavailable'); };
  const original = fetch; let reads = 0; let writes = 0; const warnings: string[] = [];
  globalThis.fetch = async (_url, init) => { if (init?.method !== 'PATCH') { reads++; return Response.json({ ...article(), stateVersion: 99 }); } writes++; assert.equal(new Headers(init.headers).get('If-Match'), '"4"'); return Response.json({ ...article(), saved: true, stateVersion: 5 }); };
  try { assert.equal(await queueState(store, 'alice', { ...article(), stateVersion: 4 } as never, { saved: true }, true, epoch, value => warnings.push(value), { locks: null }), false); assert.equal(reads, 0); assert.equal(writes, 1); assert.equal(warnings.length, 1); }
  finally { globalThis.fetch = original; }
});

test('R5 no-IDB/no-lock stale captured version surfaces 412 without refetch or retry', async () => {
  const epoch = identity(); const store = new OfflineStore('conflict', new IDBFactory()); store.enqueue = store.identity = async () => { throw new Error('IDB unavailable'); };
  const original = fetch; let reads = 0; let writes = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method !== 'PATCH') { reads++; return Response.json({ ...article(), stateVersion: 8 }); } writes++; return Response.json({ error: { code: 'STATE_CONFLICT', message: 'refresh required' } }, { status: 412 }); };
  try { await assert.rejects(queueState(store, 'alice', { ...article(), stateVersion: 4 } as never, { saved: true }, true, epoch, () => {}, { locks: null }), error => error instanceof HttpError && error.status === 412); assert.equal(reads, 0); assert.equal(writes, 1); }
  finally { globalThis.fetch = original; }
});
