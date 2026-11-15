import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import type { AnnotationDocument, TextQuoteAnchor } from '@feedink/shared';
import { annotationKey, backupOf, validateAnnotations, type StoredAnnotations } from '../src/annotationData';
import { OfflineStore, LocalAnnotationConflict, PendingNotesOwnerError } from '../src/offline';
import { matchQuote } from '../src/textAnchors';
import { article, session } from './fixtures';

function document(): AnnotationDocument {
  return { schemaVersion: 1, id: null, revision: 0, updatedAt: null, versions: [], contentHash: 'a'.repeat(64), context: { articleId: 'one', mode: 'feed', contentHash: 'a'.repeat(64), sourceUrl: 'https://example.test/article', title: '测试文章', contentHtml: '<p>完整引用</p>' }, ink: null, marks: [{ id: 'mark-one', kind: 'note', color: 'lilac', text: '<script>不是 HTML</script>', anchor: null, createdAt: 1, updatedAt: 1 }] };
}
const draft = (localVersion = 'first'): StoredAnnotations => ({ document: document(), localVersion, pending: true });
const store = () => new OfflineStore('annotations-unit', new IDBFactory());

test('annotationData JSON backup preserves every plain-text note and raw stroke, excludes user/session/projection', () => {
  const source = document(); source.ink = { version: 1, url: source.context.sourceUrl, title: source.context.title, updatedAt: 1, layoutWidth: 800, strokes: [{ id: 'raw-one', brush: 'pressure-v1', tool: 'pen', color: '#493356', opacity: 1, width: 3, points: [{ x: 2, y: 4, p: 0.2 }, { x: 20, y: 8, p: 0.9 }], anchor: { kind: 'future-unknown', stable: 'retain-me' } }] };
  const backup = backupOf(source);
  assert.deepEqual(backup.ink, source.ink); assert.equal(backup.marks[0].text, '<script>不是 HTML</script>');
  assert.deepEqual(Object.keys(backup).sort(), ['format', 'ink', 'marks', 'source', 'version']);
  source.ink.strokes[0].anchor = { kind: 'render-v1', matrix: [1, 0, 0, 1, 0, 0], clips: [] };
  assert.throws(() => backupOf(source), /投影/);
});
test('annotationData rejects duplicate IDs, invalid Unicode, unanchored highlight and nonfinite ink atomically', () => {
  const source = document(); source.marks.push({ ...source.marks[0] }); assert.throws(() => validateAnnotations(source)); source.marks.pop();
  source.marks[0].text = '\ud800'; assert.throws(() => validateAnnotations(source)); source.marks[0].text = 'valid';
  source.marks[0].kind = 'highlight'; assert.throws(() => validateAnnotations(source));
});
test('textAnchors uses complete unique quote context, not a coincidental saved offset', () => {
  const anchor: TextQuoteAnchor = { kind: 'text-quote-v1', exact: 'quote', prefix: '', suffix: '', start: 0, end: 5 };
  assert.equal(matchQuote('quote quote', anchor).status, 'ambiguous');
  assert.deepEqual(matchQuote('new quote end', { ...anchor, prefix: 'new ', suffix: ' end' }), { status: 'located', start: 4, end: 9 });
  assert.equal(matchQuote('changed content', anchor).status, 'missing');
  assert.equal(matchQuote('quote', anchor, { left: 0 }).status, 'limit');
});
test('OfflineStore notes survive article/image cache clearing and reject foreign-owner reads', async () => {
  const db = store(); await db.activate(session()); await db.saveArticle('alice', article()); const row = draft(); await db.putAnnotations('alice', row, null);
  await db.removeArticles('alice', false); assert.equal(await db.article('alice', 'one'), undefined);
  assert.equal((await db.pendingAnnotations('alice'))[0].document.marks.length, 1);
  await assert.rejects(db.annotations('bob', row.document.context), /账号已变更/);
  await assert.rejects(db.activate(session('bob')), PendingNotesOwnerError);
});
test('OfflineStore forced-401 quarantine removes active identity/body, restores only after matching verified activation', async () => {
  const db = store(); await db.activate(session()); const row = draft(); await db.putAnnotations('alice', row, null); await db.saveArticle('alice', article());
  await db.clear(() => {}, 'alice', true);
  assert.equal(await db.identity(), undefined);
  await assert.rejects(db.annotationDocuments('alice'), /账号已变更/);
  await assert.rejects(db.guardAnnotationLogin('bob@example.test', false), PendingNotesOwnerError);
  await assert.rejects(db.activate(session('bob')), PendingNotesOwnerError);
  await db.guardAnnotationLogin(session().user.email, false); await db.activate(session());
  assert.equal(await db.article('alice', 'one'), undefined); assert.deepEqual(await db.annotations('alice', row.document.context), row);
});
test('OfflineStore local CAS prevents two-tab overwrite and ACK preserves a newer draft', async () => {
  const db = store(); await db.activate(session()); const first = draft(); await db.putAnnotations('alice', first, null);
  const second = draft('second'); second.document.marks[0].text = 'later edit'; await db.putAnnotations('alice', second, 'first');
  await assert.rejects(db.putAnnotations('alice', draft('stale'), 'first'), LocalAnnotationConflict);
  await db.acknowledgeAnnotations('alice', first, { ...first.document, id: 'server-one', revision: 1 });
  const saved = (await db.annotations('alice', first.document.context))!;
  assert.equal(saved.pending, true); assert.equal(saved.document.revision, 1); assert.equal(saved.document.marks[0].text, 'later edit');
  assert.equal(saved.localVersion, 'second');
});
test('OfflineStore 412 retains both copies and old ACK cannot clear a conflict', async () => {
  const db = store(); await db.activate(session()); const local = draft(); await db.putAnnotations('alice', local, null);
  const remote = { ...document(), revision: 4, marks: [] }; await db.annotationConflict('alice', local.document.context, remote);
  await db.acknowledgeAnnotations('alice', local, { ...document(), revision: 1 });
  const result = (await db.annotations('alice', local.document.context))!;
  assert.equal(result.pending, true); assert.equal(result.document.marks.length, 1); assert.equal(result.conflict?.revision, 4); assert.deepEqual(result.conflict?.marks, []);
});
test('OfflineStore mode/content revision keys remain separate and late writes fail after quarantine', async () => {
  const db = store(); await db.activate(session()); const row = draft(); await db.putAnnotations('alice', row, null);
  const history = draft('history'); history.document.contentHash = history.document.context.contentHash = 'b'.repeat(64); history.document.context.mode = 'fulltext';
  assert.notEqual(annotationKey(row.document.context), annotationKey(history.document.context)); await db.putAnnotations('alice', history, null);
  await db.clear(() => {}, 'alice', true); await assert.rejects(db.putAnnotations('alice', draft('late'), row.localVersion), /账号已变更/);
  await db.activate(session()); assert.equal((await db.pendingAnnotations('alice')).length, 2);
  await db.discardAnnotationDrafts('alice'); await db.clear(); await db.activate(session('bob')); assert.deepEqual(await db.pendingAnnotations('bob'), []);
});
