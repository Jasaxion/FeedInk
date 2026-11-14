import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@feedink/shared';
import { articleQuery, matchesArticle, ownedAssetUrl, progressAt, queryString, safeExternalUrl, shortcutAction, sortArticles } from '../src/logic';
import { article } from './fixtures';

test('reader URL maps contract names and does not expose unknown scope', () => {
  assert.deepEqual(articleQuery('?scope=saved&subscription=s1&folder=f1&tag=t1&q=中文&article=a', DEFAULT_SETTINGS), { scope: 'saved', subscriptionId: 's1', folderId: 'f1', tagId: 't1', q: '中文', sort: 'newest', before: undefined, after: undefined, limit: 50 });
  assert.equal(articleQuery('?scope=bad', DEFAULT_SETTINGS).scope, 'all');
});
test('explicit navigation scopes win over default unread preference', () => {
  assert.equal(articleQuery('', { ...DEFAULT_SETTINGS, unreadOnly: true }).scope, 'unread');
  assert.equal(articleQuery('?scope=saved', { ...DEFAULT_SETTINGS, unreadOnly: true }).scope, 'saved');
  assert.equal(articleQuery('?scope=all', DEFAULT_SETTINGS, { unreadOnly: true }).scope, 'all');
});
test('source preferences override global settings without changing query isolation', () => {
  const query = articleQuery('?subscription=mine', DEFAULT_SETTINGS, { sort: 'oldest', unreadOnly: true });
  assert.equal(query.sort, 'oldest'); assert.equal(query.scope, 'unread'); assert.equal(query.subscriptionId, 'mine');
});
test('query serialization excludes missing keys and correctly encodes Chinese', () => {
  assert.equal(queryString({ q: '中文 搜索', cursor: undefined, after: '', limit: 50 }), 'q=%E4%B8%AD%E6%96%87+%E6%90%9C%E7%B4%A2&limit=50');
});
test('offline filtering respects exact folder, subscription, tag and date constraints', () => {
  const value = { ...article(), tags: [{ id: 'tag', name: 'tag', color: '#000000', count: 1 }] };
  assert.equal(matchesArticle(value, { folderId: 'folder' }, ['sub']), true);
  assert.equal(matchesArticle(value, { folderId: 'folder' }, ['other']), false);
  assert.equal(matchesArticle(value, { subscriptionId: 'other' }), false);
  assert.equal(matchesArticle(value, { tagId: 'tag' }), true);
  assert.equal(matchesArticle(value, { tagId: 'other' }), false);
  assert.equal(matchesArticle(value, { after: '2027-01-01' }), false);
  assert.equal(matchesArticle(value, { before: '2025-01-01' }), false);
  assert.equal(matchesArticle(value, { q: 'DURABLE' }), true);
});
test('stable article order uses ID as timestamp tie breaker', () => {
  assert.deepEqual(sortArticles([article('a'), article('b')], 'newest').map(item => item.id), ['b', 'a']);
  assert.deepEqual(sortArticles([article('b'), article('a')], 'oldest').map(item => item.id), ['a', 'b']);
});
test('keyboard shortcuts ignore editing contexts and modifier combinations', () => {
  const editable = { closest: () => ({}) } as unknown as EventTarget;
  assert.equal(shortcutAction('j', editable), undefined); assert.equal(shortcutAction('j', null, true), undefined);
  assert.equal(shortcutAction('j', null), 'next'); assert.equal(shortcutAction('?', null), 'help'); assert.equal(shortcutAction('o', null), 'back'); assert.equal(shortcutAction('a', null), undefined);
});
test('reading progress is finite and bounded for short articles and overscroll', () => {
  assert.equal(progressAt(0, 400, 800), 1); assert.equal(progressAt(100, 1000, 500), 0.2); assert.equal(progressAt(-30, 1000, 500), 0); assert.equal(progressAt(2000, 1000, 500), 1);
});
test('article links reject script/data/file URLs and embedded credentials', () => {
  assert.equal(safeExternalUrl('https://example.test/article'), 'https://example.test/article');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:pass@example.test', 'not a url']) assert.equal(safeExternalUrl(url), null);
});
test('asset paths are opaque local IDs, never arbitrary image proxy URLs', () => {
  assert.equal(ownedAssetUrl('/api/assets/abcd-123_45'), '/api/assets/abcd-123_45');
  for (const url of ['https://example.test/image.png', '//example.test/x', '/api/assets/../x', '/api/assets/%2e%2e', '/api/assets/x?url=x', 'blob:private']) assert.equal(ownedAssetUrl(url), null);
});
