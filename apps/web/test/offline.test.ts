import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore, replayPending } from '../src/offline';
import { article, session } from './fixtures';

function store() { return new OfflineStore('unit', new IDBFactory()); }
test('existing version-one caches upgrade to owner/kind indexes without losing authorized articles', async () => {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const open = factory.open('upgrade', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('rows', { keyPath: 'key' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('rows', 'readwrite');
      tx.objectStore('rows').put({ key: 'identity', userId: 'alice', kind: 'identity', value: { user: session().user, settings: session().settings } });
      tx.objectStore('rows').put({ key: 'alice:article:one', userId: 'alice', kind: 'article', value: article() });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const db = new OfflineStore('upgrade', factory);
  assert.deepEqual((await db.articles('alice', {})).map(item => item.id), ['one']);
  await db.enqueue('alice', 'one', { saved: true });
  assert.equal((await db.pending('alice')).length, 1);
  await db.removeArticles('alice');
  assert.equal((await db.articles('alice', {})).length, 0);
  assert.equal((await db.pending('alice')).length, 1);
});

test('offline identity stores no CSRF/session credential', async () => {
  const db = store(); await db.activate(session());
  assert.equal((await db.identity())?.user.id, 'alice');
  assert.equal(JSON.stringify(await db.identity()).includes('secret'), false);
});
test('private article bodies and images can be retrieved only under active owner', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article());
  await db.saveImage('alice', '/api/assets/image-one', new Blob(['pixels'], { type: 'image/png' }));
  assert.equal((await db.article('alice', 'one'))?.contentHtml, '<p>持久存档</p>');
  assert.equal(await (await db.image('alice', '/api/assets/image-one'))?.text(), 'pixels');
  await assert.rejects(db.article('bob', 'one'), /账号已变更/);
  await assert.rejects(db.image('bob', '/api/assets/image-one'), /账号已变更/);
});
test('switching accounts purges old article, image, library and pending changes', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article());
  await db.saveImage('alice', '/api/assets/image-one', new Blob(['x'], { type: 'image/png' }));
  await db.enqueue('alice', 'one', { saved: true }); await db.activate(session('bob'));
  assert.equal((await db.articles('bob', {})).length, 0); assert.equal((await db.pending('bob')).length, 0);
  assert.equal(await db.image('bob', '/api/assets/image-one'), undefined);
  await db.activate(session()); assert.equal(await db.article('alice', 'one'), undefined);
  assert.equal((await db.pending('alice')).length, 0);
});
test('logout clears all private rows and rejects delayed writes', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article()); await db.enqueue('alice', 'one', { saved: true });
  await db.clear(); assert.equal(await db.identity(), undefined);
  await assert.rejects(db.saveArticle('alice', article('late')), /账号已变更/);
  await assert.rejects(db.saveImage('alice', '/api/assets/late', new Blob(['x'], { type: 'image/png' })), /账号已变更/);
  await db.activate(session()); assert.equal((await db.articles('alice', {})).length, 0); assert.equal((await db.pending('alice')).length, 0);
});
test('state queue coalesces idempotent assignments without losing other fields', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article());
  await db.enqueue('alice', 'one', { read: true, progress: 0.4 }); await db.enqueue('alice', 'one', { saved: true }); await db.enqueue('alice', 'one', { read: false });
  const pending = await db.pending('alice'); assert.equal(pending.length, 1); assert.deepEqual(pending[0].patch, { read: false, progress: 0.4, saved: true });
  const cached = await db.article('alice', 'one'); assert.equal(cached?.read, false); assert.equal(cached?.saved, true); assert.equal(cached?.progress, 0.4);
});
test('offline tags resolve from the same owner library', async () => {
  const db = store(); await db.activate(session()); const tag = { id: 'tag', name: '长文', color: '#861dd4', count: 0 };
  await db.saveLibrary('alice', { subscriptions: [], folders: [], tags: [tag] }); await db.saveArticle('alice', article());
  await db.enqueue('alice', 'one', { tagIds: ['tag'] }); assert.deepEqual((await db.article('alice', 'one'))?.tags, [tag]);
  await db.enqueue('alice', 'one', { tagIds: [] }); assert.deepEqual((await db.article('alice', 'one'))?.tags, []);
});
test('fresh server snapshots cannot erase pending offline state', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true }); await db.saveArticle('alice', article());
  assert.equal((await db.article('alice', 'one'))?.saved, true);
});
test('acknowledging an old revision does not discard edits made during sync', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true });
  const first = (await db.pending('alice'))[0]; await db.enqueue('alice', 'one', { saved: false }); await db.acknowledge('alice', first);
  const current = await db.pending('alice'); assert.equal(current.length, 1); assert.equal(current[0].patch.saved, false);
  await db.acknowledge('alice', current[0]); assert.equal((await db.pending('alice')).length, 0);
});
test('replay fails closed when server identity differs and sends nothing', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true }); let sent = 0;
  await assert.rejects(replayPending(db, 'alice', async () => 'bob', async () => { sent++; }), /账号不一致/);
  assert.equal(sent, 0); assert.equal((await db.pending('alice')).length, 1);
});
test('replay verifies identity, sends assignments, then acknowledges successful writes', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { saved: true }); const calls: string[] = [];
  const count = await replayPending(db, 'alice', async () => { calls.push('verify'); return 'alice'; }, async value => { calls.push(value.articleId); assert.deepEqual(value.patch, { saved: true }); });
  assert.equal(count, 1); assert.deepEqual(calls, ['verify', 'one']); assert.equal((await db.pending('alice')).length, 0);
});
test('failed replay retains changes for reconnect retry', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { read: true });
  await assert.rejects(replayPending(db, 'alice', async () => 'alice', async () => { throw new Error('network failed'); }), /network failed/);
  assert.equal((await db.pending('alice')).length, 1);
});
test('account switch during replay stops subsequent writes', async () => {
  const db = store(); await db.activate(session()); await db.enqueue('alice', 'one', { read: true }); await db.enqueue('alice', 'two', { read: true }); let sent = 0;
  await assert.rejects(replayPending(db, 'alice', async () => 'alice', async () => { sent++; await db.activate(session('bob')); }), /账号已变更/);
  assert.equal(sent, 1); assert.equal((await db.pending('bob')).length, 0);
});
test('cache cleanup keeps pending assignments, identity and organization', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article()); await db.enqueue('alice', 'one', { read: true });
  await db.saveLibrary('alice', { subscriptions: [], folders: [], tags: [] }); await db.removeArticles('alice');
  assert.equal((await db.articles('alice', {})).length, 0); assert.equal((await db.pending('alice')).length, 1); assert.ok(await db.library('alice')); assert.ok(await db.identity());
});
test('image cache rejects external paths, active formats and oversized blobs', async () => {
  const db = store(); await db.activate(session());
  for (const url of ['https://example.test/image.png', '/api/assets/../secret', '/api/assets/x?url=http://localhost']) await assert.rejects(db.saveImage('alice', url, new Blob(['x'], { type: 'image/png' })));
  await assert.rejects(db.saveImage('alice', '/api/assets/svg', new Blob(['<svg/>'], { type: 'image/svg+xml' })));
  await assert.rejects(db.saveImage('alice', '/api/assets/huge', new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' })));
});
test('offline list searches Chinese body, filters tags/saved/read and sorts stably', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article('a')); await db.saveArticle('alice', { ...article('b'), saved: true, read: true });
  assert.equal((await db.articles('alice', { q: '持久存档' })).length, 2);
  assert.deepEqual((await db.articles('alice', { scope: 'saved' })).map(item => item.id), ['b']);
  assert.deepEqual((await db.articles('alice', { scope: 'unread' })).map(item => item.id), ['a']);
  assert.deepEqual((await db.articles('alice', { sort: 'oldest' })).map(item => item.id), ['a', 'b']);
});
