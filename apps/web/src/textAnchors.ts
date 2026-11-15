/** FeedInk adaptation of WebInk's text-quote resolver (Apache-2.0).
 * Modified: module API, active-reader-only traversal, shared mark schema and bounded
 * DOM Range presentation. No native bridge/global injection. See packages/ink/LICENSE
 * and repository NOTICE. Ambiguous quotes never resolve using offsets alone. */
import type { TextQuoteAnchor } from '@feedink/shared';
import { validText } from './annotationData';
export interface QuoteStream { value: string; nodes: Array<{ node: Text; start: number; end: number }>; blocked: Node[] }
export function quoteStream(root: HTMLElement): QuoteStream {
  const nodes: QuoteStream['nodes'] = [], blocked: Node[] = [];
  let count = 0, units = 0;
  const visit = (node: Node) => {
    if (++count > 8192) throw new Error('正文超出文字定位预算；已有笔记仍保留');
    if (node instanceof Element) {
      const style = getComputedStyle(node);
      if (node.matches('script,style,form,input,textarea,select,button,iframe,[hidden],[aria-hidden="true"],[contenteditable], [data-webink-overlay]') || style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') { blocked.push(node); return; }
    }
    if (node instanceof Text) {
      if (nodes.length >= 4096 || units + node.length > 262144) throw new Error('正文超出文字定位预算；已有笔记仍保留');
      nodes.push({ node, start: units, end: units + node.length }); units += node.length;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  const value = nodes.map(entry => entry.node.data).join('');
  if (!validText(value, 262144)) throw new Error('正文含不支持的 Unicode');
  return { value, nodes, blocked };
}
const boundary = (value: string, offset: number) => !(offset > 0 && offset < value.length && /[\uD800-\uDBFF]/.test(value[offset - 1]) && /[\uDC00-\uDFFF]/.test(value[offset]));
export type QuoteMatch = { status: 'located'; start: number; end: number } | { status: 'missing' | 'ambiguous' | 'limit' };
export function matchQuote(value: string, anchor: TextQuoteAnchor, budget = { left: 8388608 }): QuoteMatch {
  let from = 0, count = 0, start = 0;
  while (from <= value.length - anchor.exact.length) {
    budget.left -= value.length - from + anchor.prefix.length + anchor.suffix.length;
    if (budget.left < 0) return { status: 'limit' };
    const at = value.indexOf(anchor.exact, from); if (at < 0) break;
    const end = at + anchor.exact.length;
    if (boundary(value, at) && boundary(value, end) && at >= anchor.prefix.length && value.slice(at - anchor.prefix.length, at) === anchor.prefix && value.slice(end, end + anchor.suffix.length) === anchor.suffix) { count++; start = at; }
    if (count > 1) return { status: 'ambiguous' };
    from = at + 1;
  }
  return count === 1 ? { status: 'located', start, end: start + anchor.exact.length } : { status: 'missing' };
}
export function quoteRange(stream: QuoteStream, start: number, end: number): Range {
  const first = stream.nodes.find(entry => entry.end > start), last = [...stream.nodes].reverse().find(entry => entry.start < end);
  if (!first || !last) throw new Error('选区无法定位');
  const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  if (stream.blocked.some(node => range.intersectsNode(node))) throw new Error('选区包含不可批注区域');
  return range;
}
export function captureQuote(root: HTMLElement): TextQuoteAnchor {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) throw new Error('请先在当前正文中选择文字');
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) throw new Error('只能批注当前文章正文');
  const stream = quoteStream(root);
  if (stream.blocked.some(node => range.intersectsNode(node))) throw new Error('选区包含不可批注区域');
  let start = -1, end = -1;
  for (const entry of stream.nodes) if (range.intersectsNode(entry.node)) {
    const a = entry.node === range.startContainer ? range.startOffset : 0, b = entry.node === range.endContainer ? range.endOffset : entry.node.length;
    if (b <= a) continue;
    if (start < 0) start = entry.start + a;
    end = entry.start + b;
  }
  if (start < 0 || end <= start || end - start > 8192 || !boundary(stream.value, start) || !boundary(stream.value, end)) throw new Error('选区为空或超过 8192 字符');
  let before = Math.max(0, start - 64), after = Math.min(stream.value.length, end + 64);
  if (!boundary(stream.value, before)) before++; if (!boundary(stream.value, after)) after--;
  const anchor: TextQuoteAnchor = { kind: 'text-quote-v1', exact: stream.value.slice(start, end), prefix: stream.value.slice(before, start), suffix: stream.value.slice(end, after), start, end };
  if (matchQuote(stream.value, anchor).status !== 'located') throw new Error('引用不唯一，无法安全定位');
  return anchor;
}
