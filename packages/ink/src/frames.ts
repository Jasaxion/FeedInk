import { connectingQuad, diameter, intersects, pointSegmentDistance, segmentDistance, strokeBounds, sweepHitsStroke, type Bounds, type XY } from './geometry.ts';
import type { Stroke } from './types.ts';
import { LIMITS } from './validation.ts';

/** Canvas2D convention: saved plane -> CSS document coordinates. No viewport clip. */
export type Matrix = [number, number, number, number, number, number];
export type Clip = [number, number, number, number, number, number, number, number];
export interface RenderFrame { matrix: Matrix; clips: Clip[] }
export type FrameResolution = { status: 'visible'; frame: RenderFrame } | { status: 'hidden' } | { status: 'unresolved' };
export type FrameResolver = (stroke: Stroke) => FrameResolution;
export const identityFrame = (): RenderFrame => ({ matrix: [1, 0, 0, 1, 0, 0], clips: [] });
export const supportedBrush = (stroke: Stroke): boolean => stroke.brush === undefined || stroke.brush === 'pressure-v1';
export const legacyResolver: FrameResolver = stroke => supportedBrush(stroke) ? { status: 'visible', frame: identityFrame() } : { status: 'unresolved' };
export function transformPoint(m: Matrix, p: XY): XY {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function inverse(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) throw new Error('Singular anchor basis');
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export function validFrame(frame: RenderFrame): boolean {
  return frame.matrix.length === 6 && frame.matrix.slice(0, 4).every(n => Math.abs(n) <= 10_000) && frame.clips.length <= 16 &&
    [...frame.matrix, ...frame.clips.flat()].every(n => Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate) &&
    Math.abs(frame.matrix[0] * frame.matrix[3] - frame.matrix[1] * frame.matrix[2]) > 1e-12 &&
    frame.clips.every(clip => clip.length === 8 && polygon(clip).every((p, i, points) => cross(p, points[(i + 1) % 4], points[(i + 2) % 4]) > 0));
}
export function polygon(clip: Clip): XY[] {
  return [0, 2, 4, 6].map(i => ({ x: clip[i], y: clip[i + 1] }));
}
const cross = (a: XY, b: XY, p: XY): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
export function clipPolygon(subject: XY[], clip: XY[]): XY[] {
  for (let j = 0; j < clip.length && subject.length; j++) {
    const a = clip[j], b = clip[(j + 1) % clip.length], output: XY[] = [];
    for (let i = 0; i < subject.length; i++) {
      const p = subject[i], q = subject[(i + 1) % subject.length], dp = cross(a, b, p), dq = cross(a, b, q);
      if (dp >= 0) output.push(p);
      if ((dp < 0) !== (dq < 0)) {
        const t = dp / (dp - dq);
        output.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    subject = output;
  }
  return subject;
}
function boundsOf(points: XY[]): Bounds {
  const result: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const p of points) {
    result.left = Math.min(result.left, p.x); result.right = Math.max(result.right, p.x);
    result.top = Math.min(result.top, p.y); result.bottom = Math.max(result.bottom, p.y);
  }
  return result;
}
function corners(b: Bounds): XY[] {
  return [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }];
}
function clipped(points: XY[], clips: Clip[]): XY[] {
  for (const clip of clips) points = clipPolygon(points, polygon(clip));
  return points;
}
function contains(p: XY, points: XY[]): boolean {
  return points.length >= 3 && points.every((a, i) => cross(a, points[(i + 1) % points.length], p) >= -1e-9);
}
function transformedBounds(stroke: Stroke, frame: RenderFrame): Bounds {
  return boundsOf(corners(strokeBounds(stroke)).map(p => transformPoint(frame.matrix, p)));
}
/** Inscribed circle tessellation is only used for clipped/anisotropic hit tests.
 * It cannot hit hidden ink; maximum radial under-hit is 0.02 document CSS px
 * at ordinary scales (256 vertices cap for hostile/extreme transforms).
 * Painting/export always retain the exact original circle path. */
function* eraserPrimitives(stroke: Stroke, frame: RenderFrame, query?: Bounds): Generator<XY[]> {
  const m = frame.matrix;
  const scale = Math.hypot(m[0], m[1], m[2], m[3]);
  const reflected = m[0] * m[3] - m[1] * m[2] < 0;
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i], r = diameter(stroke, p.p) / 2, center = transformPoint(m, p);
    const rx = r * Math.hypot(m[0], m[2]), ry = r * Math.hypot(m[1], m[3]);
    const box = { left: center.x - rx, right: center.x + rx, top: center.y - ry, bottom: center.y + ry };
    if ((!query || intersects(box, query)) && clipped(corners(box), frame.clips).length) {
      const count = Math.max(16, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.02 / Math.max(r * scale, 0.02))))));
      const points = Array.from({ length: count }, (_, j) => transformPoint(m,
        { x: p.x + r * Math.cos(j * 2 * Math.PI / count), y: p.y + r * Math.sin(j * 2 * Math.PI / count) }));
      yield clipped(reflected ? points.reverse() : points, frame.clips);
    }
    if (!i) continue;
    const previous = stroke.points[i - 1], quad = connectingQuad(previous, p, diameter(stroke, previous.p) / 2, r);
    if (quad) {
      const points = quad.map(p => transformPoint(m, p));
      if (!query || intersects(boundsOf(points), query)) yield clipped(reflected ? points.reverse() : points, frame.clips);
    }
  }
}
/** Visibility must not inherit the eraser's allowed inscribed under-hit. Map the
 * clipped ellipse bounds back to the raw circle plane and test exact distances.
 * Bounds remain conservative; even a subpixel circular cap reaches paint/export. */
function hasVisiblePrimitive(stroke: Stroke, frame: RenderFrame): boolean {
  const m = frame.matrix, inv = inverse(m), reflected = m[0] * m[3] - m[1] * m[2] < 0;
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i], r = diameter(stroke, p.p) / 2, center = transformPoint(m, p);
    const rx = r * Math.hypot(m[0], m[2]), ry = r * Math.hypot(m[1], m[3]);
    const region = clipped(corners({ left: center.x - rx, right: center.x + rx, top: center.y - ry, bottom: center.y + ry }), frame.clips)
      .map(point => transformPoint(inv, point));
    if (reflected) region.reverse();
    if (region.length >= 3 && (contains(p, region) || region.some((point, j) =>
      pointSegmentDistance(p, point, region[(j + 1) % region.length]) <= r + 1e-9))) return true;
    if (!i) continue;
    const previous = stroke.points[i - 1], quad = connectingQuad(previous, p, diameter(stroke, previous.p) / 2, r);
    if (quad && clipped(quad.map(point => transformPoint(m, point)), frame.clips).length >= 3) return true;
  }
  return false;
}
const visibilityCache = new WeakMap<Stroke, { frame: RenderFrame; points: number; bounds: Bounds | null }>();
export function visibleBounds(stroke: Stroke, frame: RenderFrame): Bounds | null {
  const cached = Object.isFrozen(stroke) ? visibilityCache.get(stroke) : undefined;
  if (cached?.frame === frame && cached.points === stroke.points.length) return cached.bounds;
  const bounds = calculateVisibleBounds(stroke, frame);
  if (Object.isFrozen(stroke)) visibilityCache.set(stroke, { frame, points: stroke.points.length, bounds });
  return bounds;
}
function calculateVisibleBounds(stroke: Stroke, frame: RenderFrame): Bounds | null {
  const bounds = transformedBounds(stroke, frame);
  if (!frame.clips.length || frame.clips.every(clip => corners(bounds).every(p => contains(p, polygon(clip))))) return bounds;
  const intersection = clipped(corners(bounds), frame.clips);
  if (!intersection.length) return null;
  // Conservative analytic bounds avoid cutting off subpixel circle edges in PDF metrics.
  return hasVisiblePrimitive(stroke, frame) ? boundsOf(intersection) : null;
}
export function sweepHitsFrame(stroke: Stroke, frame: RenderFrame, a: XY, b: XY, radius: number): boolean {
  if (!supportedBrush(stroke)) return false;
  const bounds = visibleBounds(stroke, frame);
  const query = { left: Math.min(a.x, b.x) - radius, right: Math.max(a.x, b.x) + radius,
    top: Math.min(a.y, b.y) - radius, bottom: Math.max(a.y, b.y) + radius };
  if (!bounds || !intersects(bounds, query)) return false;
  const m = frame.matrix;
  // Keep the exact legacy circle/quad collision for unclipped similarity transforms.
  if (!frame.clips.length && m[1] === 0 && m[2] === 0 && m[0] === m[3] && m[0] > 0) {
    const inv = inverse(m);
    return sweepHitsStroke(stroke, transformPoint(inv, a), transformPoint(inv, b), radius / m[0]);
  }
  for (const shape of eraserPrimitives(stroke, frame, query)) {
    if (shape.length < 3) continue;
    if (contains(a, shape) || contains(b, shape) || shape.some((p, i) =>
      pointSegmentDistance(p, a, b) <= radius || segmentDistance(a, b, p, shape[(i + 1) % shape.length]) <= radius)) return true;
  }
  return false;
}
