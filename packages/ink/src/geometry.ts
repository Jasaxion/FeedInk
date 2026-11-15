import type { Point, Stroke } from './types.ts';
import { engineWork } from './work.ts';

export interface Bounds { left: number; top: number; right: number; bottom: number }
export type XY = Pick<Point, 'x' | 'y'>;
export type Quad = [XY, XY, XY, XY];
export const clampPressure = (p: number): number => Math.max(0, Math.min(1, p));

/** Shared native PDF formula. Each stroke is one nonzero fill of circles + quads. */
export function diameter(stroke: Pick<Stroke, 'tool' | 'width'>, p: number): number {
  return stroke.width * (stroke.tool === 'highlighter' ? 1 : 0.25 + 0.75 * clampPressure(p));
}
export function connectingQuad(a: Point, b: Point, ra: number, rb: number): Quad | null {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const nx = dy / length, ny = -dx / length;
  // Clockwise in canvas coordinates, same winding as arc(..., 0, 2*PI, false).
  return [
    { x: a.x + nx * ra, y: a.y + ny * ra },
    { x: b.x + nx * rb, y: b.y + ny * rb },
    { x: b.x - nx * rb, y: b.y - ny * rb },
    { x: a.x - nx * ra, y: a.y - ny * ra },
  ];
}
const boundsCache = new WeakMap<Stroke, Bounds>();
function includePoint(bounds: Bounds, stroke: Stroke, p: Point): void {
  engineWork.boundsPoints++;
  const radius = diameter(stroke, p.p) / 2;
  bounds.left = Math.min(bounds.left, p.x - radius);
  bounds.top = Math.min(bounds.top, p.y - radius);
  bounds.right = Math.max(bounds.right, p.x + radius);
  bounds.bottom = Math.max(bounds.bottom, p.y + radius);
}
/** Active strokes are append-only. All mutations must go through this operation. */
export function appendStrokePoint(stroke: Stroke, point: Point): void {
  const bounds = strokeBounds(stroke);
  stroke.points.push(point);
  includePoint(bounds, stroke, point);
  boundsCache.set(stroke, bounds);
}
export function strokeBounds(stroke: Stroke): Bounds {
  const cached = boundsCache.get(stroke);
  if (cached) return cached;
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const p of stroke.points) includePoint(bounds, stroke, p);
  if (Object.isFrozen(stroke)) boundsCache.set(stroke, bounds);
  return bounds;
}
export function intersects(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const cross = (a: XY, b: XY, p: XY): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
export function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) &&
      ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function insideQuad(p: XY, quad: Quad): boolean {
  return quad.every((v, i) => cross(v, quad[(i + 1) % 4], p) >= 0);
}
/** Hit the rendered geometry, not just stored vertices; fast eraser sweeps cannot tunnel. */
export function sweepHitsStroke(stroke: Stroke, a: XY, b: XY, radius: number, bounds = strokeBounds(stroke)): boolean {
  if (stroke.brush !== undefined && stroke.brush !== 'pressure-v1') return false;
  const sweep = { left: Math.min(a.x, b.x) - radius, right: Math.max(a.x, b.x) + radius,
    top: Math.min(a.y, b.y) - radius, bottom: Math.max(a.y, b.y) + radius };
  if (!intersects(bounds, sweep)) return false;
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i], r = diameter(stroke, p.p) / 2;
    if (pointSegmentDistance(p, a, b) <= radius + r) return true;
    if (i === 0) continue;
    const previous = stroke.points[i - 1];
    const quad = connectingQuad(previous, p, diameter(stroke, previous.p) / 2, r);
    if (quad && (insideQuad(a, quad) || insideQuad(b, quad) ||
      quad.some((v, j) => segmentDistance(a, b, v, quad[(j + 1) % 4]) <= radius))) return true;
  }
  return false;
}

export interface StrokePath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number, counterclockwise?: boolean): void;
  closePath(): void;
}
/** All subpaths have matching winding, so overlaps do not create holes or alpha buildup. */
export function appendStrokePath(path: StrokePath, stroke: Stroke, from = 0): void {
  for (let i = from; i < stroke.points.length; i++) {
    engineWork.pathPoints++;
    const p = stroke.points[i], r = diameter(stroke, p.p) / 2;
    path.moveTo(p.x + r, p.y);
    path.arc(p.x, p.y, r, 0, Math.PI * 2, false);
    path.closePath();
    if (i === 0) continue;
    const previous = stroke.points[i - 1];
    const quad = connectingQuad(previous, p, diameter(stroke, previous.p) / 2, r);
    if (!quad) continue;
    path.moveTo(quad[0].x, quad[0].y);
    for (let j = 1; j < 4; j++) path.lineTo(quad[j].x, quad[j].y);
    path.closePath();
  }
}
