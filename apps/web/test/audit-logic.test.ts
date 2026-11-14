import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStore, CacheInvalidatedError } from '../src/offline';
import { ownedImageUrl, shortcutAction } from '../src/logic';
import { shellVersion } from '../build/shell';
import { article, session } from './fixtures';

test('native Enter and Space survive on buttons, links, summaries and media, while reader shortcuts remain', () => {
  const interactive = { closest: (selector: string) => selector.startsWith('button') ? {} : null } as unknown as EventTarget;
  assert.equal(shortcutAction('Enter', interactive), undefined); assert.equal(shortcutAction(' ', interactive), undefined); assert.equal(shortcutAction('y', interactive), 'save');
  assert.equal(shortcutAction(' ', null), 'page'); assert.equal(shortcutAction('Enter', null), 'open');
});
test('only exact local opaque feed-icon endpoints join the raster cache allowlist', () => {
  assert.equal(ownedImageUrl('/api/feed-icons/12345678-abcd-1234-abcd-123456789abc'), '/api/feed-icons/12345678-abcd-1234-abcd-123456789abc');
  for (const value of ['/api/feed-icons/foo', '/api/feed-icons/12345678-abcd-1234-abcd-123456789abc?x=1', 'https://feed.test/api/feed-icons/12345678-abcd-1234-abcd-123456789abc', '/api/feed-icons/../secret']) assert.equal(ownedImageUrl(value), null);
});
test('worker version changes for HTML, manifest, each icon, bundle content and worker-only edits', () => {
  const encoder = new TextEncoder(); const resources: [string, Uint8Array][] = ['/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/assets/app.js'].map(path => [path, encoder.encode('initial')]);
  const before = shellVersion('worker-one', resources);
  for (let index = 0; index < resources.length; index++) assert.notEqual(shellVersion('worker-one', resources.map((row, i) => i === index ? [row[0], encoder.encode('changed')] : row)), before);
  assert.notEqual(shellVersion('worker-two', resources), before); assert.equal(shellVersion('worker-one', [...resources].reverse()), before);
});
test('clearing/disabling cache invalidates late article and image writes atomically', async () => {
  const db = new OfflineStore('cache-epoch', new IDBFactory()); await db.activate(session()); const old = await db.cacheTicket('alice'); await db.saveArticle('alice', article(), old);
  await db.removeArticles('alice', false);
  await assert.rejects(db.saveArticle('alice', article(), old), CacheInvalidatedError);
  await assert.rejects(db.saveImage('alice', '/api/assets/image-one', new Blob(['png'], { type: 'image/png' }), old), CacheInvalidatedError);
  assert.equal(await db.article('alice', 'one'), undefined);
  await db.removeArticles('alice', true); const next = await db.cacheTicket('alice'); await db.saveArticle('alice', article(), next); assert.ok(await db.article('alice', 'one'));
});
test('a stale body response cannot erase a newer acknowledged state overlay', async () => {
  const db = new OfflineStore('body-race', new IDBFactory()); await db.activate(session());
  await db.saveArticle('alice', { ...article(), stateVersion: 0 } as never); await db.enqueue('alice', 'one', { read: true });
  await db.acknowledge('alice', (await db.pending('alice'))[0], { ...article(), read: true, stateVersion: 1 });
  await db.saveArticle('alice', { ...article(), stateVersion: 0 } as never);
  assert.equal((await db.article('alice', 'one'))?.read, true);
  await db.saveArticle('alice', { ...article(), read: false, stateVersion: 2 } as never);
  assert.equal((await db.article('alice', 'one'))?.read, false);
});

test('a library response started before replay acknowledgement cannot roll back local unread counts', async () => {
  const db = new OfflineStore('library-race', new IDBFactory()); await db.activate(session());
  const library = { subscriptions: [{ id: 'sub', folderId: 'folder', unreadCount: 1 } as never], folders: [{ id: 'folder', name: 'folder', position: 0, settings: {}, unreadCount: 1 }], tags: [] };
  await db.saveLibrary('alice', library); await db.saveArticle('alice', article());
  await db.enqueue('alice', 'one', { read: true }, article()); const epoch = await db.countEpoch('alice');
  await db.acknowledge('alice', (await db.pending('alice'))[0], { ...article(), read: true, stateVersion: 1 });
  const merged = await db.saveLibrary('alice', library, epoch);
  assert.equal(merged.subscriptions[0].unreadCount, 0); assert.equal(merged.folders[0].unreadCount, 0);
});

test('small queued states update cached organization counts across offline reload, without body rewrites', async () => {
  const db = new OfflineStore('counts', new IDBFactory()); await db.activate(session());
  const sub = { id: 'sub', folderId: 'folder', unreadCount: 2 } as never;
  await db.saveLibrary('alice', { subscriptions: [sub], folders: [{ id: 'folder', name: 'folder', position: 0, settings: {}, unreadCount: 2 }], tags: [] });
  await db.saveArticle('alice', article('one')); await db.saveArticle('alice', article('outside-loaded-page'));
  const matching = await db.articles('alice', { scope: 'unread' });
  for (const item of matching) await db.enqueue('alice', item.id, { read: true }, item);
  assert.equal((await db.library('alice'))?.subscriptions[0].unreadCount, 0); assert.equal((await db.library('alice'))?.folders[0].unreadCount, 0);
  assert.equal((await db.articles('alice', { scope: 'unread' })).length, 0); assert.equal((await db.article('alice', 'outside-loaded-page'))?.read, true);
  // Repeated idempotent assignments must not decrement counters twice.
  await db.enqueue('alice', 'one', { read: true }, article()); assert.equal((await db.library('alice'))?.subscriptions[0].unreadCount, 0);
});
