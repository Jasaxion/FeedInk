import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore } from '../src/offline';
import { fencedState, ObsoleteMutationError, queueState, synchronizeState } from '../src/stateSync';
import { authEpoch, beginAuthTransition, getApiSession, setApiSession } from '../src/authEpoch';
import { article, session } from './fixtures';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(value => { resolve = value; }); return { promise, resolve }; }
function setup() { beginAuthTransition(); setApiSession(session()); return new OfflineStore('sync', new IDBFactory()); }

test('a new native Web Lock holder reclaims an abandoned web lease without waiting, but cannot steal an active fallback lease', async () => {
  const db = setup(); await db.activate(session());
  assert.equal(await db.acquireLease('alice', 'old-page', Date.now(), 15_000, 'web'), true);
  assert.equal(await db.acquireLease('alice', 'reloaded-page', Date.now(), 15_000, 'web'), true);
  assert.equal(await db.ownsLease('alice', 'old-page'), false);
  await db.releaseLease('alice', 'reloaded-page');
  assert.equal(await db.acquireLease('alice', 'fallback-page', Date.now(), 15_000, 'fallback'), true);
  assert.equal(await db.acquireLease('alice', 'web-page', Date.now(), 15_000, 'web'), false);
});

test('expired fallback lease and server fencing reject a delayed old send after a newer intent succeeds', async () => {
  const db = setup(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true }); const old = (await db.pending('alice'))[0];
  await db.acquireLease('alice', 'old-tab', Date.now(), 1000);
  const started = deferred(); const release = deferred(); let writes = 0; let gets = 0; const server = { ...article(), stateVersion: 1 };
  const original = fetch;
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== 'PATCH') { gets++; return Response.json(server); }
    const index = ++writes; if (index === 1) { started.resolve(); await release.promise; }
    if (new Headers(init.headers).get('If-Match') !== `"${server.stateVersion}"`) return Response.json({ error: { code: 'STATE_CONFLICT', message: 'conflict' } }, { status: 412 });
    Object.assign(server, JSON.parse(init.body as string)); server.stateVersion++; return Response.json(server);
  };
  try {
    const oldSend = fencedState('one', old.patch, async () => { if (!await db.ownsLease('alice', 'old-tab') || !await db.currentPending('alice', old)) throw new ObsoleteMutationError(); });
    const rejected = assert.rejects(oldSend, ObsoleteMutationError); await started.promise;
    await db.acquireLease('alice', 'new-tab', Date.now() + 2000, 20_000);
    assert.equal(await db.renewLease('alice', 'old-tab', 20_000), false);
    await db.enqueue('alice', 'one', { saved: false }); const latest = (await db.pending('alice'))[0];
    const result = await fencedState('one', latest.patch, async () => { assert.equal(await db.currentPending('alice', latest), true); }); await db.acknowledge('alice', latest, result);
    release.resolve(); await rejected;
    assert.equal(server.saved, false); assert.equal(server.stateVersion, 2); assert.equal(gets, 2); assert.equal((await db.pending('alice')).length, 0);
  } finally { release.resolve(); globalThis.fetch = original; }
});
test('quota failure uses a fenced online path, removes older queued intent, and never pretends an offline save succeeded', async () => {
  const db = setup(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true });
  db.enqueue = async () => { throw new DOMException('quota exhausted', 'QuotaExceededError'); };
  const original = fetch; const server = { ...article(), stateVersion: 4 }; let writes = 0; const warnings: string[] = [];
  globalThis.fetch = async (_url, init) => { if (init?.method === 'PATCH') { assert.equal(new Headers(init.headers).get('If-Match'), '"4"'); Object.assign(server, JSON.parse(init.body as string)); server.stateVersion++; writes++; } return Response.json(server); };
  try {
    assert.equal(await queueState(db, 'alice', article(), { saved: false }, true, authEpoch(), text => warnings.push(text)), false);
    assert.equal(writes, 1); assert.equal(server.saved, false); assert.equal((await db.pending('alice')).length, 0); assert.equal(warnings.length, 1);
    await assert.rejects(queueState(db, 'alice', article(), { read: true }, false, authEpoch(), () => {}), /quota/); assert.equal(writes, 1);
  } finally { globalThis.fetch = original; }
});
test('failed quota fallback retains the previous queued intent for later retry', async () => {
  const db = setup(); await db.activate(session()); await db.enqueue('alice', 'one', { read: true });
  const originalRevision = (await db.pending('alice'))[0].revision;
  db.enqueue = async () => { throw new DOMException('quota exhausted', 'QuotaExceededError'); };
  const original = fetch;
  globalThis.fetch = async (_url, init) => { if (init?.method === 'PATCH') throw new TypeError('network disconnected'); return Response.json({ ...article(), stateVersion: 1 }); };
  try { await assert.rejects(queueState(db, 'alice', article(), { saved: true }, true, authEpoch(), () => {}), /network/); assert.equal((await db.pending('alice'))[0].revision, originalRevision); }
  finally { globalThis.fetch = original; }
});

test('sync does not restore pre-upload settings after a newer successful settings save', async () => {
  const db = setup(); await db.activate(session()); await db.enqueue('alice', 'one', { read: true });
  const original = fetch; const started = deferred(); const release = deferred(); const server = { ...article(), stateVersion: 0 };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/session')) return Response.json(session());
    if (init?.method === 'PATCH') { started.resolve(); await release.promise; server.read = true; server.stateVersion++; }
    return Response.json(server);
  };
  try {
    const syncing = synchronizeState(db, 'alice', authEpoch(), { locks: null }); await started.promise;
    const updated = { ...session(), settings: { ...session().settings, fontSize: 24 } }; setApiSession(updated); await db.updateIdentity(updated);
    release.resolve(); await syncing; assert.equal(getApiSession()?.settings.fontSize, 24); assert.equal((await db.identity())?.settings.fontSize, 24);
  } finally { release.resolve(); globalThis.fetch = original; }
});
