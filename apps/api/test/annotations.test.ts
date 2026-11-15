import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { buildInkPreviews } from '@feedink/ink/preview';
import type { AnnotationDocument, InkPage } from '@feedink/shared';
import { annotationPrecondition, validateAnnotations, validateNotesBackup } from '../src/annotation-validation.js';
import { canonicalAnnotationHash, notesBackup } from '../src/annotations.js';
import { markdownNotes, notePreview } from '../src/annotation-exports.js';
import { readZip } from '../src/zip.js';

const url = 'https://example.invalid/article';
const ink = (): InkPage => ({ version: 1, url, title: 'Synthetic article', updatedAt: 1, layoutWidth: 800, strokes: [{ id: 's1', tool: 'highlighter', color: '#FF0000', opacity: 0.5, width: 20, points: [{ x: 10, y: 10, p: 1 }, { x: 10, y: 10, p: 1 }] }] });
const payload = () => ({ schemaVersion: 1 as const, contentHash: 'a'.repeat(64), ink: ink(), marks: [{ id: 'm1', kind: 'note' as const, color: 'yellow' as const, anchor: null, text: 'Synthetic remark', createdAt: 1, updatedAt: 1 }] });
const document = (): AnnotationDocument => ({ ...payload(), id: randomUUID(), revision: 1, updatedAt: new Date(1).toISOString(), versions: [], context: { articleId: randomUUID(), mode: 'feed', contentHash: 'a'.repeat(64), sourceUrl: url, title: 'Synthetic article', contentHtml: '<p>Synthetic article</p>' } });

test('annotation validation preserves raw ink spelling and rejects unsupported, unsafe, over-budget input atomically', () => {
  const raw = payload();
  assert.equal(validateAnnotations(raw, url), raw);
  assert.equal(raw.ink.strokes[0].color, '#FF0000');
  assert.equal(validateNotesBackup(notesBackup(document())).format, 'feedink-notes');
  const reject = (mutate: (value: any) => void) => { const value = structuredClone(raw); mutate(value); assert.throws(() => validateAnnotations(value, url)); };
  reject(p => p.schemaVersion = 2);
  reject(p => p.ink.version = 2);
  reject(p => p.ink.url = 'https://example.invalid/other');
  reject(p => p.ink.strokes[0].anchor = { kind: 'render-v1', matrix: [1, 0, 0, 1, 0, 0] });
  reject(p => p.ink.strokes[0].color = 'url(https://example.invalid/svg)');
  reject(p => p.ink.strokes[0].points[0].x = Infinity);
  reject(p => p.ink.strokes[0].points[0].x = 1_000_001);
  reject(p => p.ink.strokes.push(p.ink.strokes[0]));
  reject(p => p.marks.push(p.marks[0]));
  reject(p => p.marks[0].kind = 'highlight');
  reject(p => p.marks[0].text = '\ud800');
  reject(p => p.marks[0].text = '\udc00');
  reject(p => p.marks[0].text = '\u0000');
  reject(p => p.marks[0].updatedAt = -1);
  reject(p => p.marks[0].text = 'x'.repeat(32769));
  reject(p => p.marks[0].anchor = { kind: 'text-quote-v1', exact: 'x'.repeat(8193), prefix: '', suffix: '', start: 0, end: 8193 });
  reject(p => p.marks[0].anchor = { kind: 'text-quote-v1', exact: 'x', prefix: 'x'.repeat(65), suffix: '', start: 0, end: 1 });
  reject(p => p.ink.extra = 'must not silently disappear');
  reject(p => p.ink.strokes[0].anchor = JSON.parse('{"kind":"opaque","__proto__":{"polluted":true}}'));
  reject(p => p.ink.strokes[0].anchor = { kind: 'opaque', nested: Object.create({ inherited: true }) });
  reject(p => { let v: any = { kind: 'opaque' }; p.ink.strokes[0].anchor = v; for (let i = 0; i < 30; i++) { v.next = {}; v = v.next; } });
  reject(p => p.marks = Array.from({ length: 5001 }, (_, i) => ({ ...p.marks[0], id: String(i) })));
  reject(p => p.ink.strokes[0].points = Array.from({ length: 20001 }, () => ({ x: 0, y: 0, p: 1 })));
  reject(p => p.marks = Array.from({ length: 260 }, (_, i) => ({ ...p.marks[0], id: String(i), text: 'x'.repeat(32768) })));
  assert.equal(({} as any).polluted, undefined);
});

test('annotation If-Match is mandatory, one exact safe integer, with zero reserved for absence', () => {
  assert.equal(annotationPrecondition('"0"'), 0);
  assert.equal(annotationPrecondition('"17"'), 17);
  for (const value of [undefined, '*', '0', 'W/"1"', '"1", "2"', '"-1"', '"01"', '"9007199254740992"']) assert.throws(() => annotationPrecondition(value));
});

test('canonicalAnnotationHash survives owned image UUID relocation and rejects foreign references', () => {
  const one = randomUUID(), two = randomUUID();
  const a = `<p>Same source</p><img src="/api/assets/${one}" />`, b = a.replace(one, two);
  const images = new Map([[one, 'https://example.invalid/picture.png'], [two, 'https://example.invalid/picture.png']]);
  assert.equal(canonicalAnnotationHash(a, url, 'feed', images), canonicalAnnotationHash(b, url, 'feed', images));
  assert.notEqual(canonicalAnnotationHash(a, url, 'feed', images), canonicalAnnotationHash(a, url, 'fulltext', images));
  assert.notEqual(canonicalAnnotationHash(a, url, 'feed', images), canonicalAnnotationHash(a, url + '/other', 'feed', images));
  assert.throws(() => canonicalAnnotationHash(a, url, 'feed', new Map([[two, images.get(two)!]])));
});

test('buildInkPreviews groups stable anchor identity and transforms differing captures without per-segment opacity', () => {
  const page = ink();
  const anchor = { kind: 'content-v1', target: { tag: 'P', path: [0], attrs: [], fingerprint: 'stable-content' }, mode: 'block', basis: [1, 0, 0, 1, 0, 0], width: 100 };
  page.strokes[0].anchor = anchor;
  page.strokes.push({ ...page.strokes[0], id: 's2', anchor: { ...anchor, basis: [1, 0, 0, 1, 100, 0], width: 200 }, points: [{ x: 120, y: 20, p: 1 }] });
  const result = buildInkPreviews(page);
  assert.equal(result.totalGroups, 1);
  assert.deepEqual(result.groups[0].strokeIds, ['s1', 's2']);
  assert.equal(result.groups[0].unlocated, true);
  assert.match(result.groups[0].svg, /matrix\(0.5 0 0 0.5 -50 0\)/);
  assert.equal(result.groups[0].svg.match(/opacity="0.5"/g)?.length, 2);
  assert.equal(result.groups[0].svg.match(/<path /g)?.length, 2);
  assert.ok(result.groups[0].width <= 1400 && result.groups[0].height <= 1800);
  page.strokes[1].anchor!.basis = [0, 0, 0, 0, 0, 0];
  assert.throws(() => buildInkPreviews(page));
});

test('buildInkPreviews paginates all opaque planes and rejects render bounds instead of truncating', () => {
  const page = ink();
  page.strokes = Array.from({ length: 23 }, (_, i) => ({ ...page.strokes[0], id: `stroke-${i}`, anchor: { kind: 'unknown-anchor', identity: i } }));
  const first = buildInkPreviews(page), last = buildInkPreviews(page, { groupOffset: first.nextGroupOffset! });
  assert.equal(first.totalGroups, 23); assert.equal(first.groups.length, 20);
  assert.equal(last.groups.length, 3); assert.equal(last.nextGroupOffset, null);
  assert.equal(new Set([...first.groups, ...last.groups].flatMap(g => g.strokeIds)).size, 23);
  for (const options of [{ maxWidth: 1401 }, { maxHeight: 1801 }, { groupLimit: 101 }, { groupOffset: -1 }, { maxWidth: NaN }]) assert.throws(() => buildInkPreviews(page, options));
  page.strokes[0].anchor = { kind: 'render-v1', matrix: [1, 0, 0, 1, 0, 0] };
  assert.throws(() => buildInkPreviews(page));
});

test('buildInkPreviews rejects excessive SVG work without returning partial stroke inventory', () => {
  const page = ink();
  page.strokes = Array.from({ length: 5 }, (_, stroke) => ({ ...page.strokes[0], id: String(stroke), points: Array.from({ length: 20000 }, (_, i) => ({ x: i + 0.123456789, y: i + 0.987654321, p: 1 })) }));
  assert.throws(() => buildInkPreviews(page), /render budget/);
});

test('Sharp previews retain single-stroke opacity and portable Markdown includes every group and restorable JSON', async () => {
  const doc = document();
  const preview = await notePreview(doc);
  const decoded = await sharp(preview.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.floor(decoded.info.width / 2), y = Math.floor(decoded.info.height / 2), index = (y * decoded.info.width + x) * 3;
  assert.ok(decoded.data[index] >= 250);
  assert.ok(decoded.data[index + 1] >= 120 && decoded.data[index + 1] <= 135, 'overlapping circles must apply alpha only once');
  doc.marks[0].text = '<script>not executable</script> [link](https://example.invalid/)';
  doc.ink!.strokes = Array.from({ length: 23 }, (_, i) => ({ ...doc.ink!.strokes[0], id: `stroke-${i}`, anchor: { kind: 'opaque', identity: i } }));
  const files = await readZip(await markdownNotes(doc));
  assert.equal([...files.keys()].filter(k => k.endsWith('.png')).length, 23);
  assert.deepEqual(JSON.parse(files.get('notes.json')!.toString()), notesBackup(doc));
  const md = files.get('notes.md')!.toString();
  assert.match(md, /&lt;script&gt;/); assert.doesNotMatch(md, /<script>/);
  assert.match(md, /\(ink\/group-22.png\)/); assert.match(md, /unlocated/);
  doc.ink!.strokes = Array.from({ length: 101 }, (_, i) => ({ ...doc.ink!.strokes[0], id: `stroke-${i}`, anchor: { kind: 'opaque', identity: i } }));
  await assert.rejects(() => markdownNotes(doc), /preview budget/);
});
