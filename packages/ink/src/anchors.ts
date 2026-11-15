import { supportedBrush, identityFrame, inverse, multiply, transformPoint, validFrame, visibleBounds, type Clip, type FrameResolution, type Matrix, type RenderFrame } from './frames.ts';
import type { Anchor, AttachmentMode, Point, Stroke } from './types.ts';
import { segmentAtPoint, segmentRange, segmentText, findSegment, SEGMENT_LIMITS, type LocalSegment, type SegmentText, type SegmentMatch } from './segments.ts';
import { engineWork } from './work.ts';
import { LIMITS } from './validation.ts';

interface Locator {
  tag: string;
  path: number[];
  id?: string;
  attrs: [string, string][];
  fingerprint: string;
}
interface Scope { locator: Locator; identity: string }
export interface ContentAnchor extends Anchor {
  kind: 'content-v1' | 'content-segment-v1';
  segment?: LocalSegment;
  target: Locator;
  scope?: Scope;
  /** Stable enclosing IDs/data identities only, never chrome text or UI state. */
  scopeContext?: string;
  /** Border-box/content origin -> creation-time CSS document plane. */
  basis: Matrix;
  mode: 'block' | 'scroll';
  width: number;
}
export interface SurfaceAnchor extends Anchor {
  kind: 'surface-v1';
  /** Complete bounded region identity, not a generic pane's ID or heading. */
  scope: Scope;
  scopeContext: string;
  /** Geometry owner is separately verified, and may contain the identity owner. */
  target: Locator;
  basis: Matrix;
  mode: 'block' | 'scroll';
  width: number;
}
type AttachedAnchor = ContentAnchor | SurfaceAnchor;
export class AttachmentRejectedError extends Error {
  constructor() { super('[attachment-rejected] This location cannot safely follow content. Try Compatibility.'); }
}
/** Only missing local content permits a surface attempt, never unsafe identity/geometry. */
class SurfaceRequired extends Error {}
export interface PageAnchor extends Anchor { kind: 'page-v1'; basis: Matrix; reason: string }
export function isPageAnchor(a: Anchor): a is PageAnchor {
  return a.kind === 'page-v1' && Array.isArray(a.basis) && a.basis.length === 6 &&
    a.basis.every((n, i) => n === [1, 0, 0, 1, 0, 0][i]) && typeof a.reason === 'string' && a.reason.length > 0 && a.reason.length <= 256;
}
const NODE_LIMIT = 4096, MATCH_LIMIT = 64, DEPTH_LIMIT = 48;
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'TABLE']);
const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME']);
/** Archive serialization may absolutize URLs; matching must retain the original attribute semantics. */
function mediaAttribute(element: Element, name: 'src' | 'poster'): string | null {
  const original = element.getAttribute(`data-webink-snapshot-original-${name}`);
  if (original !== null) {
    try {
      const value: unknown = JSON.parse(original);
      if (value === null || typeof value === 'string') return value;
    } catch { /* A malformed page-authored marker has no authority. */ }
  }
  return element.getAttribute(name);
}
const ROOTS = new Set(['HTML', 'BODY']);
const TRANSIENT_DATA = /(?:^|[-_])(?:theme|selection|selected|open|read|unread|state|counter|count|expanded|active|hover|focus|checked|disabled|loading|status)(?:[-_]|$)/;
const ENTRY_MARKER = /^data-(?:(?:is|content)[-_])?(?:entry|article)(?:[-_](?:id|key|uid|uuid|guid))?$/;
const IDENTITY_DATA = /^data-(?:[a-z0-9]+[-_])*(?:id|key|uid|uuid|guid|url|href)$/;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.coordinate;
const boundedText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function isLocator(v: unknown): v is Locator {
  if (!v || typeof v !== 'object') return false;
  const l = v as Locator;
  return typeof l.tag === 'string' && /^[A-Z][A-Z0-9-]{0,63}$/.test(l.tag) && boundedText(l.fingerprint, 128) &&
    (l.id === undefined || boundedText(l.id, 256)) && Array.isArray(l.path) && l.path.length <= DEPTH_LIMIT &&
    l.path.every(n => Number.isInteger(n) && n >= 0 && n <= NODE_LIMIT) && Array.isArray(l.attrs) && l.attrs.length <= 4 &&
    l.attrs.every(a => Array.isArray(a) && a.length === 2 && /^data-[a-z0-9_-]{1,64}$/.test(a[0]) && boundedText(a[1], 256));
}
export function isContentAnchor(a: Anchor): a is ContentAnchor {
  const scope = a.scope as Scope | undefined;
  return (a.kind === 'content-v1' || a.kind === 'content-segment-v1') && isLocator(a.target) &&
    (a.kind === 'content-v1' ? Boolean(a.target.fingerprint) : Boolean(scope) && Boolean(a.segment) &&
      Number.isInteger((a.segment as LocalSegment).length) && (a.segment as LocalSegment).length > 0 &&
      (a.segment as LocalSegment).length <= SEGMENT_LIMITS.window && /^[a-z0-9]{1,7}-[a-z0-9]{1,7}$/.test((a.segment as LocalSegment).fingerprint)) && (a.mode === 'block' || a.mode === 'scroll') &&
    Array.isArray(a.basis) && a.basis.length === 6 && a.basis.every(number) && validFrame({ matrix: a.basis as Matrix, clips: [] }) && number(a.width) && a.width > 0 &&
    (scope === undefined || (isLocator(scope?.locator) && boundedText(scope.identity, 128) && scope.identity.length > 0)) &&
    (a.scopeContext === undefined || (scope !== undefined && boundedText(a.scopeContext, 128) && a.scopeContext.length > 0));
}
export function isSurfaceAnchor(a: Anchor): a is SurfaceAnchor {
  const scope = a.scope as Scope | undefined;
  return a.kind === 'surface-v1' && isLocator(a.target) && /^surface:[a-z0-9-]+$/.test(a.target.fingerprint) &&
    !!scope && isLocator(scope.locator) && boundedText(scope.identity, 128) && /^surface:[a-z0-9-]+$/.test(scope.identity) &&
    boundedText(a.scopeContext, 128) && a.scopeContext.length > 0 && (a.mode === 'block' || a.mode === 'scroll') &&
    Array.isArray(a.basis) && a.basis.length === 6 && a.basis.every(number) && validFrame({ matrix: a.basis as Matrix, clips: [] }) &&
    number(a.width) && a.width > 0;
}
function isAttachedAnchor(a: Anchor): a is AttachedAnchor { return isContentAnchor(a) || isSurfaceAnchor(a); }
/** Only hashes are persisted, never generated styling classes or article text. */
function hash(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
function attributes(element: Element): [string, string][] {
  return [...element.attributes].filter(a => /^data-[a-z0-9_-]{1,64}$/.test(a.name) && !a.name.startsWith('data-webink') && !TRANSIENT_DATA.test(a.name) &&
    a.value.length <= 256).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 4).map(a => [a.name, a.value]);
}
function pathTo(element: Element, root: Element): number[] {
  const path: number[] = [];
  while (element !== root) {
    const parent = element.parentElement;
    if (!parent || path.length === DEPTH_LIMIT) throw new Error('Anchor exceeds DOM depth limit');
    const index = Array.prototype.indexOf.call(parent.children, element) as number;
    if (index > NODE_LIMIT) throw new Error('Anchor exceeds sibling limit');
    path.unshift(index); element = parent;
  }
  return path;
}
function atPath(root: Element, path: number[]): Element | null {
  let element: Element | null = root;
  for (const index of path) element = element?.children.item(index) ?? null;
  return element;
}
function scrolls(style: CSSStyleDeclaration): boolean { return /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`); }
/** These boxes establish a containing block even for fixed descendants. A merely
 * positioned ancestor establishes one for absolute descendants, but not fixed. */
function establishesContainingBlock(style: CSSStyleDeclaration, fixed: boolean): boolean {
  if (style.display === 'contents') return false;
  return (!fixed && style.position !== 'static') || style.transform !== 'none' ||
    [style.translate, style.rotate, style.scale, style.perspective, style.filter, style.backdropFilter].some(value => value && value !== 'none') ||
    /(?:^|\s)(layout|paint|strict|content)(?:\s|$)/.test(style.contain) || style.contentVisibility === 'auto' ||
    style.willChange.split(',').some(value => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter', 'contain'].includes(value.trim()));
}
function effectiveClipAncestors(chain: HTMLElement[], styles: Map<HTMLElement, CSSStyleDeclaration>): Set<HTMLElement> {
  const effective = new Set<HTMLElement>();
  for (let i = 0; i < chain.length;) {
    const style = styles.get(chain[i])!;
    effective.add(chain[i++]);
    if (style.display === 'contents' || (style.position !== 'absolute' && style.position !== 'fixed')) continue;
    // A positioned subtree escapes overflow boxes between itself and its actual
    // containing block. Process that block normally, including its own clipping.
    while (i < chain.length && !establishesContainingBlock(styles.get(chain[i])!, style.position === 'fixed')) i++;
  }
  return effective;
}

/** DOM-only adapter. Identity work is cached until a page mutation; geometry is read
 * once per runtime frame and shared by paint, hit testing, metrics and frozen export.
 * All fallback traversal is bounded and ambiguity fails closed. */
export class ContentAnchorResolver {
  private identityGeneration = {};
  private targets = new WeakMap<Anchor, { status: 'hidden' | 'unresolved' } | { status: 'found'; element: HTMLElement }>();
  private fingerprints = new WeakMap<Element, string>();
  private identities = new WeakMap<Element, string>();
  private contexts = new WeakMap<Element, string>();
  private frames = new WeakMap<Stroke, FrameResolution>();
  private segmentBases = new WeakMap<HTMLElement, Map<string, { matrix: Matrix; clips: Clip[]; width: number }>>();
  private pointMatrices = new WeakMap<Stroke, Matrix>();
  private texts = new WeakMap<Element, SegmentText | null>();
  private surfaceIdentities = new WeakMap<Element, string>();
  private attachmentMode: AttachmentMode = 'smart';
  // A segment descriptor belongs to an immutable document anchor. Weak keys bound
  // retention to live anchors/candidate elements, without a 64-segment cache cliff.
  private segments = new WeakMap<LocalSegment, WeakMap<Element, SegmentMatch>>();
  private bases = new WeakMap<HTMLElement, { mode: string; matrix: Matrix; clips: Clip[]; width: number }>();
  private searches = new Map<string, Element[] | null>();
  private resize: ResizeObserver | null = null;
  private observed = new Set<Element>();
  private readonly win: Window;
  private readonly notice: (code: string) => void;
  constructor(win: Window, notice: (code: string) => void = () => {}, changed: (entries: ResizeObserverEntry[]) => void = () => {}) {
    this.win = win; this.notice = notice;
    if (typeof ResizeObserver !== 'undefined') this.resize = new ResizeObserver(entries => { this.beginFrame(); changed(entries); });
  }
  configure(mode: AttachmentMode): void { this.attachmentMode = mode; }
  destroy(): void { this.invalidate(); this.resize = null; }
  invalidate(): void {
    this.identityGeneration = {};
    this.resize?.disconnect(); this.observed.clear();
    this.targets = new WeakMap(); this.fingerprints = new WeakMap(); this.identities = new WeakMap(); this.contexts = new WeakMap();
    this.texts = new WeakMap(); this.segments = new WeakMap(); this.surfaceIdentities = new WeakMap();
    this.searches.clear(); this.beginFrame();
  }
  beginFrame(): void { this.frames = new WeakMap(); this.pointMatrices = new WeakMap(); this.segmentBases = new WeakMap(); this.bases = new WeakMap(); }
  private text(element: Element, max?: number): string;
  private text(element: Element, max: number, complete: true): string | null;
  private text(element: Element, max = 4096, complete = false): string | null {
    const walker = this.win.document.createTreeWalker(element, 4 /* SHOW_TEXT */);
    let text = '', node: Node | null, count = 0;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue ?? '';
      if (++count > 256 || text.length + value.length > max) {
        if (complete) return null; // Never mistake a truncated paragraph for unchanged content.
        if (count <= 256) text += value.slice(0, max - text.length);
        break;
      }
      text += value;
    }
    return text.replace(/\s+/g, ' ').trim();
  }
  private fingerprint(element: Element): string {
    let value = this.fingerprints.get(element);
    if (value === undefined) {
      const text = this.text(element, 4096, true);
      value = text === null ? '' : hash(`${element.tagName}|${text}|${MEDIA.has(element.tagName) ? mediaAttribute(element, 'src') ?? mediaAttribute(element, 'poster') ?? '' : ''}`);
      this.fingerprints.set(element, value);
    }
    return value;
  }
  private stableIdentity(element: Element): string {
    const title = element.querySelector('h1,h2,h3,h4,h5,h6');
    if (title) { const fingerprint = this.fingerprint(title); return fingerprint ? `stable:heading:${fingerprint}` : ''; }
    // No truncated leading-text identity for local segments in recycled entries.
    const text = this.text(element, 4096, true);
    return text === null ? '' : `stable:text:${hash(text)}`;
  }
  private identity(element: Element): string {
    let value = this.identities.get(element);
    if (value !== undefined) return value;
    const title = element.querySelector('h1,h2,h3,h4,h5,h6');
    const links = title ? null : element.querySelectorAll('a[href]');
    let link: Element | undefined;
    for (let i = 0; links && i < Math.min(links.length, MATCH_LIMIT); i++) {
      if (this.text(links[i], 256).length) { link = links[i]; break; }
    }
    const titleHash = title ? this.fingerprint(title) : '';
    value = title ? (titleHash ? `heading:${titleHash}` : '') : link ? `link:${hash((link.getAttribute('href') ?? '') + '|' + this.text(link, 256))}` : `text:${hash(this.text(element, 512))}`;
    this.identities.set(element, value);
    return value;
  }
  private locator(element: Element, root: Element, scope = false): Locator {
    const id = element.id && element.id.length <= 256 ? element.id : undefined;
    const fingerprint = this.fingerprint(element);
    if (!scope && !fingerprint) throw new Error('[anchor-unresolved] Content block exceeds the fingerprint budget');
    return { tag: element.tagName, path: pathTo(element, root), ...(id ? { id } : {}), attrs: attributes(element), fingerprint };
  }
  private candidates(root: Element, tags: string): Element[] | null {
    const key = root === this.win.document.documentElement ? tags : '';
    if (key && this.searches.has(key)) return this.searches.get(key)!;
    const wanted = new Set(tags.split(',')), result: Element[] = [];
    const walker = this.win.document.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
    let node: Node | null = root, count = 0;
    while (node) {
      if (++count > NODE_LIMIT) { if (key) this.searches.set(key, null); return null; }
      const element = node as Element;
      if (!element.hasAttribute('data-webink-overlay') && (wanted.has('*') || wanted.has(element.tagName))) result.push(element);
      node = walker.nextNode();
    }
    if (key && this.searches.size < 64) this.searches.set(key, result);
    return result;
  }
  private matches(element: Element, locator: Locator): boolean {
    return element.tagName === locator.tag && (!locator.id || element.id === locator.id) &&
      locator.attrs.every(([name, value]) => element.getAttribute(name) === value);
  }
  private locate(root: Element, locator: Locator, identity?: string, segment?: LocalSegment, surface = false): Element[] | null {
    const signature = (element: Element): boolean => segment ? this.segmentMatch(element, segment).status === 'unique' : identity === undefined ?
      Boolean(locator.fingerprint) && this.fingerprint(element) === locator.fingerprint :
      (surface ? this.surfaceIdentity(element) : identity.startsWith('stable:') ? this.stableIdentity(element) : this.identity(element)) === identity;
    const uncertain = (elements: Element[]): boolean => Boolean(segment && elements.some(element => {
      const match = this.segmentMatch(element, segment);
      return match.status === 'ambiguous' || match.status === 'over-budget';
    }));
    if (locator.id || locator.attrs.length) {
      const selector = locator.tag + (locator.id ? `#${CSS.escape(locator.id)}` : '') +
        locator.attrs.map(([name, value]) => `[${name}="${CSS.escape(value)}"]`).join('');
      const selected = root.querySelectorAll(selector);
      if (selected.length > MATCH_LIMIT) return null;
      const strong = [...selected];
      if (root.matches(selector)) strong.unshift(root);
      if (uncertain(strong)) return null;
      const matches = strong.filter(signature);
      if (matches.length) return matches;
      // A differently keyed entry is not the old article, even if boilerplate or
      // a title repeats. Boolean data flags still permit fingerprint recovery.
      if (identity !== undefined && (locator.id || locator.attrs.some(([, value]) => value && !/^(true|false|0|1)$/.test(value)))) return [];
    }
    const candidates = this.candidates(root, locator.tag);
    if (!candidates) return null;
    const hinted = atPath(root, locator.path);
    if (hinted) candidates.sort((a, b) => Number(b === hinted) - Number(a === hinted));
    const strong = candidates.filter(element => this.matches(element, locator));
    // Many ordinary paragraphs share a tag and have no ID/data key. That is not
    // identity ambiguity: compare every complete fingerprint in a bounded scope.
    // Keep the smaller candidate cap for scope, surface and rolling-segment work.
    const boundedBlockSearch = (): boolean => identity === undefined && !segment && Boolean(locator.fingerprint) &&
      this.segmentContent(root) !== null;
    if (strong.length > MATCH_LIMIT && !boundedBlockSearch()) return null;
    if (uncertain(strong)) return null;
    const matches = strong.filter(signature);
    if (matches.length) return matches;
    // Paths are hints, not identity. Fingerprint-only recovery must be unique
    // in the complete bounded scope, never a first-match choice.
    if (candidates.length > MATCH_LIMIT && !boundedBlockSearch()) return null;
    if (uncertain(candidates)) return null;
    return candidates.filter(signature);
  }
  private scopeElement(target: HTMLElement): HTMLElement | null {
    let fallback: HTMLElement | null = null, dataScope: HTMLElement | null = null, headed: HTMLElement | null = null, headedData: HTMLElement | null = null, keyed: HTMLElement | null = null;
    for (let parent = target.parentElement, n = 0; parent && !ROOTS.has(parent.tagName) && n++ < DEPTH_LIMIT; parent = parent.parentElement) {
      // A structural #body/data wrapper must not terminate discovery before the
      // enclosing entry. Semantic entries take precedence over inner headings.
      if (parent.tagName === 'ARTICLE' || parent.getAttribute('role') === 'article' ||
        [...parent.attributes].some(a => ENTRY_MARKER.test(a.name) && a.value !== 'false' && a.value !== '0')) return parent;
      const data = attributes(parent);
      if (data.length || parent.id) {
        fallback ??= parent;
        if (data.length) dataScope ??= parent;
        if (data.some(([name, value]) => IDENTITY_DATA.test(name) && value && !/^(true|false|0|1)$/.test(value))) keyed ??= parent;
        if (parent.querySelector('h1,h2,h3,h4,h5,h6')) {
          headed ??= parent;
          if (data.length) headedData ??= parent;
        }
      }
    }
    // Generic data-keyed entries need not use heading tags. Do not replace their
    // identity with a more distant application's heading merely due to #body.
    return keyed ?? headedData ?? dataScope ?? headed ?? fallback;
  }
  private scopeContext(scope: Element): string {
    const cached = this.contexts.get(scope);
    if (cached !== undefined) return cached;
    const tokens: Array<[string, [string, string][]]> = [];
    for (let parent = scope.parentElement, depth = 0; parent; parent = parent.parentElement) {
      if (++depth > DEPTH_LIMIT || parent.attributes.length > 64 || parent.id.length > 256) throw new Error('Anchor context exceeds identity budget');
      // Identifier-shaped data attributes are meaningful here, not arbitrary
      // data-wrapper/theme/read-state/counter flags or surrounding sidebar text.
      const data = [...parent.attributes].filter(a =>
        IDENTITY_DATA.test(a.name) &&
        !TRANSIENT_DATA.test(a.name) &&
        a.value && !/^(true|false|0|1)$/.test(a.value)).sort((a, b) => a.name.localeCompare(b.name));
      if (data.length > 4 || data.some(a => a.value.length > 256)) throw new Error('Anchor context exceeds identity budget');
      if (parent.id || data.length) tokens.push([parent.id, data.map(a => [a.name, a.value])]);
    }
    const context = hash(JSON.stringify(tokens));
    this.contexts.set(scope, context);
    return context;
  }
  private segmentContent(element: Element): SegmentText | null {
    if (!this.texts.has(element)) this.texts.set(element, segmentText(this.win.document, element));
    return this.texts.get(element)!;
  }
  private segmentMatch(element: Element, segment: LocalSegment): SegmentMatch {
    let entries = this.segments.get(segment);
    if (!entries) { entries = new WeakMap(); this.segments.set(segment, entries); }
    const cached = entries.get(element);
    if (cached) return cached;
    const content = this.segmentContent(element);
    const result = findSegment(content?.text ?? null, segment);
    entries.set(element, result);
    return result;
  }
  private segmentGeometry(element: HTMLElement, segment: LocalSegment, mode: 'block' | 'scroll'): { matrix: Matrix; clips: Clip[]; width: number } {
    let cached = this.segmentBases.get(element);
    if (!cached) { cached = new Map(); this.segmentBases.set(element, cached); }
    const key = `${segment.length}:${segment.fingerprint}:${mode}`;
    if (cached.has(key)) return cached.get(key)!;
    const content = this.segmentContent(element), match = this.segmentMatch(element, segment);
    if (!content || match.status !== 'unique') throw new Error('Local content segment is unavailable or ambiguous');
    const basis = this.geometry(element, mode);
    const rect = segmentRange(this.win.document, content, match.offset, segment.length).getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Local content segment has no visible text geometry');
    const result = { ...basis, matrix: [basis.matrix[0], 0, 0, basis.matrix[3], rect.left + this.win.scrollX, rect.top + this.win.scrollY] as Matrix };
    cached.set(key, result);
    return result;
  }
  private articleSurface(element: Element): boolean {
    return element.tagName === 'ARTICLE' || element.getAttribute('role') === 'article' ||
      [...element.attributes].some(a => ENTRY_MARKER.test(a.name) && a.value && !/^(false|0)$/.test(a.value));
  }
  private surfaceOwner(element: Element): boolean {
    return !ROOTS.has(element.tagName) && element.attributes.length <= 64 && (this.articleSurface(element) ||
      [...element.attributes].some(a => IDENTITY_DATA.test(a.name) && !TRANSIENT_DATA.test(a.name) &&
        a.value && !/^(true|false|0|1)$/.test(a.value)));
  }
  private surfaceIdentity(element: Element): string {
    const cached = this.surfaceIdentities.get(element);
    if (cached !== undefined) return cached;
    const identifiers = [...element.attributes].filter(a => (ENTRY_MARKER.test(a.name) || IDENTITY_DATA.test(a.name)) &&
      !TRANSIENT_DATA.test(a.name)).sort((a, b) => a.name.localeCompare(b.name)).map(a => [a.name, a.value]);
    if (element.id.length > 256 || identifiers.length > 4 || identifiers.some(([, value]) => value.length > 256)) {
      this.surfaceIdentities.set(element, ''); return '';
    }
    const content = this.segmentContent(element);
    const media = this.candidates(element, 'IMG,VIDEO,CANVAS,IFRAME');
    // Complete bounded text catches recycled articles even when their ID and title
    // are reused. Media source changes also invalidate; pixels/reflow are not selectors.
    let value = '';
    if (content?.text.trim() && media) {
      let size = content.text.length + element.id.length + JSON.stringify(identifiers).length;
      const sources: string[][] = [];
      for (const item of media) {
        const src = mediaAttribute(item, 'src') ?? '', poster = mediaAttribute(item, 'poster') ?? '';
        size += src.length + poster.length;
        if (size > SEGMENT_LIMITS.characters) break;
        sources.push([item.tagName, src, poster]);
      }
      if (size <= SEGMENT_LIMITS.characters) value = `surface:${hash(JSON.stringify([element.tagName, element.id, identifiers, content.text, sources]))}`;
    }
    this.surfaceIdentities.set(element, value);
    return value;
  }
  private surfacePair(owner: Element, target: Element): boolean {
    if (!this.surfaceOwner(owner)) return false;
    if (owner.contains(target)) return true;
    if (!target.contains(owner) || ROOTS.has(target.tagName)) return false;
    // A shell may supply the scroll plane only for one complete article, not a
    // multi-item pane, sidebar or guessed nearby item. No text outside that owner.
    const candidates = this.candidates(target, '*');
    return candidates !== null && !candidates.some(element => this.surfaceOwner(element) &&
      !element.contains(owner) && !owner.contains(element)) &&
      this.segmentContent(target)?.text.trim() === this.segmentContent(owner)?.text.trim();
  }
  private createSurface(point: Point): SurfaceAnchor {
    const root = this.win.document.documentElement;
    const hit = this.win.document.elementFromPoint(point.x - this.win.scrollX, point.y - this.win.scrollY);
    if (!(hit instanceof HTMLElement) || hit.hasAttribute('data-webink-overlay') || ROOTS.has(hit.tagName)) throw new Error('No verified surface');
    // Do not bypass unsupported contact geometry by selecting an outer safe box.
    this.geometry(hit, 'block');
    let owner: HTMLElement | null = null, target: HTMLElement | null = null, depth = 0;
    for (let element: HTMLElement | null = hit; element && !ROOTS.has(element.tagName); element = element.parentElement) {
      if (++depth > DEPTH_LIMIT) throw new Error('Surface exceeds DOM depth limit');
      if (!target && scrolls(this.win.getComputedStyle(element))) target = element;
      if (this.surfaceOwner(element)) {
        owner = element;
        if (!this.articleSurface(element)) {
          const descendants = this.candidates(element, '*')?.filter(candidate => candidate !== element && this.surfaceOwner(candidate));
          if (!descendants) throw new Error('Surface exceeds identity search budget');
          const articles = descendants.filter(candidate => this.articleSurface(candidate));
          const identities = articles.length ? articles : descendants;
          // A keyed reader shell is geometry, not the identity of an article it contains.
          if (identities.length > 1) throw new Error('Surface contains ambiguous article identities');
          if (identities.length === 1) {
            if (!(identities[0] instanceof HTMLElement)) throw new Error('Unsupported surface owner');
            owner = identities[0];
          }
        }
        break;
      }
    }
    if (!owner && target) {
      const candidates = this.candidates(target, '*')?.filter(element => this.surfaceOwner(element));
      if (candidates?.length === 1 && candidates[0] instanceof HTMLElement) owner = candidates[0];
    }
    target ??= owner;
    if (!owner || !target || !this.surfacePair(owner, target)) throw new Error('Surface identity is absent or ambiguous');
    const identity = this.surfaceIdentity(owner), targetIdentity = this.surfaceIdentity(target);
    if (!identity || !targetIdentity) throw new Error('Surface exceeds complete identity budget');
    const scope = { locator: this.locator(owner, root, true), identity };
    const locator = { ...this.locator(target, root, true), fingerprint: targetIdentity };
    if (this.locate(root, scope.locator, identity, undefined, true)?.length !== 1 || this.locate(root, locator, targetIdentity, undefined, true)?.length !== 1) {
      throw new Error('Surface identity is ambiguous');
    }
    const mode = scrolls(this.win.getComputedStyle(target)) ? 'scroll' : 'block';
    const basis = this.geometry(target, mode);
    const anchor: SurfaceAnchor = { kind: 'surface-v1', scope, scopeContext: this.scopeContext(owner), target: locator,
      basis: basis.matrix, mode, width: basis.width };
    if (!isSurfaceAnchor(anchor)) throw new Error('Invalid surface geometry');
    this.targets.set(anchor, { status: 'found', element: target });
    return anchor;
  }
  create(point: Point): AttachedAnchor | PageAnchor {
    if (this.attachmentMode === 'legacy') {
      try { return this.createContent(point); }
      catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 256);
        this.notice('page-fallback');
        return { kind: 'page-v1', basis: [1, 0, 0, 1, 0, 0], reason };
      }
    }
    try {
      const anchor = this.createSmart(point);
      if (anchor.kind === 'surface-v1') this.notice('surface-following');
      return anchor;
    } catch { throw new AttachmentRejectedError(); }
  }
  private createSmart(point: Point): AttachedAnchor {
    try { return this.createContent(point, true); }
    catch (error) {
      if (!(error instanceof SurfaceRequired)) throw error;
      return this.createSurface(point);
    }
  }
  /** A contact-only probe, never ink: unsupported origins conservatively lose
   * continuity on identity invalidation, without choosing/noticing page fallback. */
  captureEraserOrigin(point: Point): () => boolean {
    const generation = this.identityGeneration;
    try {
      const probe: Stroke = { id: 'eraser-origin', tool: 'pen', color: '#000000', width: 0.1, opacity: 0,
        points: [point], anchor: this.attachmentMode === 'legacy' ? this.createContent(point) : this.createSmart(point) };
      const initial = this.resolve(probe, false);
      if (initial.status === 'visible') {
        const frame = JSON.stringify(initial.frame);
        return () => {
          const current = this.resolve(probe, false);
          return current.status === 'visible' && JSON.stringify(current.frame) === frame;
        };
      }
    } catch { /* No reliable content identity: a later mutation must cancel. */ }
    return () => generation === this.identityGeneration;
  }
  private createContent(point: Point, smart = false): ContentAnchor {
    const doc = this.win.document, root = doc.documentElement;
    let hit = doc.elementFromPoint(point.x - this.win.scrollX, point.y - this.win.scrollY);
    if (!hit || hit.hasAttribute('data-webink-overlay')) throw new Error('No structured content at the contact');
    let target: HTMLElement | null = null, fallback: HTMLElement | null = null, depth = 0;
    while (hit && !ROOTS.has(hit.tagName) && depth++ < DEPTH_LIMIT) {
      if (hit instanceof HTMLElement) {
        if (BLOCKS.has(hit.tagName)) { target = hit; break; }
        if (!fallback && /^(block|flex|grid|flow-root|list-item)$/.test(this.win.getComputedStyle(hit).display)) fallback = hit;
      }
      hit = hit.parentElement;
    }
    target ??= fallback;
    if (!target) throw new Error('Unstructured page background');
    // Generic containers and their blank padding are regions, not content blocks.
    // Legacy keeps its exact original target/fallback semantics.
    if (smart && (!BLOCKS.has(target.tagName) || !MEDIA.has(target.tagName) && this.text(target, 4096, true) === '')) {
      this.geometry(target, 'block');
      // A bounded old content candidate must still pass its identity checks. A
      // region is not an escape hatch from an ambiguous block/scope match.
      if (this.fingerprint(target)) this.createContent(point);
      throw new SurfaceRequired();
    }
    const scopeElement = this.scopeElement(target);
    const mode = scrolls(this.win.getComputedStyle(target)) ? 'scroll' : 'block';
    const long = !this.fingerprint(target);
    const content = long ? this.segmentContent(target) : null;
    const segment = content ? segmentAtPoint(doc, content, point, this.win.scrollX, this.win.scrollY) : null;
    if (smart && long && content && !segment) { this.geometry(target, mode); throw new SurfaceRequired(); }
    if (long && (!segment || !scopeElement)) throw new Error('Local segment requires bounded text and an identifiable enclosing scope');
    const basis = segment ? this.segmentGeometry(target, segment, mode) : this.geometry(target, mode);
    const scope = scopeElement ? { locator: this.locator(scopeElement, root, true),
      identity: long ? this.stableIdentity(scopeElement) : this.identity(scopeElement) } : undefined;
    if (scope && !scope.identity) throw new Error('Content scope exceeds the complete identity budget');
    const anchor: ContentAnchor = { kind: segment ? 'content-segment-v1' : 'content-v1',
      target: this.locator(target, scopeElement ?? root, long), ...(segment ? { segment } : {}),
      ...(scope ? { scope, scopeContext: this.scopeContext(scopeElement!) } : {}), basis: basis.matrix, mode, width: basis.width };
    const matches = this.locate(scopeElement ?? root, anchor.target, undefined, segment ?? undefined);
    if (!matches || matches.length !== 1 || (scope && this.locate(root, scope.locator, scope.identity)?.length !== 1)) {
      throw new Error('Content identity is ambiguous');
    }
    this.targets.set(anchor, { status: 'found', element: target });
    return anchor;
  }
  resolve = (stroke: Stroke, visibility = true): FrameResolution => {
    const cached = visibility ? this.frames.get(stroke) : undefined;
    if (cached) return cached;
    engineWork.resolutions++;
    let result: FrameResolution;
    const anchor = stroke.anchor;
    if (!supportedBrush(stroke)) result = { status: 'unresolved' };
    else if (!anchor || isPageAnchor(anchor)) result = { status: 'visible', frame: identityFrame() };
    else if (!isAttachedAnchor(anchor)) result = { status: 'unresolved' };
    else {
      try {
        const target = this.target(anchor);
        if (target.status !== 'found') result = target;
        else if (!target.element.isConnected || this.inactive(target.element)) result = { status: 'hidden' };
        else {
          const current = anchor.kind !== 'surface-v1' && anchor.segment ? this.segmentGeometry(target.element, anchor.segment, anchor.mode) : this.geometry(target.element, anchor.mode);
          const frame: RenderFrame = { matrix: multiply(current.matrix, inverse(anchor.basis)), clips: current.clips };
          if (!validFrame(frame)) result = { status: 'unresolved' };
          else if (visibility && !visibleBounds(stroke, frame)) result = { status: 'hidden' };
          else {
            if (Math.abs(current.width - anchor.width) > 2) this.notice('layout-changed');
            result = { status: 'visible', frame };
          }
        }
      } catch { result = { status: 'unresolved' }; }
    }
    if (result.status === 'unresolved') this.notice('anchor-unresolved');
    if (visibility) this.frames.set(stroke, result);
    return result;
  };
  private target(anchor: AttachedAnchor): { status: 'hidden' | 'unresolved' } | { status: 'found'; element: HTMLElement } {
    const cached = this.targets.get(anchor);
    if (cached) return cached;
    const root = this.win.document.documentElement;
    let scope: Element = root;
    let result: ReturnType<ContentAnchorResolver['target']>;
    if (anchor.scope) {
      const matches = this.locate(root, anchor.scope.locator, anchor.scope.identity, undefined, anchor.kind === 'surface-v1');
      if (!matches || matches.length > 1) { result = { status: 'unresolved' }; this.targets.set(anchor, result); return result; }
      if (!matches.length) { result = { status: 'hidden' }; this.targets.set(anchor, result); return result; }
      scope = matches[0];
      if (anchor.scopeContext !== undefined && this.scopeContext(scope) !== anchor.scopeContext) {
        result = { status: 'hidden' }; this.targets.set(anchor, result); return result;
      }
    }
    const matches = anchor.kind === 'surface-v1' ? this.locate(root, anchor.target, anchor.target.fingerprint, undefined, true) :
      this.locate(scope, anchor.target, undefined, anchor.segment);
    result = matches?.length === 1 && matches[0] instanceof HTMLElement ? { status: 'found', element: matches[0] } : { status: 'unresolved' };
    if (result.status === 'found' && (anchor.kind === 'surface-v1' ? !this.surfacePair(scope, result.element) :
      this.scopeElement(result.element) !== (anchor.scope ? scope : null))) {
      // Older content-v1 anchors may have captured only an inner wrapper. The
      // missing outer identity cannot be reconstructed safely after recycling.
      result = { status: 'unresolved' };
    }
    this.targets.set(anchor, result);
    return result;
  }
  /** Runtime-only target for detached export projection; never put it in Page. */
  resolvedTarget(stroke: Stroke): Element | null {
    if (!stroke.anchor || !isAttachedAnchor(stroke.anchor)) return null;
    const target = this.target(stroke.anchor);
    return target.status === 'found' ? target.element : null;
  }
  /** Export-only positive exclusion proof. Absence/ambiguity is not other-article proof.
   * Does not alter resolver matching, caches, or visibility decisions. */
  exportExclusion(stroke: Stroke, reader?: Element): 'outside-reader' | 'other-article' | null {
    const anchor = stroke.anchor;
    if (!anchor || !isAttachedAnchor(anchor)) return null;
    try {
      const target = this.resolvedTarget(stroke);
      if (target && reader && !reader.contains(target)) return 'outside-reader';
      if (anchor.scope && anchor.scopeContext !== undefined) {
        const matches = this.locate(this.win.document.documentElement, anchor.scope.locator, anchor.scope.identity, undefined, anchor.kind === 'surface-v1');
        if (matches?.length === 1 && this.scopeContext(matches[0]) !== anchor.scopeContext) return 'other-article';
      }
    } catch { /* Uncertain identity remains eligible for the unlocated appendix. */ }
    return null;
  }
  private inactive(element: HTMLElement): boolean {
    if (!element.getClientRects().length || this.win.getComputedStyle(element).visibility !== 'visible') return true;
    for (let p: HTMLElement | null = element, depth = 0; p && depth++ < DEPTH_LIMIT; p = p.parentElement) {
      const style = this.win.getComputedStyle(p);
      if (style.display === 'none' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return true;
    }
    return false;
  }
  private geometry(element: HTMLElement, mode: 'block' | 'scroll'): { matrix: Matrix; clips: Clip[]; width: number } {
    const cached = this.bases.get(element);
    if (cached?.mode === mode) return cached;
    const chain: HTMLElement[] = [];
    for (let p: HTMLElement | null = element; p; p = p.parentElement) {
      if (chain.length === DEPTH_LIMIT) throw new Error('Anchor ancestor limit exceeded');
      chain.push(p);
      if (this.resize && !this.observed.has(p) && this.observed.size < NODE_LIMIT) { this.resize.observe(p); this.observed.add(p); }
    }
    let sx = 1, sy = 1;
    const scales = new Map<HTMLElement, [number, number]>();
    const styles = new Map<HTMLElement, CSSStyleDeclaration>();
    for (const p of [...chain].reverse()) {
      const style = this.win.getComputedStyle(p);
      styles.set(p, style);
      if (style.clipPath !== 'none' || (style.maskImage && style.maskImage !== 'none')) throw new Error('Unsupported anchor clipping shape');
      if (style.perspective !== 'none' || (style.rotate && style.rotate !== 'none' && style.rotate !== '0deg')) throw new Error('Unsupported perspective/rotation');
      if (style.transform !== 'none') {
        const m = new DOMMatrixReadOnly(style.transform);
        if (!m.is2D || Math.abs(m.b) > 1e-8 || Math.abs(m.c) > 1e-8 || m.a <= 0 || m.d <= 0) throw new Error('Unsupported anchor transform');
        sx *= m.a; sy *= m.d;
      }
      if (style.scale && style.scale !== 'none') {
        const parts = style.scale.split(/\s+/).map(Number);
        if (!parts.every(n => Number.isFinite(n) && n > 0) || parts.length > 2) throw new Error('Unsupported anchor scale');
        sx *= parts[0]; sy *= parts[1] ?? parts[0];
      }
      const zoom = Number(style.zoom);
      if (Number.isFinite(zoom) && zoom > 0) { sx *= zoom; sy *= zoom; }
      scales.set(p, [sx, sy]);
    }
    const rect = element.getBoundingClientRect();
    const matrix: Matrix = [sx, 0, 0, sy, rect.left + this.win.scrollX - (mode === 'scroll' ? element.scrollLeft * sx : 0),
      rect.top + this.win.scrollY - (mode === 'scroll' ? element.scrollTop * sy : 0)];
    const clips: Clip[] = [];
    const effective = effectiveClipAncestors(chain, styles);
    for (const p of chain) {
      // Root overflow is the document viewport, not a long-page export clip.
      const style = styles.get(p)!;
      if (ROOTS.has(p.tagName) || style.display === 'contents' || !effective.has(p) || !scrolls(style)) continue;
      if (clips.length === 16) throw new Error('Anchor overflow clip limit exceeded');
      const r = p.getBoundingClientRect(), [xScale, yScale] = scales.get(p)!;
      const left = r.left + this.win.scrollX + p.clientLeft * xScale, top = r.top + this.win.scrollY + p.clientTop * yScale;
      const right = left + p.clientWidth * xScale, bottom = top + p.clientHeight * yScale;
      const x1 = style.overflowX === 'visible' ? -LIMITS.coordinate : left;
      const x2 = style.overflowX === 'visible' ? LIMITS.coordinate : right;
      const y1 = style.overflowY === 'visible' ? -LIMITS.coordinate : top;
      const y2 = style.overflowY === 'visible' ? LIMITS.coordinate : bottom;
      clips.push([x1, y1, x2, y1, x2, y2, x1, y2]);
    }
    const result = { mode, matrix, clips, width: rect.width / sx };
    if (!validFrame(result)) throw new Error('Invalid anchor frame');
    this.bases.set(element, result);
    return result;
  }
  /** Convert incoming document samples back into the creation-time world plane. */
  point(stroke: Stroke, point: Point): Point {
    let matrix = this.pointMatrices.get(stroke);
    if (!matrix) {
      const resolved = this.resolve(stroke, false);
      if (resolved.status !== 'visible') throw new Error('[anchor-unresolved] Active stroke content is unavailable');
      matrix = inverse(resolved.frame.matrix); this.pointMatrices.set(stroke, matrix);
    }
    return { ...transformPoint(matrix, point), p: point.p };
  }
}
