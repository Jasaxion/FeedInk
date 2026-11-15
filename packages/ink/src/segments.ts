import { engineWork } from './work.ts';
import type { Point } from './types.ts';

export interface LocalSegment { length: number; fingerprint: string }
export type SegmentMatch = { status: 'unique'; offset: number } | { status: 'missing' | 'ambiguous' | 'over-budget' };
export interface SegmentText { text: string; nodes: Array<{ node: Text; start: number }> }
export const SEGMENT_LIMITS = Object.freeze({ characters: 262_144, nodes: 4096, window: 128 });

/** Full bounded search domain; never return a prefix as a complete block. */
export function segmentText(doc: Document, target: Element): SegmentText | null {
  const walker = doc.createTreeWalker(target, 4);
  const nodes: SegmentText['nodes'] = [];
  let node: Node | null, text = '';
  while ((node = walker.nextNode())) {
    if (nodes.length === SEGMENT_LIMITS.nodes || text.length + (node.nodeValue?.length ?? 0) > SEGMENT_LIMITS.characters) return null;
    nodes.push({ node: node as Text, start: text.length }); text += node.nodeValue ?? '';
  }
  return { text, nodes };
}
function pair(text: string): [number, number] {
  let a = 0, b = 0;
  for (let i = 0; i < text.length; i++) { a = (Math.imul(a, 31) + text.charCodeAt(i)) >>> 0; b = (Math.imul(b, 37) + text.charCodeAt(i)) >>> 0; }
  return [a, b];
}
export function segmentFingerprint(text: string): string { return pair(text).map(n => n.toString(36)).join('-'); }
/** Two rolling hashes check every offset, not only chunk boundaries or the old DOM path. */
export function findSegment(text: string | null, segment: LocalSegment): SegmentMatch {
  if (text === null) return { status: 'over-budget' };
  engineWork.segmentSearches++;
  const length = segment.length;
  if (text.length < length) return { status: 'missing' };
  let pa = 1, pb = 1;
  for (let i = 1; i < length; i++) { pa = Math.imul(pa, 31); pb = Math.imul(pb, 37); }
  const [wantedA, wantedB] = segment.fingerprint.split('-').map(n => parseInt(n, 36));
  let [a, b] = pair(text.slice(0, length)), found: number | null = null;
  for (let start = 0; start <= text.length - length; start++) {
    engineWork.segmentPositions++;
    if (a === wantedA && b === wantedB) {
      if (found !== null) return { status: 'ambiguous' };
      found = start;
    }
    if (start + length < text.length) {
      a = (Math.imul(a - Math.imul(text.charCodeAt(start), pa), 31) + text.charCodeAt(start + length)) >>> 0;
      b = (Math.imul(b - Math.imul(text.charCodeAt(start), pb), 37) + text.charCodeAt(start + length)) >>> 0;
    }
  }
  return found === null ? { status: 'missing' } : { status: 'unique', offset: found };
}
export function segmentRange(doc: Document, text: SegmentText, start: number, length: number): Range {
  const range = doc.createRange();
  const at = (offset: number): { node: Text; offset: number } => {
    const entry = [...text.nodes].reverse().find(entry => entry.start <= offset)!;
    return { node: entry.node, offset: offset - entry.start };
  };
  const first = at(start), last = at(start + length);
  range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
  return range;
}
export function segmentAtPoint(doc: Document, text: SegmentText, point: Point, scrollX: number, scrollY: number): LocalSegment | null {
  const caret = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
    .caretRangeFromPoint?.(point.x - scrollX, point.y - scrollY);
  if (!caret || !text.text.length) return null;
  const entry = text.nodes.find(entry => entry.node === caret.startContainer);
  if (!entry) return null;
  const length = Math.min(SEGMENT_LIMITS.window, text.text.length);
  const start = Math.max(0, Math.min(text.text.length - length, entry.start + caret.startOffset - Math.floor(length / 2)));
  return { length, fingerprint: segmentFingerprint(text.text.slice(start, start + length)) };
}
