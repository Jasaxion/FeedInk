import { appendStrokePoint } from './geometry.ts';
import { InkDocument } from './document.ts';
import { legacyResolver, sweepHitsFrame, type FrameResolver } from './frames.ts';
import type { Anchor, Point, Stroke, Tool } from './types.ts';
import { LIMITS, validatePoint } from './validation.ts';

export interface DrawingConfiguration { tool: Tool; color: string; width: number; enabled: boolean }
export interface GestureAnchoring {
  create(point: Point): Anchor | undefined;
  captureEraserOrigin?(point: Point): () => boolean;
  point(stroke: Stroke, point: Point): Point;
  resolve: FrameResolver;
}
interface Gesture { id: number; last: Point; stroke: Stroke | null; erased: Set<string>; erasedFrames: Map<Stroke, string>; eraserOrigin?: () => boolean; radius: number }
let sequence = 0;

/** One contact is one undoable action, including an eraser sweep across many strokes. */
export class GestureController {
  private active: Gesture | null = null;
  private readonly document: InkDocument;
  private readonly anchoring?: GestureAnchoring;
  constructor(document: InkDocument, anchoring?: GestureAnchoring) { this.document = document; this.anchoring = anchoring; }
  get pointerId(): number | null { return this.active?.id ?? null; }
  get preview(): Stroke | null { return this.active?.stroke ?? null; }
  get erasedIds(): ReadonlySet<string> | undefined { return this.active?.erased; }

  begin(id: number, point: Point, configuration: DrawingConfiguration): void {
    this.cancel();
    const p = validatePoint(point);
    const { tool, width, color } = configuration;
    const createdAt = Date.now();
    const stroke: Stroke | null = tool === 'eraser' ? null : {
      id: `ink-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt, updatedAt: createdAt, brush: 'pressure-v1',
      tool, width, color, opacity: tool === 'highlighter' ? 0.35 : 1, points: [p],
    };
    if (stroke && (this.document.totalPoints >= LIMITS.totalPoints || this.document.strokes.length >= LIMITS.strokes)) {
      throw new Error('Ink capacity reached');
    }
    if (stroke && this.anchoring) {
      const anchor = this.anchoring.create(p);
      if (anchor) stroke.anchor = anchor;
    }
    this.active = { id, last: p, stroke, erased: new Set(), erasedFrames: new Map(),
      eraserOrigin: stroke ? undefined : this.anchoring?.captureEraserOrigin?.(p), radius: width / 2 };
    if (!stroke) this.erase(p, p);
  }
  move(id: number, point: Point): void {
    const gesture = this.active;
    if (!gesture || gesture.id !== id) return;
    const p = validatePoint(gesture.stroke && this.anchoring ? this.anchoring.point(gesture.stroke, point) : point);
    if (gesture.stroke) {
      const points = gesture.stroke.points;
      if (p.x === gesture.last.x && p.y === gesture.last.y && p.p === gesture.last.p) return;
      if (points.length >= LIMITS.pointsPerStroke || this.document.totalPoints + points.length >= LIMITS.totalPoints) {
        this.cancel();
        throw new Error('Gesture exceeds point capacity; partial stroke discarded');
      }
      appendStrokePoint(gesture.stroke, p);
    } else this.erase(gesture.last, p);
    gesture.last = p;
  }
  end(id: number, point: Point): boolean {
    if (this.active?.id !== id) return false;
    this.revalidateErasure();
    // A physical pen-up reports zero pressure, not an intentional zero-width tail.
    const final = point.p === 0 ? { ...point, p: this.active.last.p } : point;
    this.move(id, final);
    const gesture = this.active;
    this.active = null;
    if (!gesture) return false;
    if (gesture.stroke) { this.document.add(gesture.stroke); return true; }
    return this.document.erase(gesture.erased);
  }
  /** Pending erasures are transactions against the frames actually hit, not
   * permission to delete the same IDs after their content has disappeared. */
  revalidateErasure(): void {
    if (this.active?.eraserOrigin && !this.active.eraserOrigin()) {
      this.cancel();
      throw new Error('[anchor-unresolved] Eraser target changed; partial erasure discarded');
    }
    for (const [stroke, frame] of this.active?.erasedFrames ?? []) {
      const resolved = (this.anchoring?.resolve ?? legacyResolver)(stroke);
      if (resolved.status !== 'visible' || JSON.stringify(resolved.frame) !== frame) {
        this.cancel();
        throw new Error('[anchor-unresolved] Eraser target changed; partial erasure discarded');
      }
    }
  }
  cancel(): void { this.active = null; }
  private erase(a: Point, b: Point): void {
    const gesture = this.active!;
    for (const stroke of this.document.strokes) {
      if (gesture.erased.has(stroke.id)) continue;
      const resolved = (this.anchoring?.resolve ?? legacyResolver)(stroke);
      if (resolved.status === 'visible' && sweepHitsFrame(stroke, resolved.frame, a, b, gesture.radius)) {
        gesture.erased.add(stroke.id);
        gesture.erasedFrames.set(stroke, JSON.stringify(resolved.frame));
      }
    }
  }
}
