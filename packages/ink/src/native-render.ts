import { identityFrame, supportedBrush, transformPoint, validFrame, visibleBounds, type Clip, type FrameResolver, type Matrix } from './frames.ts';
import { nativeInteger, NATIVE_LIMITS } from './native.ts';
import type { NativeCompletion, NativeMotion, NativeRenderFrame, Page, Stroke } from './types.ts';
import { finite, LIMITS, validatePage } from './validation.ts';
import type { Viewport } from './viewport.ts';

export const NATIVE_FRAME_BYTES = LIMITS.pageBytes + 16 * 1024;
export const NATIVE_MOTION_BYTES = 2 * 1024 * 1024;

const rawPointCorners = new WeakMap<Stroke, ReadonlyArray<{ x: number; y: number }>>();
/** Committed document strokes are deeply immutable. Mutable helper inputs must not leave
 * stale bounds in the cache; restored/replaced strokes naturally get a new weak key. */
function nativeRawPointCorners(stroke: Stroke): ReadonlyArray<{ x: number; y: number }> {
  const cached = rawPointCorners.get(stroke);
  if (cached) return cached;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let immutable = Object.isFrozen(stroke) && Object.isFrozen(stroke.points);
  for (const point of stroke.points) {
    const { x, y } = point;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    immutable = immutable && Object.isFrozen(point);
  }
  const corners = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  if (immutable) rawPointCorners.set(stroke, corners);
  return corners;
}

/** Enclose float multiply/add rounding (including fused operations). Android projects
 * float points with float coefficients, so validating only the JS double result can
 * still admit a placement outside its domain. Conservative rejection uses v1 fallback. */
function validateNativeProjectedSum(aLow: number, aHigh: number, bLow: number, bHigh: number, cLow: number, cHigh: number): void {
  const low = aLow + bLow, high = aHigh + bHigh;
  const finalLow = Math.min(low, Math.fround(low)) + cLow;
  const finalHigh = Math.max(high, Math.fround(high)) + cHigh;
  finite(Math.min(finalLow, Math.fround(finalLow)), -LIMITS.coordinate, LIMITS.coordinate, 'native motion projected coordinate');
  finite(Math.max(finalHigh, Math.fround(finalHigh)), -LIMITS.coordinate, LIMITS.coordinate, 'native motion projected coordinate');
}
function validateNativeProjectedAxis(a: number, x: number, b: number, y: number, translation: number): void {
  const p = a * x, q = b * y;
  const pLow = Math.min(p, Math.fround(p)), pHigh = Math.max(p, Math.fround(p));
  const qLow = Math.min(q, Math.fround(q)), qHigh = Math.max(q, Math.fround(q));
  // Matrix implementations may accumulate translation before either product.
  validateNativeProjectedSum(pLow, pHigh, qLow, qHigh, translation, translation);
  validateNativeProjectedSum(pLow, pHigh, translation, translation, qLow, qHigh);
  validateNativeProjectedSum(qLow, qHigh, translation, translation, pLow, pHigh);
}

function validateNativeProjection(stroke: Stroke, matrix: Matrix): void {
  const m = matrix.map(Math.fround);
  // Match RetainedStroke.validate: bound every raw sample, not brush radii or clipped
  // viewport coverage. The complete immutable geometry can enter on later motion.
  for (const corner of nativeRawPointCorners(stroke)) {
    const projected = transformPoint(matrix, corner);
    finite(projected.x, -LIMITS.coordinate, LIMITS.coordinate, 'native motion projected x');
    finite(projected.y, -LIMITS.coordinate, LIMITS.coordinate, 'native motion projected y');
    const x = Math.fround(corner.x), y = Math.fround(corner.y);
    validateNativeProjectedAxis(m[0], x, m[2], y, m[4]);
    validateNativeProjectedAxis(m[1], x, m[3], y, m[5]);
  }
}

/** Full immutable geometry, including offscreen/clipped strokes. Only placements grant visibility. */
export function nativeScenePage(page: Omit<Page, 'strokes'> & { strokes: readonly Stroke[] }): Page {
  return { ...page, strokes: page.strokes.filter(supportedBrush).map(stroke => ({ ...stroke,
    points: stroke.points.map(point => ({ ...point })), anchor: { kind: 'render-v1', ...identityFrame() } })) };
}

/** Exact current geometry, never extrapolated from earlier scroll deltas. No points on this wire. */
export function nativeMotion(strokes: readonly Stroke[], resolve: FrameResolver, viewport: Viewport,
  epoch: number, scene: number, sequence: number, basis: number, erased?: ReadonlySet<string>): NativeMotion {
  nativeInteger(epoch, 'native motion epoch'); nativeInteger(basis, 'native motion basis');
  if (nativeInteger(scene, 'native motion scene') < 1 || nativeInteger(sequence, 'native motion sequence') < 1) {
    throw new Error('Invalid native motion identity');
  }
  if (strokes.length > LIMITS.strokes) throw new Error('Native motion exceeds stroke capacity');
  const placements = strokes.filter(supportedBrush).map(stroke => {
    if (erased?.has(stroke.id)) return null;
    const resolved = resolve(stroke);
    if (resolved.status !== 'visible') return null;
    if (!validFrame(resolved.frame)) throw new Error('Invalid native motion geometry');
    validateNativeProjection(stroke, resolved.frame.matrix);
    return { kind: 'render-v1' as const, matrix: [...resolved.frame.matrix], clips: resolved.frame.clips.map(clip => [...clip]) };
  });
  const motion: NativeMotion = { type: 'frame-motion', version: 1, epoch, scene, sequence, basis,
    viewport: { left: viewport.pageLeft, top: viewport.pageTop, width: viewport.width, height: viewport.height }, placements };
  if (new TextEncoder().encode(JSON.stringify(motion)).byteLength > NATIVE_MOTION_BYTES) throw new Error('Native motion exceeds capacity');
  return motion;
}
/** Produces a detached, validated presentation page; raw anchors never enter this envelope. */
export function nativeFramePage(page: Omit<Page, 'strokes'> & { strokes: readonly Stroke[] }, viewport: Viewport,
  resolve: FrameResolver, erased?: ReadonlySet<string>): Page {
  const clip: Clip = [viewport.pageLeft, viewport.pageTop, viewport.pageLeft + viewport.width, viewport.pageTop,
    viewport.pageLeft + viewport.width, viewport.pageTop + viewport.height, viewport.pageLeft, viewport.pageTop + viewport.height];
  const strokes = page.strokes.flatMap(stroke => {
    if (erased?.has(stroke.id)) return [];
    const resolved = resolve(stroke);
    if (resolved.status !== 'visible') return [];
    if (!validFrame(resolved.frame)) throw new Error('Invalid native render geometry');
    // A bounding-box intersection alone includes empty corners of diagonal ink.
    if (!visibleBounds(stroke, { matrix: resolved.frame.matrix, clips: [...resolved.frame.clips, clip] })) return [];
    return [{ ...stroke, points: stroke.points.map(point => ({ ...point })), anchor: { kind: 'render-v1',
      matrix: [...resolved.frame.matrix], clips: resolved.frame.clips.map(clip => [...clip]) } }];
  });
  return { ...page, strokes };
}

/** Cache JSON rather than document references. Every read can be safely mutated by callers. */
export function encodeNativeRenderFrame(frame: NativeRenderFrame, expectedUrl: string): string {
  if (frame.version !== 1) throw new Error('Invalid native render version');
  nativeInteger(frame.epoch, 'native frame epoch'); nativeInteger(frame.basis, 'native frame basis');
  if (nativeInteger(frame.revision, 'native frame revision') < 1) throw new Error('Invalid native frame revision');
  const v = frame.viewport;
  finite(v.left, -LIMITS.coordinate, LIMITS.coordinate, 'native viewport left');
  finite(v.top, -LIMITS.coordinate, LIMITS.coordinate, 'native viewport top');
  finite(v.width, Number.MIN_VALUE, LIMITS.coordinate, 'native viewport width');
  finite(v.height, Number.MIN_VALUE, LIMITS.coordinate, 'native viewport height');
  finite(v.left + v.width, -LIMITS.coordinate, LIMITS.coordinate, 'native viewport right');
  finite(v.top + v.height, -LIMITS.coordinate, LIMITS.coordinate, 'native viewport bottom');
  const page = validatePage(frame.page, expectedUrl);
  for (const stroke of page.strokes) {
    const anchor = stroke.anchor;
    if (anchor?.kind !== 'render-v1' || !Array.isArray(anchor.matrix) || !Array.isArray(anchor.clips) ||
      !anchor.clips.every(Array.isArray) || !validFrame({ matrix: anchor.matrix as Matrix, clips: anchor.clips as Clip[] })) {
      throw new Error('Invalid native render anchor');
    }
    // Native validates every replayed point, including offscreen/clipped samples.
    // Valid raw points and matrix coefficients can still exceed the replay budget.
    for (const point of stroke.points) {
      const projected = transformPoint(anchor.matrix as Matrix, point);
      finite(projected.x, -LIMITS.coordinate, LIMITS.coordinate, 'native projected point x');
      finite(projected.y, -LIMITS.coordinate, LIMITS.coordinate, 'native projected point y');
    }
  }
  if (!Array.isArray(frame.completions) || frame.completions.length > NATIVE_LIMITS.pendingPresentations) {
    throw new Error('Native frame completion capacity exceeded');
  }
  const gestures = new Set<number>();
  const completions: NativeCompletion[] = frame.completions.map(completion => {
    const gesture = nativeInteger(completion.gesture, 'native completion gesture');
    const sequence = nativeInteger(completion.sequence, 'native completion sequence');
    if (gestures.has(gesture) || typeof completion.accepted !== 'boolean') throw new Error('Invalid native completion');
    gestures.add(gesture);
    return { gesture, sequence, accepted: completion.accepted };
  });
  const json = JSON.stringify({ version: 1, epoch: frame.epoch, basis: frame.basis, revision: frame.revision,
    viewport: { left: v.left, top: v.top, width: v.width, height: v.height }, page, completions,
    ...(frame.motion ? { motion: frame.motion } : {}) });
  if (new TextEncoder().encode(json).byteLength > NATIVE_FRAME_BYTES) throw new Error('Native render frame exceeds capacity');
  return json;
}
