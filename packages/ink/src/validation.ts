import type { Anchor, Configuration, Page, Point, Stroke } from './types.ts';

/** Reject over-budget data atomically; never truncate persisted ink. */
export const LIMITS = Object.freeze({
  strokes: 5_000,
  pointsPerStroke: 20_000,
  totalPoints: 100_000,
  coordinate: 1_000_000,
  width: 256,
  pageBytes: 8 * 1024 * 1024,
  anchorBytes: 8192,
  historyActions: 100,
  historyPoints: 400_000,
  urlLength: 8192,
  titleLength: 1024,
});

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
export function finite(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function text(value: unknown, max: number, label: string, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}
export function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) throw new Error('Color must be #rrggbb');
  return value.toLowerCase();
}
export function pageUrl(value: unknown): string {
  const url = text(value, LIMITS.urlLength, 'page URL', 1);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) pages support ink');
  return url;
}
export function validatePoint(value: unknown): Point {
  const p = record(value, 'point');
  return {
    x: finite(p.x, -LIMITS.coordinate, LIMITS.coordinate, 'point x'),
    y: finite(p.y, -LIMITS.coordinate, LIMITS.coordinate, 'point y'),
    p: finite(p.p, 0, 1, 'point pressure'),
  };
}

/** Preserve opaque JSON metadata without accepting cycles, accessors or huge nested objects. */
function cloneAnchor(value: unknown): Anchor {
  const source = record(value, 'anchor');
  text(source.kind, 128, 'anchor kind', 1);
  let nodes = 0;
  const seen = new Set<object>();
  const clone = (v: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 8) throw new Error('Anchor exceeds complexity limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') return text(v, LIMITS.anchorBytes, 'anchor string');
    if (typeof v !== 'object' || !v || seen.has(v)) throw new Error('Anchor must be finite JSON');
    seen.add(v);
    let result: unknown;
    if (Array.isArray(v)) {
      if (v.length > 2048) throw new Error('Anchor array too large');
      result = v.map(item => clone(item, depth + 1));
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== null && proto !== Object.prototype) throw new Error('Anchor must contain plain objects');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      const out: Record<string, unknown> = Object.create(null);
      const keys = Object.keys(descriptors);
      if (keys.length > 2048) throw new Error('Anchor object too large');
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) continue;
        if (!('value' in descriptor)) throw new Error('Anchor accessors are unsupported');
        text(key, 256, 'anchor key');
        out[key] = clone(descriptor.value, depth + 1);
      }
      result = out;
    }
    seen.delete(v);
    return result;
  };
  const result = clone(source, 0) as Anchor;
  if (encodedBytes(result) > LIMITS.anchorBytes) throw new Error('Anchor exceeds storage limit');
  return result;
}
export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function timestamp(value: unknown, label: string): number {
  const result = finite(value, 0, Number.MAX_SAFE_INTEGER, label);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${label}`);
  return result;
}
export function validateStroke(value: unknown): Stroke {
  const s = record(value, 'stroke');
  if (s.brush !== undefined && s.brush !== 'pressure-v1') throw new Error('Unsupported stroke brush');
  if (s.tool !== 'pen' && s.tool !== 'highlighter') throw new Error('Invalid stroke tool');
  if (!Array.isArray(s.points) || !s.points.length || s.points.length > LIMITS.pointsPerStroke) {
    throw new Error('Stroke point count exceeds limits');
  }
  const createdAt = s.createdAt === undefined ? undefined : timestamp(s.createdAt, 'stroke createdAt');
  const updatedAt = s.updatedAt === undefined ? undefined : timestamp(s.updatedAt, 'stroke updatedAt');
  if (createdAt !== undefined && updatedAt !== undefined && createdAt > updatedAt) throw new Error('Invalid stroke timestamp order');
  return {
    ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(s.brush === undefined ? {} : { brush: 'pressure-v1' }),
    id: text(s.id, 128, 'stroke id', 1),
    tool: s.tool,
    color: color(s.color),
    width: finite(s.width, 0.1, LIMITS.width, 'stroke width'),
    opacity: finite(s.opacity, 0, 1, 'stroke opacity'),
    points: s.points.map(validatePoint),
    ...(s.anchor === undefined ? {} : { anchor: cloneAnchor(s.anchor) }),
  };
}
export function validatePage(value: unknown, expectedUrl: string): Page {
  const p = record(value, 'page');
  if (p.version !== 1) throw new Error('Unsupported ink version');
  const url = pageUrl(p.url);
  if (url !== expectedUrl) throw new Error('Restore URL does not match current page');
  if (!Array.isArray(p.strokes) || p.strokes.length > LIMITS.strokes) throw new Error('Too many strokes');
  let count = 0;
  const ids = new Set<string>();
  const strokes = p.strokes.map(value => {
    const raw = record(value, 'stroke');
    if (!Array.isArray(raw.points) || (count += raw.points.length) > LIMITS.totalPoints) {
      throw new Error('Page point count exceeds limit');
    }
    const stroke = validateStroke(raw);
    if (ids.has(stroke.id)) throw new Error('Duplicate stroke id');
    ids.add(stroke.id);
    return stroke;
  });
  const page: Page = {
    version: 1,
    url,
    title: text(p.title, LIMITS.titleLength, 'page title'),
    updatedAt: finite(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'updatedAt'),
    layoutWidth: finite(p.layoutWidth, 1, LIMITS.coordinate, 'layout width'),
    strokes,
  };
  if (encodedBytes(page) > LIMITS.pageBytes) throw new Error('Page exceeds storage limit');
  return page;
}
export function validateConfiguration(value: unknown): Configuration {
  const c = record(value, 'configuration');
  const next: Configuration = {};
  if (c.tool !== undefined) {
    if (!['pen', 'highlighter', 'eraser'].includes(c.tool as string)) throw new Error('Invalid tool');
    next.tool = c.tool as Configuration['tool'];
  }
  if (c.color !== undefined) next.color = color(c.color);
  if (c.width !== undefined) next.width = finite(c.width, 0.1, LIMITS.width, 'tool width');
  if (c.enabled !== undefined) {
    if (typeof c.enabled !== 'boolean') throw new Error('Invalid enabled flag');
    next.enabled = c.enabled;
  }
  if (c.attachmentMode !== undefined) {
    if (c.attachmentMode !== 'smart' && c.attachmentMode !== 'legacy') throw new Error('Invalid attachment mode');
    next.attachmentMode = c.attachmentMode;
  }
  return next;
}
