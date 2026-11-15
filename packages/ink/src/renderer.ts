import { appendStrokePath, intersects, strokeBounds, type Bounds } from './geometry.ts';
import { supportedBrush, legacyResolver, visibleBounds, type FrameResolver, type RenderFrame } from './frames.ts';
import { engineWork } from './work.ts';
import type { Stroke } from './types.ts';
import type { Viewport } from './viewport.ts';

interface Geometry { bounds: Bounds; path?: Path2D; points: number }
export class StrokeRenderer {
  private cache = new WeakMap<Stroke, Geometry>();
  clear(): void { this.cache = new WeakMap(); }
  bounds(stroke: Stroke): Bounds { return this.geometry(stroke).bounds; }
  private geometry(stroke: Stroke): Geometry {
    let geometry = this.cache.get(stroke);
    if (!geometry) { geometry = { bounds: strokeBounds(stroke), points: 0 }; this.cache.set(stroke, geometry); }
    return geometry;
  }
  paint(context: CanvasRenderingContext2D, strokes: readonly Stroke[], viewport: Viewport,
    erased?: ReadonlySet<string>, preview?: Stroke | null, resolve: FrameResolver = legacyResolver): ReadonlySet<string> {
    const painted = new Set<string>();
    const visible = { left: viewport.pageLeft, top: viewport.pageTop,
      right: viewport.pageLeft + viewport.width, bottom: viewport.pageTop + viewport.height };
    context.save();
    try {
      context.translate(-viewport.pageLeft, -viewport.pageTop);
      if (strokes.length) engineWork.committedPaints++;
      for (const stroke of strokes) {
        if (!supportedBrush(stroke) || erased?.has(stroke.id)) continue;
        const resolved = resolve(stroke);
        if (resolved.status !== 'visible') continue;
        const bounds = visibleBounds(stroke, resolved.frame);
        if (!bounds || !intersects(bounds, visible)) continue;
        const geometry = this.geometry(stroke);
        if (!geometry.path) geometry.path = new Path2D();
        appendStrokePath(geometry.path, stroke, geometry.points); geometry.points = stroke.points.length;
        this.fill(context, stroke, geometry.path, resolved.frame);
        painted.add(stroke.id);
      }
      if (preview && supportedBrush(preview)) {
        const resolved = resolve(preview);
        if (resolved.status === 'visible') {
          engineWork.activePaints++;
          const geometry = this.geometry(preview);
          if (!geometry.path) geometry.path = new Path2D();
          appendStrokePath(geometry.path, preview, geometry.points); geometry.points = preview.points.length;
          this.fill(context, preview, geometry.path, resolved.frame);
        }
      }
    } finally { context.restore(); }
    return painted;
  }
  private fill(context: CanvasRenderingContext2D, stroke: Stroke, path: Path2D, frame: RenderFrame): void {
    context.save();
    try {
      for (const clip of frame.clips) {
        context.beginPath(); context.moveTo(clip[0], clip[1]);
        for (let i = 2; i < 8; i += 2) context.lineTo(clip[i], clip[i + 1]);
        context.closePath(); context.clip();
      }
      context.transform(...frame.matrix);
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = stroke.opacity;
      context.fillStyle = stroke.color;
      context.fill(path, 'nonzero');
    } finally { context.restore(); }
  }
}
