import type { Page, Stroke } from './types.ts';
import { validatePage, LIMITS } from './validation.ts';
import { isContentAnchor, isSurfaceAnchor, isPageAnchor } from './anchors.ts';
import { inverse, multiply, validFrame, visibleBounds, type Matrix } from './frames.ts';
import { appendStrokePath, type Bounds, type StrokePath } from './geometry.ts';

export interface InkPreviewOptions { groupOffset?: number; groupLimit?: number; maxWidth?: number; maxHeight?: number }
export interface InkPreviewGroup { id: string; strokeIds: string[]; width: number; height: number; svg: string; unlocated: boolean }
export interface InkPreviews { groups: InkPreviewGroup[]; totalGroups: number; nextGroupOffset: number | null }
const MAX_SVG_BYTES = 12 * 1024 * 1024;
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Preview option exceeds render budget');
  return n;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function number(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > LIMITS.coordinate * 16) throw new Error('Preview geometry exceeds render budget');
  return String(n);
}
function path(stroke: Stroke): string {
  const parts: string[] = [];
  const sink: StrokePath = {
    moveTo(x, y) { parts.push(`M${number(x)} ${number(y)}`); },
    lineTo(x, y) { parts.push(`L${number(x)} ${number(y)}`); },
    arc(x, y, r) {
      parts.push(`A${number(r)} ${number(r)} 0 1 1 ${number(x - r)} ${number(y)}A${number(r)} ${number(r)} 0 1 1 ${number(x + r)} ${number(y)}`);
    },
    closePath() { parts.push('Z'); },
  };
  appendStrokePath(sink, stroke);
  return parts.join('');
}

/** Raw capture report, not a current-DOM placement. No input SVG or DOM is used.
 * Same-identity captures are mapped into the first capture's basis and width.
 * One nonzero-fill path per stroke applies opacity exactly once at overlaps. */
export function buildInkPreviews(page: Page, options: InkPreviewOptions = {}): InkPreviews {
  const validated = validatePage(page, page.url);
  const offset = integer(options.groupOffset, 0, 0, LIMITS.strokes);
  const limit = integer(options.groupLimit, 20, 1, 100);
  const maxWidth = integer(options.maxWidth, 1400, 1, 1400);
  const maxHeight = integer(options.maxHeight, 1800, 1, 1800);
  const groups = new Map<string, { strokes: Array<{ stroke: Stroke; matrix: Matrix }>; basis: Matrix; width: number }>();
  for (const stroke of validated.strokes) {
    const a = stroke.anchor;
    let key = 'page-plane', basis = identity, width = page.layoutWidth;
    if (a) {
      if (a.kind === 'render-v1') throw new Error('Projected ink is not a raw preview');
      if (['content-v1', 'content-segment-v1', 'surface-v1'].includes(a.kind)) {
        if (!isContentAnchor(a) && !isSurfaceAnchor(a)) throw new Error('Unsupported capture geometry');
        const { basis: _basis, width: _width, ...anchorIdentity } = a;
        key = stable(anchorIdentity); basis = a.basis; width = a.width;
      } else if (a.kind === 'page-v1') {
        if (!isPageAnchor(a)) throw new Error('Unsupported page capture geometry');
      } else {
        // Opaque anchors remain distinct raw coordinate planes; never infer their geometry.
        key = `opaque:${stable(a)}`;
      }
    }
    let group = groups.get(key);
    if (!group) { group = { strokes: [], basis, width }; groups.set(key, group); }
    const scale = group.width / width;
    const matrix = multiply(multiply(group.basis, [scale, 0, 0, scale, 0, 0]), inverse(basis));
    if (!validFrame({ matrix, clips: [] })) throw new Error('Preview transform exceeds render budget');
    group.strokes.push({ stroke, matrix });
  }
  const selected = [...groups.values()].slice(offset, offset + limit);
  let bytes = 0;
  const previews = selected.map((group, index): InkPreviewGroup => {
    const bounds: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const { stroke, matrix } of group.strokes) {
      const b = visibleBounds(stroke, { matrix, clips: [] });
      if (!b || !Object.values(b).every(n => Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate * 16)) throw new Error('Preview bounds exceed render budget');
      bounds.left = Math.min(bounds.left, b.left); bounds.top = Math.min(bounds.top, b.top);
      bounds.right = Math.max(bounds.right, b.right); bounds.bottom = Math.max(bounds.bottom, b.bottom);
    }
    const width = bounds.right - bounds.left + 16, height = bounds.bottom - bounds.top + 16;
    if (width > LIMITS.coordinate * 2 || height > LIMITS.coordinate * 2) throw new Error('Preview extent exceeds render budget');
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const outputWidth = Math.max(1, Math.ceil(width * scale)), outputHeight = Math.max(1, Math.ceil(height * scale));
    const paths = group.strokes.map(({ stroke, matrix }) => {
      const markup = `<path d="${path(stroke)}" transform="matrix(${matrix.map(number).join(' ')})" fill="${stroke.color}" fill-rule="nonzero" opacity="${number(stroke.opacity)}"/>`;
      bytes += new TextEncoder().encode(markup).byteLength;
      if (bytes > MAX_SVG_BYTES) throw new Error('Preview SVG exceeds render budget; use smaller group pages or JSON');
      return markup;
    });
    return { id: `group-${offset + index}`, strokeIds: group.strokes.map(s => s.stroke.id), width: outputWidth, height: outputHeight, unlocated: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="${number(bounds.left - 8)} ${number(bounds.top - 8)} ${number(width)} ${number(height)}"><rect x="${number(bounds.left - 8)}" y="${number(bounds.top - 8)}" width="${number(width)}" height="${number(height)}" fill="#ffffff"/>${paths.join('')}</svg>` };
  });
  return { groups: previews, totalGroups: groups.size, nextGroupOffset: offset + previews.length < groups.size ? offset + previews.length : null };
}
