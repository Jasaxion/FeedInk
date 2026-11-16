export interface Point { x: number; y: number; p: number }
export type StrokeTool = 'pen' | 'highlighter';
export type Tool = StrokeTool | 'eraser';
export interface Anchor { kind: string; [key: string]: unknown }
export interface Stroke {
  id: string;
  createdAt?: number;
  updatedAt?: number;
  brush?: string;
  tool: StrokeTool;
  color: string;
  width: number;
  opacity: number;
  points: Point[];
  anchor?: Anchor;
}
export interface Page {
  version: 1;
  url: string;
  title: string;
  updatedAt: number;
  layoutWidth: number;
  strokes: Stroke[];
}
export type AttachmentMode = 'smart' | 'legacy';
export interface Configuration { tool?: Tool; color?: string; width?: number; enabled?: boolean; attachmentMode?: AttachmentMode }
export interface NativePointer {
  type: 'down' | 'move' | 'up' | 'cancel';
  id: number;
  x: number;
  y: number;
  pressure: number;
  eraser?: boolean;
}
export interface NativeSample extends NativePointer { time: number }
export interface NativePointerBatch { version: 1; epoch: number; basis: number; gesture: number; sequence: number; samples: NativeSample[] }
export interface NativeSessionOptions { renderer: 'native' | 'browser'; presentation?: 1 }
/** Runtime-only point-free geometry, indexed in immutable scene paint order. */
export interface NativeMotion {
  type: 'frame-motion'; version: 1; epoch: number; scene: number; sequence: number; basis: number;
  viewport: { left: number; top: number; width: number; height: number };
  placements: Array<{ kind: 'render-v1'; matrix: number[]; clips: number[][] } | null>;
}
export interface NativeCompletion { gesture: number; sequence: number; accepted: boolean }
export interface NativeRenderFrame {
  version: 1;
  epoch: number;
  basis: number;
  revision: number;
  viewport: { left: number; top: number; width: number; height: number };
  page: Page;
  completions: NativeCompletion[];
  /** Present only after explicit presentation:1 negotiation. Geometry covers all scene strokes. */
  motion?: NativeMotion;
}
export interface Metrics {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
}
export type HostMessage =
  | { type: 'ready'; url: string }
  | { type: 'save'; url: string; page: Page }
  | { type: 'state'; undo: boolean; redo: boolean }
  | { type: 'native-state'; epoch: number; basis: number; enabled: boolean; tool: Tool; color: string; width: number; opacity: number; viewportWidth: number; viewportHeight: number }
  | { type: 'frame-ready'; epoch: number; basis: number; revision: number; completed: number; retained?: true }
  | NativeMotion
  | { type: 'frame-invalidated'; epoch: number; floor: number }
  | { type: 'presented'; epoch: number; gesture: number; sequence: number; accepted: boolean }
  | { type: 'error'; message: string };
export interface ExportPlacement {
  id: string;
  /** Identity of the immutable raw stroke object, never a placement proof. */
  revision: number;
  status: 'placed' | 'pending' | 'unlocated' | 'excluded';
  reason: 'current' | 'clipped' | 'unresolved' | 'page-plane' | 'outside-reader' | 'other-article' | 'projection';
  frame?: { kind: 'render-v1'; matrix: number[]; clips: number[][] };
}
export interface ExportSnapshot {
  page: Page; unresolved: number; hidden: number;
  inventory?: Page;
  placement: { version: 1; entries: ExportPlacement[] };
}
export interface ExportSnapshotOptions {
  /** Existing callers retain strict projection validation. Android opts in explicitly. */
  policy?: 'strict' | 'best-effort';
  /** Runtime manifest/frame deltas only; the host captures raw inventory once. */
  manifestOnly?: boolean;
  includeInventory?: boolean;
  readingRoot?: Element;
  /** Runtime-only canonical capture projection in document CSS pixels. */
  offsetFor?: (target: Element) => { x: number; y: number };
}
export interface WebInkAPI {
  boot(options?: { nativeInput: boolean }): void;
  restore(page: Page | null): void;
  /** Live native mode: next-frame revision floor, including for {}; otherwise no usable floor. */
  configure(options: Configuration): number | undefined;
  /** Re-resolve host layout without changing tools, browser contacts or saved strokes. */
  refreshLayout(): void;
  undo(): void;
  redo(): void;
  flush(): boolean;
  nativePointer(event: NativePointer): void;
  nativeSession(epoch: number, options?: NativeSessionOptions): boolean;
  /** Input receipt only, never a commit, frame-application or durable-save acknowledgment. */
  nativePointers(batch: NativePointerBatch): boolean;
  nativeRenderFrame(): NativeRenderFrame | null;
  ackNativeRenderFrame(epoch: number, revision: number): void;
  snapshot(): Page;
  exportSnapshot(options?: ExportSnapshotOptions): ExportSnapshot;
  metrics(): Metrics;
  setExporting(exporting: boolean): void;
  destroy(): void;
}

declare global {
  interface Window {
    WebInk?: WebInkAPI;
    WebInkHost?: { postMessage(message: string): void };
  }
}
