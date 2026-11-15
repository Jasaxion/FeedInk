import type { Point } from './types.ts';
import { finite, LIMITS } from './validation.ts';

export interface Viewport {
  pageLeft: number;
  pageTop: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  scale: number;
}
export function readViewport(win: Window): Viewport {
  const v = win.visualViewport;
  return {
    pageLeft: v?.pageLeft ?? win.scrollX,
    pageTop: v?.pageTop ?? win.scrollY,
    offsetLeft: v?.offsetLeft ?? 0,
    offsetTop: v?.offsetTop ?? 0,
    width: Math.max(1, v?.width ?? win.innerWidth),
    height: Math.max(1, v?.height ?? win.innerHeight),
    scale: v?.scale ?? 1,
  };
}
export function normalizedPoint(x: unknown, y: unknown, pressure: unknown, viewport: Viewport): Point {
  const nx = finite(x, 0, 1, 'normalized pointer x');
  const ny = finite(y, 0, 1, 'normalized pointer y');
  return {
    x: finite(viewport.pageLeft + nx * viewport.width, -LIMITS.coordinate, LIMITS.coordinate, 'document x'),
    y: finite(viewport.pageTop + ny * viewport.height, -LIMITS.coordinate, LIMITS.coordinate, 'document y'),
    p: finite(pressure, 0, 1, 'pointer pressure'),
  };
}
/** Browser client coordinates are layout-viewport CSS px, not normalized screen pixels. */
export function clientPoint(x: number, y: number, pressure: number, viewport: Viewport): Point {
  return {
    x: finite(x + viewport.pageLeft - viewport.offsetLeft, -LIMITS.coordinate, LIMITS.coordinate, 'document x'),
    y: finite(y + viewport.pageTop - viewport.offsetTop, -LIMITS.coordinate, LIMITS.coordinate, 'document y'),
    p: finite(pressure, 0, 1, 'pointer pressure'),
  };
}
export const CANVAS_LIMITS = Object.freeze({ dpr: 3, side: 4096, pixels: 8_000_000 });
export function canvasSize(width: number, height: number, dpr: number): { width: number; height: number } {
  const ratio = Math.min(Math.max(0.1, dpr), CANVAS_LIMITS.dpr, CANVAS_LIMITS.side / width,
    CANVAS_LIMITS.side / height, Math.sqrt(CANVAS_LIMITS.pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}
