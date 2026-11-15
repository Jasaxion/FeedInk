import { AttachmentRejectedError, ContentAnchorResolver } from './anchors.ts';
import { validFrame, visibleBounds, type RenderFrame } from './frames.ts';
import { InkDocument } from './document.ts';
import { GestureController, type DrawingConfiguration } from './input.ts';
import { nativeInteger, NATIVE_LIMITS, validateNativeBatch } from './native.ts';
import { encodeNativeRenderFrame, nativeFramePage, nativeMotion, nativeScenePage } from './native-render.ts';
import { engineWork } from './work.ts';
import { StrokeRenderer } from './renderer.ts';
import type { Configuration, ExportSnapshot, ExportSnapshotOptions, HostMessage, Metrics, NativePointer, NativePointerBatch, NativeRenderFrame, NativeSessionOptions, Page, Point, WebInkAPI } from './types.ts';
import { finite, LIMITS, pageUrl, record, validateConfiguration } from './validation.ts';
import { canvasSize, clientPoint, normalizedPoint, readViewport, type Viewport } from './viewport.ts';

/** Do not undo another site's later wrappers. Retained wrappers become inert on destroy. */
function observeHistory(history: History, before: () => void, after: () => void): () => void {
  const callbacks: { before?: () => void; after?: () => void } = { before, after };
  const originalPush = history.pushState, originalReplace = history.replaceState;
  function push(this: History, ...args: Parameters<History['pushState']>): void {
    callbacks.before?.(); originalPush.apply(this, args); callbacks.after?.();
  }
  function replace(this: History, ...args: Parameters<History['replaceState']>): void {
    callbacks.before?.(); originalReplace.apply(this, args); callbacks.after?.();
  }
  history.pushState = push;
  history.replaceState = replace;
  return () => {
    delete callbacks.before; delete callbacks.after;
    if (history.pushState === push) history.pushState = originalPush;
    if (history.replaceState === replace) history.replaceState = originalReplace;
  };
}

export class WebInkOverlay implements WebInkAPI {
  private document: InkDocument;
  private gestures: GestureController;
  private renderer = new StrokeRenderer();
  private anchors: ContentAnchorResolver;
  private configuration: DrawingConfiguration = { tool: 'pen', color: '#000000', width: 3, enabled: true };
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private activeCanvas: HTMLCanvasElement;
  private activeContext: CanvasRenderingContext2D;
  private committedDirty = true;
  private activeDirty = true;
  private saveTimer: number | null = null;
  private saveDirty = false;
  private nativeEpoch: number | null = null;
  private nativeSessionEnabled = false;
  private nativeRenderer: 'hybrid' | 'native' | 'browser' = 'hybrid';
  private nativeFrameCache: string | null = null;
  private nativePresentation = false;
  private nativeSceneDirty = true;
  private nativeMotionSequence = 0;
  private nativeSceneViewport = '';
  private nativeRetainedScene = false;
  private nativeRevision = 0;
  private nativeAckRevision = 0;
  private nativeStateRevision = 0;
  private nativeRestoreReady = false;
  private lastNativeEpoch = -1;
  private nativeBasis = 0;
  private nativeStatePending = false;
  private nativeSequence = -1;
  private nativeGesture = -1;
  private nativeTime = -1;
  private nativeViewport: string | null = null;
  private nativeContact: { gesture: number; basis: number; sequence: number; id: number; elements: Element[]; geometry: string; contentAnchored: boolean; frame?: string } | null = null;
  private presentations: Array<{ epoch: number; gesture: number; sequence: number; strokeId?: string; rejected?: boolean; firstRevision?: number }> = [];
  private booted = false;
  private destroyed = false;
  private nativeInput = false;
  private restored = false;
  private exporting = false;
  private frame: number | null = null;
  private routeTimer: number | null = null;
  private mutation: MutationObserver | null = null;
  private resize: ResizeObserver | null = null;
  private observedSizes = new WeakMap<Element, string>();
  private observedRoot: HTMLElement | null = null;
  private observedBody: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private warnings = new Set<string>();
  private lastDimensions: { width: number; height: number } | null = null;
  private browserCapture: { target: Element; id: number } | null = null;

  constructor(private readonly win: Window) {
    this.document = this.emptyDocument();
    this.anchors = new ContentAnchorResolver(win, this.anchorNotice, this.onResizeObserved);
    this.gestures = new GestureController(this.document, this.anchors);
    this.root = win.document.createElement('div');
    this.root.dataset.webinkOverlay = '1';
    this.root.setAttribute('aria-hidden', 'true');
    const properties: Record<string, string> = {
      all: 'initial', position: 'fixed', display: 'block', left: '0', top: '0',
      margin: '0', padding: '0', border: '0', overflow: 'hidden',
      'pointer-events': 'none', 'z-index': '2147483647', contain: 'strict',
      isolation: 'isolate', opacity: '1', visibility: 'visible', transform: 'none',
    };
    for (const [property, value] of Object.entries(properties)) this.root.style.setProperty(property, value, 'important');
    this.canvas = win.document.createElement('canvas');
    this.canvas.style.cssText = 'all:initial;visibility:inherit;display:block;width:100%;height:100%;pointer-events:none';
    const shadow = this.root.attachShadow({ mode: 'open' });
    this.activeCanvas = win.document.createElement('canvas');
    this.activeCanvas.style.cssText = 'all:initial;visibility:inherit;display:block;position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    shadow.append(this.canvas, this.activeCanvas);
    if (typeof this.root.showPopover === 'function') {
      // A nonmodal top-layer overlay escapes transformed/clipping html roots without
      // changing page CSS or making the underlying document inert (unlike a dialog).
      this.root.setAttribute('popover', 'manual');
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(':host::backdrop { display: none !important; pointer-events: none !important; }');
      shadow.adoptedStyleSheets = [sheet];
    }
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;
    const activeContext = this.activeCanvas.getContext('2d');
    if (!activeContext) throw new Error('Canvas 2D is unavailable');
    this.activeContext = activeContext;
  }
  boot(options: { nativeInput: boolean } = { nativeInput: false }): void {
    this.guard(() => {
      if (typeof options?.nativeInput !== 'boolean') throw new Error('Invalid boot options');
      if (this.booted) {
        if (this.nativeInput !== options.nativeInput) {
          this.cancel();
          this.discardPresentations(); this.postNativeState(false); this.nativeEpoch = null;
          this.resetNativeFrames();
          this.nativeInput = options.nativeInput;
          // A browser session switched to native must wait for authoritative storage.
          if (this.nativeInput) this.restored = false;
          else {
            this.restored = true;
            this.nativeRenderer = 'browser';
          }
          this.updateVisibility();
        }
        return;
      }
      this.booted = true;
      this.nativeInput = options.nativeInput;
      this.restored = !this.nativeInput;
      const doc = this.win.document;
      for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        this.listen(this.win, name, this.browserPointer as EventListener, { capture: true, passive: false });
      }
      this.listen(this.win, 'scroll', this.onScroll, { capture: true, passive: true });
      this.listen(this.win, 'resize', this.onViewport);
      this.listen(doc, 'load', this.onGeometry, { capture: true });
      if (doc.fonts) this.listen(doc.fonts, 'loadingdone', this.onGeometry);
      this.listen(this.win, 'blur', this.cancel);
      this.listen(this.win, 'pagehide', this.onPageHide);
      this.listen(this.win, 'pageshow', this.scheduleDraw);
      this.listen(doc, 'visibilitychange', this.onVisibility);
      this.listen(this.win, 'popstate', this.checkRoute);
      this.listen(this.win, 'hashchange', this.checkRoute);
      if (this.win.visualViewport) {
        this.listen(this.win.visualViewport, 'resize', this.onViewport);
        this.listen(this.win.visualViewport, 'scroll', this.onScroll);
      }
      this.cleanup.push(observeHistory(this.win.history, () => this.flush(), this.checkRoute));
      this.mutation = new MutationObserver(records => {
        if (this.destroyed) return;
        const pageChanged = this.pageMutated(records), detached = !this.root.isConnected;
        this.attach();
        if (pageChanged) { this.invalidateContent(); this.warnLayout('content'); }
        if (pageChanged || detached) this.scheduleDraw();
      });
      this.mutation.observe(doc, { childList: true, subtree: true, characterData: true, attributes: true });
      if (typeof ResizeObserver !== 'undefined') this.resize = new ResizeObserver(this.onResizeObserved);
      this.attach();
      // Also covers sites that replace History methods after injection.
      this.routeTimer = this.win.setInterval(this.checkRoute, 500);
      this.draw();
      this.post({ type: 'ready', url: this.document.url });
      this.postState();
    });
  }
  restore(page: Page | null): void {
    this.guard(() => {
      this.checkRoute();
      this.cancel();
      this.discardPresentations();
      this.postNativeState(false);
      this.nativeEpoch = null;
      this.resetNativeFrames();
      this.nativeRestoreReady = false;
      this.document.restore(page);
      this.nativeRestoreReady = true;
      this.clearSaveTimer(); this.saveDirty = false;
      this.restored = true;
      this.renderer.clear();
      this.anchors.invalidate();
      this.warnings.clear();
      this.lastDimensions = null;
      this.checkLayoutWidth();
      this.postState();
      this.scheduleDraw();
    });
  }
  configure(options: Configuration): number | undefined {
    let freshnessFloor: number | undefined;
    this.guard(() => {
      const next = validateConfiguration(options);
      this.checkRoute();
      const nativeRefresh = this.nativeRenderer === 'native' && this.nativeEpoch !== null;
      if (nativeRefresh && this.nativeRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Native frame revision exhausted; bind a new session');
      }
      this.cancel();
      this.discardPresentations();
      this.configuration = { ...this.configuration, ...next };
      if (next.attachmentMode !== undefined) this.anchors.configure(next.attachmentMode);
      this.postNativeState();
      // Even {} is a refresh barrier. Delayed old ready tokens can cross the RPC
      // callback, so the consumer needs a source revision floor, not arrival order.
      this.scheduleDraw();
      if (nativeRefresh) freshnessFloor = this.nativeRevision + 1;
    });
    return freshnessFloor;
  }
  undo(): void { this.historyAction('undo'); }
  redo(): void { this.historyAction('redo'); }
  private historyAction(action: 'undo' | 'redo'): void {
    this.guard(() => {
      this.checkRoute();
      this.cancel();
      if (this.restored && !this.exporting && this.document[action]()) this.changed();
    });
  }
  /** Transport receipt only. Completed actions only; never a durable-save acknowledgment. */
  flush(): boolean {
    if (this.destroyed) return !this.saveDirty;
    if (!this.restored) return true;
    try {
      if (this.win.location.href === this.document.url) this.document.setTitle(this.win.document.title);
      this.clearSaveTimer();
      if (!this.win.WebInkHost && !this.saveDirty) return true;
      this.saveDirty = !this.post({ type: 'save', url: this.document.url, page: this.document.snapshot() });
      if (this.saveDirty) this.report(new Error('[save-transport] Ink was not handed to storage. Keep this page open and retry saving. 墨迹尚未交给存储，请保留页面并重试。'));
      return !this.saveDirty;
    } catch (error) {
      this.saveDirty = true;
      this.report(error);
      return false;
    }
  }
  snapshot(): Page {
    if (!this.destroyed) this.checkRoute();
    if (!this.restored) throw new Error('Ink restore is not complete');
    this.document.setTitle(this.win.document.title);
    return this.document.snapshot();
  }
  private exportStrokeVersions = new WeakMap<object, number>();
  private exportStrokeVersion = 0;
  /** Frozen resolved view for native replay; never persisted or passed to restore. */
  exportSnapshot(options: ExportSnapshotOptions = {}): ExportSnapshot {
    const settings = record(options, 'export options');
    const { offsetFor, policy, manifestOnly, includeInventory, readingRoot } = settings;
    if (offsetFor !== undefined && typeof offsetFor !== 'function') throw new Error('Invalid export offset callback');
    if (policy !== undefined && policy !== 'strict' && policy !== 'best-effort' ||
        manifestOnly !== undefined && typeof manifestOnly !== 'boolean' ||
        includeInventory !== undefined && typeof includeInventory !== 'boolean' ||
        readingRoot !== undefined && !(readingRoot instanceof Element)) throw new Error('Invalid export policy');
    const bestEffort = policy === 'best-effort';
    this.cancel();
    this.checkRoute();
    if (!this.restored) throw new Error('Ink restore is not complete');
    this.document.setTitle(this.win.document.title);
    const inventory = includeInventory ? this.document.snapshot() : undefined;
    const page: Page = { ...this.document.metadata(), strokes: [] };
    this.anchors.invalidate();
    let unresolved = 0, hidden = 0;
    const entries: ExportSnapshot['placement']['entries'] = [];
    for (const stroke of this.document.strokes) {
      let revision = this.exportStrokeVersions.get(stroke);
      if (revision === undefined) {
        if (this.exportStrokeVersion === Number.MAX_SAFE_INTEGER) throw new Error('Export revision capacity exceeded');
        revision = ++this.exportStrokeVersion;
        this.exportStrokeVersions.set(stroke, revision);
      }
      const omit = (status: 'pending' | 'unlocated' | 'excluded', reason: ExportSnapshot['placement']['entries'][number]['reason']): false => {
        entries.push({ id: stroke.id, revision: revision!, status, reason });
        if (status === 'unlocated') unresolved++; else hidden++;
        return false;
      };
      const resolved = this.anchors.resolve(stroke);
      const exclusion = bestEffort ? this.anchors.exportExclusion(stroke, readingRoot as Element | undefined) : null;
      if (exclusion) { omit('excluded', exclusion); continue; }
      if (readingRoot && (!stroke.anchor || stroke.anchor.kind === 'page-v1')) { omit('unlocated', 'page-plane'); continue; }
      if (resolved.status === 'unresolved') { omit('unlocated', 'unresolved'); continue; }
      if (resolved.status === 'hidden') { omit('pending', 'clipped'); continue; }
      const frame: RenderFrame = { matrix: [...resolved.frame.matrix], clips: resolved.frame.clips.map(clip => [...clip]) };
      const target = offsetFor ? this.anchors.resolvedTarget(stroke) : null;
      try {
        if (target && typeof offsetFor === 'function') {
          const offset = record(offsetFor(target), 'export offset');
          const x = finite(offset.x, -LIMITS.coordinate, LIMITS.coordinate, 'export offset x');
          const y = finite(offset.y, -LIMITS.coordinate, LIMITS.coordinate, 'export offset y');
          frame.matrix[4] += x; frame.matrix[5] += y;
          for (const clip of frame.clips) {
            // Domain-limit sentinels are unbounded axes, not physical edges.
            const xs = [clip[0], clip[2], clip[4], clip[6]], ys = [clip[1], clip[3], clip[5], clip[7]];
            const unboundedX = Math.min(...xs) === -LIMITS.coordinate && Math.max(...xs) === LIMITS.coordinate;
            const unboundedY = Math.min(...ys) === -LIMITS.coordinate && Math.max(...ys) === LIMITS.coordinate;
            for (let i = 0; i < 8; i += 2) { if (!unboundedX) clip[i] += x; if (!unboundedY) clip[i + 1] += y; }
          }
        }
        const m = frame.matrix;
        // Android replays Float geometry. A valid double-precision projection can
        // collapse there (e.g. a subpixel clip far from the origin); that is an
        // unlocated note, not a malformed-raw or whole-PDF failure.
        const nativeFrame: RenderFrame = { matrix: frame.matrix.map(Math.fround) as RenderFrame['matrix'],
          clips: frame.clips.map(clip => clip.map(Math.fround) as RenderFrame['clips'][number]) };
        const nativeSafe = !bestEffort || validFrame(nativeFrame) && nativeFrame.clips.every(clip =>
          [0, 1, 2, 3].every(i => {
            const j = (i + 1) % 4, k = (i + 2) % 4;
            return Math.fround(clip[j * 2] - clip[i * 2]) * Math.fround(clip[k * 2 + 1] - clip[j * 2 + 1]) -
              Math.fround(clip[j * 2 + 1] - clip[i * 2 + 1]) * Math.fround(clip[k * 2] - clip[j * 2]) > 1e-8;
          }));
        if (!nativeSafe || !validFrame(frame) || stroke.points.some(p =>
          Math.abs(m[0] * p.x + m[2] * p.y + m[4]) > LIMITS.coordinate ||
          Math.abs(m[1] * p.x + m[3] * p.y + m[5]) > LIMITS.coordinate)) throw new Error('Invalid projected export frame');
      } catch (error) {
        if (!bestEffort) throw error;
        omit('unlocated', 'projection'); continue;
      }
      const anchor = { kind: 'render-v1' as const, matrix: frame.matrix, clips: frame.clips };
      entries.push({ id: stroke.id, revision, status: 'placed', reason: 'current', frame: anchor });
      if (!manifestOnly) page.strokes.push({ ...stroke, points: stroke.points.map(p => ({ ...p })), anchor });
    }
    if (unresolved && !bestEffort) this.anchorNotice('export-anchor-unresolved');
    return { page, unresolved, hidden, ...(inventory ? { inventory } : {}), placement: { version: 1, entries } };
  }

  nativePointer(event: NativePointer): void {
    this.guard(() => {
      this.checkRoute();
      if (this.nativeSessionEnabled || !this.nativeInput || !this.canDraw()) return;
      const input = record(event, 'native pointer');
      const id = finite(input.id, 0, Number.MAX_SAFE_INTEGER, 'pointer id');
      if (!Number.isInteger(id)) throw new Error('Invalid pointer id');
      if (!['down', 'move', 'up', 'cancel'].includes(input.type as string)) throw new Error('Invalid pointer type');
      if (input.type === 'cancel') { if (this.gestures.pointerId === id) this.cancel(); return; }
      if (input.eraser !== undefined && typeof input.eraser !== 'boolean') throw new Error('Invalid eraser flag');
      if (input.type !== 'down' && this.gestures.pointerId !== id) return;
      const point = normalizedPoint(input.x, input.y, input.pressure, readViewport(this.win));
      this.handlePointer(input.type as 'down' | 'move' | 'up', id, point, input.eraser === true);
    }, true);
  }
  nativeSession(epoch: number, options?: NativeSessionOptions): boolean {
    let accepted = false;
    this.guard(() => {
      this.checkRoute();
      const next = nativeInteger(epoch, 'native epoch');
      const renderer = options === undefined ? 'hybrid' : record(options, 'native session options').renderer;
      const presentation = options?.presentation;
      if (renderer !== 'hybrid' && renderer !== 'native' && renderer !== 'browser' ||
        (options !== undefined && (renderer === 'hybrid' || Object.keys(options).some(key => key !== 'renderer' && key !== 'presentation'))) ||
        (presentation !== undefined && (presentation !== 1 || renderer !== 'native'))) {
        throw new Error('Invalid native renderer');
      }
      if (!this.nativeInput || !this.restored || !this.nativeRestoreReady || next <= this.lastNativeEpoch) return;
      // DOM work preceding the new binding belongs to the old basis, not basis 0.
      this.beginResolution();
      this.presentations = [];
      this.cancel();
      this.resetNativeFrames();
      this.nativeRenderer = renderer;
      this.nativePresentation = presentation === 1;
      this.nativeSessionEnabled = true;
      this.nativeEpoch = this.lastNativeEpoch = next;
      this.nativeBasis = 0;
      this.nativeSequence = this.nativeGesture = this.nativeTime = -1;
      this.nativeViewport = this.viewportKey(readViewport(this.win));
      this.updateVisibility();
      this.postNativeState();
      this.scheduleDraw();
      accepted = true;
    });
    return accepted;
  }
  nativeRenderFrame(): NativeRenderFrame | null {
    if (!this.destroyed) {
      this.checkRoute();
      if (this.nativePresentation) this.beginResolution();
    }
    return this.nativeFrameCache === null ? null : JSON.parse(this.nativeFrameCache) as NativeRenderFrame;
  }
  ackNativeRenderFrame(epoch: number, revision: number): void {
    if (this.destroyed) return;
    this.checkRoute();
    this.beginResolution();
    if (this.nativeRenderer !== 'native' || epoch !== this.nativeEpoch || !Number.isSafeInteger(revision) ||
      revision <= this.nativeAckRevision || revision > this.nativeRevision) return;
    this.nativeAckRevision = revision;
    this.presentations = this.presentations.filter(item => item.firstRevision === undefined || item.firstRevision > revision);
    if (this.nativeFrameCache !== null) {
      const frame = JSON.parse(this.nativeFrameCache) as NativeRenderFrame;
      const pending = new Set(this.presentations.map(item => item.gesture));
      frame.completions = frame.completions.filter(item => pending.has(item.gesture));
      this.nativeFrameCache = JSON.stringify(frame);
    }
    if (this.nativeStatePending) this.postNativeState();
  }
  private resetNativeFrames(): void {
    this.nativeFrameCache = null;
    this.nativePresentation = false;
    this.nativeSceneDirty = true;
    this.nativeRetainedScene = false;
    this.nativeMotionSequence = 0;
    this.nativeSceneViewport = '';
    this.nativeRevision = this.nativeAckRevision = this.nativeStateRevision = 0;
    this.nativeStatePending = false;
    this.presentations = [];
  }
  private updateVisibility(): void {
    this.root.style.setProperty('visibility', this.exporting || this.nativeRenderer === 'native' ? 'hidden' : 'visible', 'important');
  }
  nativePointers(value: NativePointerBatch): boolean {
    if (this.destroyed) return false;
    this.checkRoute();
    // Stale delivery cannot cancel a newer contact, even if its payload is malformed.
    if (this.nativeEpoch === null || value?.epoch !== this.nativeEpoch) return true;
    const epoch = this.nativeEpoch;
    let gesture: number, sequence: number;
    try { gesture = nativeInteger(value.gesture, 'native gesture'); sequence = nativeInteger(value.sequence, 'native sequence'); }
    catch (error) { this.cancelNative('Invalid native batch identity'); this.report(error); return false; }
    if (sequence <= this.nativeSequence || (gesture <= this.nativeGesture && gesture !== this.nativeContact?.gesture)) return true;
    this.nativeSequence = sequence;
    try {
      const batch = validateNativeBatch(value), viewport = readViewport(this.win);
      if (!this.canDraw()) throw new Error('Native ink is disabled');
      if (batch.basis !== this.expectedNativeBasis(batch)) throw new Error('Stale native viewport basis');
      if (this.viewportKey(viewport) !== this.nativeViewport) {
        this.onViewport(); throw new Error('Viewport changed before native batch delivery');
      }
      this.beginResolution();
      if (batch.basis !== this.expectedNativeBasis(batch)) throw new Error('Native basis changed before batch delivery');
      const first = batch.samples[0];
      if (first.time < this.nativeTime) throw new Error('Native event time went backwards');
      if (first.type === 'down') {
        if (gesture <= this.nativeGesture) return true;
        this.cancelNative('Superseded native contact');
        if (this.presentations.length >= NATIVE_LIMITS.pendingPresentations) throw new Error('Native presentation queue is full');
        this.nativeGesture = gesture;
        const point = normalizedPoint(first.x, first.y, first.pressure, viewport), elements: Element[] = [];
        for (let element = this.win.document.elementFromPoint(point.x - this.win.scrollX, point.y - this.win.scrollY);
          element && elements.length < 48; element = element.parentElement) elements.push(element);
        this.nativeContact = { gesture, basis: batch.basis, sequence, id: first.id, elements, geometry: this.contactGeometry(elements), contentAnchored: false };
      } else if (this.nativeContact?.gesture !== gesture || this.nativeContact.id !== first.id) {
        throw new Error('Native batch has no matching contact');
      }
      this.nativeContact!.sequence = sequence;
      engineWork.nativeBatches++;
      for (const sample of batch.samples) {
        this.nativeTime = sample.time;
        if (sample.type === 'cancel') { this.cancelNative('Native contact cancelled'); continue; }
        const strokeId = this.gestures.preview?.id;
        this.handlePointer(sample.type, sample.id, normalizedPoint(sample.x, sample.y, sample.pressure, viewport), sample.eraser === true, false);
        if (sample.type === 'down' && this.gestures.preview) {
          this.nativeContact!.frame = JSON.stringify(this.anchors.resolve(this.gestures.preview, false));
          const target = this.anchors.resolvedTarget(this.gestures.preview);
          this.nativeContact!.contentAnchored = target !== null;
          if (target) this.nativeContact!.geometry = this.contactGeometry([target]);
        }
        if (sample.type === 'up') {
          this.presentations.push({ epoch: batch.epoch, gesture, sequence, ...(strokeId ? { strokeId } : {}) });
          this.nativeContact = null;
          // Even a no-op eraser must cross an actual committed-canvas paint barrier.
          this.scheduleDraw();
        }
      }
      return true;
    } catch (error) {
      const owns = this.nativeContact?.gesture === gesture;
      if (owns) this.nativeContact!.sequence = sequence;
      if (owns) this.cancelNative(error instanceof Error ? error.message : String(error));
      if (!owns) this.rejectNativePresentation(epoch, gesture, sequence);
      this.nativeGesture = Math.max(this.nativeGesture, gesture);
      this.report(error);
      return false;
    }
  }
  private expectedNativeBasis(batch: NativePointerBatch): number {
    const contact = this.nativeContact, first = batch.samples[0];
    // An unchanged active transaction keeps its capture basis. No new DOWN,
    // different contact or pointer can use that exception after a mutation.
    return first.type !== 'down' && contact?.gesture === batch.gesture && contact.id === first.id ? contact.basis : this.nativeBasis;
  }
  private contactGeometry(elements: Element[]): string {
    return elements.map(element => {
      if (!element.isConnected) return 'detached';
      const rect = element.getBoundingClientRect();
      // Document extent is not the viewport or a target clip. A footer/counter
      // can grow BODY without changing this contact's coordinate basis.
      const size = /^(HTML|BODY)$/.test(element.tagName) ? '' : `${rect.width},${rect.height}`;
      return `${rect.x},${rect.y},${size},${element.scrollLeft},${element.scrollTop}`;
    }).join(';');
  }
  private viewportKey(v: Viewport): string {
    return `${v.pageLeft},${v.pageTop},${v.width},${v.height},${v.scale},${v.offsetLeft},${v.offsetTop}`;
  }
  private postNativeState(enabled = this.canDraw()): void {
    if (this.nativeEpoch === null) return;
    const waitingForFrame = this.nativeRenderer === 'native' && this.nativeStatePending &&
      (this.nativeStateRevision === 0 || this.nativeAckRevision < this.nativeStateRevision);
    if (enabled && (this.nativeContact || this.presentations.length || waitingForFrame)) {
      this.nativeStatePending = true;
      return;
    }
    this.nativeStatePending = false;
    const v = readViewport(this.win), c = this.configuration;
    this.post({ type: 'native-state', epoch: this.nativeEpoch, basis: this.nativeBasis, enabled, tool: c.tool,
      color: c.color, width: c.width, opacity: c.tool === 'highlighter' ? 0.35 : 1, viewportWidth: v.width, viewportHeight: v.height });
  }
  private cancelNative(reason: string): void {
    const contact = this.nativeContact;
    if (!contact) return;
    this.nativeContact = null;
    this.gestures.cancel();
    this.scheduleDraw();
    if (this.nativeEpoch !== null) this.rejectNativePresentation(this.nativeEpoch, contact.gesture, contact.sequence);
    if (!reason.startsWith('[attachment-rejected]')) this.report(new Error(`[native-rejected] ${reason}`));
  }
  private rejectNativePresentation(epoch: number, gesture: number, sequence: number): void {
    if (this.nativeRenderer !== 'native') {
      this.post({ type: 'presented', epoch, gesture, sequence, accepted: false });
      return;
    }
    const pending = this.presentations.find(item => item.epoch === epoch && item.gesture === gesture);
    if (pending) {
      // Same-turn geometry validation can cancel the contact before the batch's
      // catch path rejects its submission. Represent that contact exactly once.
      pending.sequence = Math.max(pending.sequence, sequence);
      pending.rejected = true;
      this.scheduleDraw();
      return;
    }
    // A rejected new contact can consume only a free slot, reserving one for an active contact.
    // If full, nativePointers(false) retires only the rejected submission on the host.
    if (this.presentations.length + (this.nativeContact ? 1 : 0) >= NATIVE_LIMITS.pendingPresentations) return;
    this.presentations.push({ epoch, gesture, sequence, rejected: true });
    this.scheduleDraw();
  }
  private discardPresentations(): void {
    // Native completions belong to an application ACK, never a cancellation/paint/flush.
    if (this.nativeRenderer === 'native') return;
    for (const { epoch, gesture, sequence } of this.presentations.splice(0)) this.post({ type: 'presented', epoch, gesture, sequence, accepted: false });
  }
  metrics(): Metrics {
    this.beginResolution();
    return this.resolvedMetrics();
  }
  private resolvedMetrics(): Metrics {
    const doc = this.win.document, root = doc.documentElement, body = doc.body;
    const v = readViewport(this.win);
    let width = Math.max(root?.scrollWidth ?? 0, root?.clientWidth ?? 0, body?.scrollWidth ?? 0, v.pageLeft + v.width);
    let height = Math.max(root?.scrollHeight ?? 0, root?.clientHeight ?? 0, body?.scrollHeight ?? 0, v.pageTop + v.height);
    for (const stroke of this.document.strokes) {
      const resolved = this.anchors.resolve(stroke);
      if (resolved.status !== 'visible') continue;
      const bounds = visibleBounds(stroke, resolved.frame);
      if (!bounds) continue;
      width = Math.max(width, bounds.right);
      height = Math.max(height, bounds.bottom);
    }
    return { width: Math.ceil(width), height: Math.ceil(height), viewportWidth: v.width, viewportHeight: v.height,
      scrollX: v.pageLeft, scrollY: v.pageTop };
  }
  setExporting(value: boolean): void {
    this.guard(() => {
      if (typeof value !== 'boolean') throw new Error('Invalid exporting flag');
      if (value) { this.cancel(); this.discardPresentations(); this.flush(); }
      this.exporting = value;
      this.postNativeState();
      this.updateVisibility();
      if (!value) this.scheduleDraw();
    });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    this.cancel();
    this.discardPresentations();
    this.clearSaveTimer();
    this.destroyed = true;
    this.postNativeState();
    this.nativeEpoch = null;
    this.resetNativeFrames();
    for (const dispose of this.cleanup.splice(0)) dispose();
    this.mutation?.disconnect();
    this.resize?.disconnect();
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    if (this.routeTimer !== null) this.win.clearInterval(this.routeTimer);
    this.frame = this.routeTimer = null;
    this.root.remove();
    this.canvas.width = this.canvas.height = this.activeCanvas.width = this.activeCanvas.height = 1;
    this.renderer.clear();
    this.anchors.destroy();
    if (this.win.WebInk === this) delete this.win.WebInk;
  }

  private emptyDocument(): InkDocument {
    return new InkDocument(pageUrl(this.win.location.href), this.win.document.title, this.layoutWidth());
  }
  private layoutWidth(): number { return Math.max(1, this.win.document.documentElement?.clientWidth ?? this.win.innerWidth); }
  private canDraw(): boolean { return this.booted && this.restored && this.configuration.enabled && !this.exporting && !this.destroyed; }
  private handlePointer(type: 'down' | 'move' | 'up', id: number, point: Point, eraser: boolean, beginResolution = true): void {
    if (beginResolution) this.beginResolution();
    // Candidates only grow within a contact. Repeated samples over the same hit set
    // need neither a committed repaint nor another native replacement.
    const erasedCount = this.gestures.erasedIds?.size ?? 0;
    if (type === 'down') this.gestures.begin(id, point, { ...this.configuration, tool: eraser ? 'eraser' : this.configuration.tool });
    else if (type === 'move') this.gestures.move(id, point);
    else {
      const tool = this.gestures.preview?.tool;
      if (this.gestures.end(id, point)) this.changed(tool === 'pen' || tool === 'highlighter' ? 'append' : 'erase');
    }
    if ((type === 'down' && erasedCount > 0) || (this.gestures.erasedIds?.size ?? 0) !== erasedCount) this.scheduleDraw();
    else if (this.nativeEpoch === null || this.nativeRenderer === 'browser') this.scheduleActiveDraw();
  }
  private browserPointer = (event: PointerEvent): void => {
    if (this.destroyed || this.nativeInput || event.pointerType !== 'pen') return;
    this.checkRoute();
    if (!this.canDraw()) return;
    if (event.type === 'pointerdown' && event.button !== 0 && event.button !== 5) return;
    if (event.type !== 'pointerdown' && this.gestures.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') { this.cancel(); return; }
    this.guard(() => {
      const type = event.type === 'pointerdown' ? 'down' : event.type === 'pointerup' ? 'up' : 'move';
      if (type === 'down') {
        this.cancel();
        if (event.target instanceof Element) {
          try {
            event.target.setPointerCapture(event.pointerId);
            this.browserCapture = { target: event.target, id: event.pointerId };
          } catch { /* Synthetic events and some DOM targets cannot capture; window listeners remain. */ }
        }
      }
      if (type === 'move' && event.buttons === 0 && event.pressure === 0) { this.cancel(); return; }
      const viewport = readViewport(this.win);
      this.beginResolution();
      const samples = type === 'move' && typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const sample of samples) {
        this.handlePointer('move', event.pointerId, clientPoint(sample.clientX, sample.clientY, sample.pressure, viewport), false, false);
      }
      this.handlePointer(type, event.pointerId, clientPoint(event.clientX, event.clientY, event.pressure, viewport),
        event.button === 5 || Boolean(event.buttons & 32), false);
      if (type === 'up') this.releaseCapture();
    }, true);
  };
  private releaseCapture(): void {
    const capture = this.browserCapture;
    this.browserCapture = null;
    if (capture) {
      try { if (capture.target.hasPointerCapture(capture.id)) capture.target.releasePointerCapture(capture.id); }
      catch { /* Target may have been detached by the page. */ }
    }
  }
  private cancel = (): void => {
    this.discardPresentations();
    this.cancelNative('Contact interrupted');
    this.gestures.cancel();
    this.releaseCapture();
    this.scheduleDraw();
  };
  private clearSaveTimer(): void {
    if (this.saveTimer !== null) this.win.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
  private changed(kind: 'edit' | 'append' | 'erase' = 'edit'): void {
    // Same-content gestures replace atomically without blanking untouched ink.
    // Eraser preview/commit always rebuild a full scene, not positional motion:
    // pending older scenes cannot unmask a hit or resurrect a deleted stroke.
    // History and content/geometry invalidations retain their revocation barriers.
    if (kind === 'edit') this.invalidateNativeScene();
    this.saveDirty = true;
    if (this.saveTimer === null) this.saveTimer = this.win.setTimeout(() => {
      this.saveTimer = null;
      if (this.saveDirty) this.flush();
    }, 0);
    this.postState(); this.scheduleDraw();
  }
  private postState(): void { this.post({ type: 'state', undo: this.document.canUndo, redo: this.document.canRedo }); }
  private post(message: HostMessage): boolean {
    try {
      if (!this.win.WebInkHost) return false;
      this.win.WebInkHost.postMessage(JSON.stringify(message)); return true;
    }
    catch (error) { console.error('[WebInk] Host message failed; committed ink is still available via snapshot()/flush()', error); return false; }
  }
  private report(error: unknown): void {
    if (error instanceof AttachmentRejectedError) { this.anchorNotice('attachment-rejected'); return; }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WebInk] ${message}`);
    this.post({ type: 'error', message: message.slice(0, 2048) });
  }
  private guard(action: () => void, cancelOnError = false): void {
    if (this.destroyed) return;
    try { action(); }
    catch (error) { if (cancelOnError) this.cancel(); this.report(error); }
  }
  private checkRoute = (): void => {
    if (this.destroyed || this.win.location.href === this.document.url) return;
    this.guard(() => {
      const next = this.emptyDocument();
      // Native accepts a retiring save only for its active ready URL, before ready(next).
      this.flush();
      this.cancel();
      this.discardPresentations();
      this.postNativeState(false);
      this.nativeEpoch = null;
      this.resetNativeFrames();
      this.nativeRestoreReady = false;
      this.clearSaveTimer(); this.saveDirty = false;
      this.document = next;
      this.anchors.invalidate();
      this.gestures = new GestureController(next, this.anchors);
      this.restored = !this.nativeInput;
      this.renderer.clear();
      this.anchors.invalidate();
      this.warnings.clear();
      this.lastDimensions = null;
      this.post({ type: 'ready', url: next.url });
      this.postState();
      this.scheduleDraw();
    });
  };
  private onPageHide = (): void => { this.cancel(); this.flush(); };
  private onVisibility = (): void => {
    if (this.win.document.visibilityState === 'hidden') this.onPageHide();
    else this.scheduleDraw();
  };
  private invalidateNativeBasis(reason: string, motion = false): void {
    this.cancelNative(reason);
    this.discardPresentations();
    this.nativeViewport = this.viewportKey(readViewport(this.win));
    this.advanceNativeBasis();
    if (motion) this.scheduleMotionDraw(); else this.scheduleDraw();
  }
  private advanceNativeBasis(): void {
    if (this.nativeEpoch === null) return;
    if (this.nativeBasis === Number.MAX_SAFE_INTEGER) {
      this.cancelNative('Native basis exhausted');
      this.discardPresentations();
      this.postNativeState(false);
      this.nativeEpoch = null;
      this.resetNativeFrames();
      this.report(new Error('[native-rejected] Native basis exhausted; bind a new session'));
    } else {
      this.nativeBasis++;
      // A previously built frame cannot release a newly deferred basis.
      this.nativeStateRevision = 0;
      this.postNativeState();
    }
  }
  private onViewport = (): void => {
    this.invalidateNativeScene();
    this.invalidateNativeBasis('Viewport changed during native contact');
  };
  private onResizeObserved = (entries: ResizeObserverEntry[]): void => {
    let changed = false, geometryChanged = false;
    for (const entry of entries) {
      const size = `${entry.contentRect.width},${entry.contentRect.height}`;
      const previous = this.observedSizes.get(entry.target);
      if (previous !== undefined && previous !== size) {
        geometryChanged = true;
        if (!/^(HTML|BODY)$/.test(entry.target.tagName)) changed = true;
      }
      this.observedSizes.set(entry.target, size);
    }
    // Initial observation repeats geometry already resolved by paint. It must not
    // generate a second native frame for the same commit/session.
    if (changed) this.onViewport();
    if (geometryChanged) this.onGeometry();
  };
  private onGeometry = (): void => {
    this.invalidateNativeScene();
    this.beginResolution();
    this.scheduleDraw();
  };
  private onScroll = (): void => {
    this.invalidateNativeBasis('Viewport changed during native contact', true);
    this.anchors.beginFrame();
    this.warnLayout('scroll');
  };
  private anchorNotice = (code: string): void => {
    if (this.warnings.has(code)) return;
    this.warnings.add(code);
    // The host reports one export result, including after normal drawing resumes.
    if (this.exporting) return;
    const messages: Record<string, string> = {
      'page-fallback': 'Compatibility ink follows page coordinates, not inner scrolling.',
      'attachment-rejected': 'This location cannot safely follow content. Try Compatibility.',
      'surface-following': 'Ink follows this verified region, not individual reflowed words.',
      'anchor-unresolved': 'Some ink cannot be matched safely to the current content and is hidden.',
      'export-anchor-unresolved': 'Some export ink is unlocated; a best-effort host can preserve it in an appendix.',
      'layout-changed': 'Content width changed. Block anchors follow content, not individual reflowed words.',
      'legacy-layout': 'Legacy ink keeps its saved document coordinates; historical inner-scroll offsets cannot be recovered.',
    };
    this.report(new Error(`[${code}] ${messages[code] ?? code}`));
  };
  private warnLayout(_reason: string): void {
    if (this.document.strokes.some(stroke => !stroke.anchor)) this.anchorNotice('legacy-layout');
  }
  private checkLayoutWidth(): void {
    if (Math.abs(this.layoutWidth() - this.document.layoutWidth) > 2) {
      this.warnLayout('width');
      if (this.document.strokes.some(stroke => stroke.anchor)) this.anchorNotice('layout-changed');
    }
  }
  private attach(): void {
    const doc = this.win.document;
    if (doc.documentElement && this.root.parentNode !== doc.documentElement) doc.documentElement.append(this.root);
    if (this.root.isConnected && typeof this.root.showPopover === 'function' && !this.root.matches(':popover-open')) {
      this.root.showPopover();
    }
    if (this.resize && this.observedRoot !== doc.documentElement) {
      if (this.observedRoot) this.resize.unobserve(this.observedRoot);
      this.observedRoot = doc.documentElement;
      if (this.observedRoot) this.resize.observe(this.observedRoot);
    }
    if (this.resize && this.observedBody !== doc.body) {
      if (this.observedBody) this.resize.unobserve(this.observedBody);
      this.observedBody = doc.body;
      if (this.observedBody) this.resize.observe(this.observedBody);
    }
  }
  private listen(target: EventTarget, name: string, handler: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(name, handler, options);
    this.cleanup.push(() => target.removeEventListener(name, handler, options));
  }
  private pageMutated(records: MutationRecord[]): boolean {
    return records.some(item => item.target !== this.root && !this.root.contains(item.target) &&
      !(item.type === 'childList' && [...item.addedNodes, ...item.removedNodes].every(node => node === this.root)));
  }
  private beginResolution(): void {
    // Host calls can follow a DOM replacement in the same JS turn, before the
    // observer callback. Never hit-test stale identities in that interval.
    if (this.pageMutated(this.mutation?.takeRecords() ?? [])) this.invalidateContent();
    else { this.anchors.beginFrame(); this.revalidateNativeContact(); }
  }
  private invalidateContent(): void {
    this.invalidateNativeScene();
    this.anchors.invalidate();
    this.scheduleDraw();
    // Every observed content mutation fences queued starts, even with no JS
    // contact yet. Unchanged active contacts retain their own captured basis;
    // publication waits until contact/presentation retirement, not mid-preview.
    const previous = this.nativeBasis;
    this.revalidateNativeContact();
    if (this.nativeBasis === previous) this.advanceNativeBasis();
  }
  private revalidateNativeContact(): void {
    const contact = this.nativeContact;
    if (!contact) return;
    try { this.gestures.revalidateErasure(); }
    catch (error) {
      this.invalidateNativeBasis(error instanceof Error ? error.message : String(error));
      return;
    }
    const preview = this.gestures.preview;
    const target = contact.contentAnchored && preview ? this.anchors.resolvedTarget(preview) : null;
    const geometry = contact.contentAnchored ? (target ? this.contactGeometry([target]) : 'unresolved') : this.contactGeometry(contact.elements);
    if (geometry !== contact.geometry ||
      (preview && contact.frame !== JSON.stringify(this.anchors.resolve(preview, false)))) {
      this.invalidateNativeBasis('Content identity or viewport changed during native contact');
    }
  }
  private invalidateNativeScene(): void {
    if (this.nativePresentation && this.nativeFrameCache !== null && this.nativeEpoch !== null) {
      // Revoke changed content immediately, before asynchronous scene work can apply.
      this.post({ type: 'frame-invalidated', epoch: this.nativeEpoch, floor: this.nativeRevision + 1 });
      this.nativeFrameCache = null;
    }
    this.nativeSceneDirty = true;
  }
  private scheduleDraw = (): void => {
    // Rebuilding completion/configuration metadata is not evidence that existing ink or
    // the input basis changed. Only content/geometry/edit invalidation revokes that scene.
    this.nativeSceneDirty = true;
    this.scheduleMotionDraw();
  };
  private scheduleMotionDraw = (): void => {
    this.committedDirty = true;
    this.scheduleActiveDraw();
  };
  private scheduleActiveDraw = (): void => {
    this.activeDirty = true;
    if (!this.booted || this.destroyed || this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      this.guard(() => this.draw());
    });
  };
  private publishNativeFrame(viewport: Viewport): void {
    if (this.nativeEpoch === null || !this.nativeRestoreReady || this.exporting) return;
    if (this.nativeRevision === Number.MAX_SAFE_INTEGER) throw new Error('Native frame revision exhausted; bind a new session');
    if (this.nativePresentation && !this.nativeSceneDirty && this.nativeRetainedScene &&
      this.nativeSceneViewport === `${viewport.width},${viewport.height},${viewport.scale}`) {
      try {
        const motion = nativeMotion(this.document.strokes, stroke => this.anchors.resolve(stroke, false), viewport,
          this.nativeEpoch, this.nativeRevision, ++this.nativeMotionSequence, this.nativeBasis, this.gestures.erasedIds);
        // A pure-motion basis still waits for this scene's completion ACK, not a new
        // full payload that continuous scrolling intentionally does not produce.
        if (this.nativeStatePending) this.nativeStateRevision = this.nativeRevision;
        this.post(motion);
        return;
      } catch {
        this.invalidateNativeScene(); // Revoke coverage before the explicit full-frame fallback below.
      }
    }
    const metadata = { ...this.document.metadata(), strokes: this.document.strokes };
    const page = nativeFramePage(metadata, viewport, this.anchors.resolve, this.gestures.erasedIds);
    const represented = new Set(page.strokes.map(stroke => stroke.id));
    const revision = this.nativeRevision + 1;
    const frame: NativeRenderFrame = { version: 1, epoch: this.nativeEpoch, basis: this.nativeBasis, revision,
      viewport: { left: viewport.pageLeft, top: viewport.pageTop, width: viewport.width, height: viewport.height }, page,
      completions: this.presentations.map(item => ({ gesture: item.gesture, sequence: item.sequence,
        accepted: !item.rejected && (!item.strokeId || represented.has(item.strokeId)) })) };
    // Capacity fallback is explicit and retains exact-frame safety, never partial coverage.
    this.nativeRetainedScene = false;
    if (this.nativePresentation) {
      try {
        const retained = { ...frame, page: nativeScenePage(metadata), motion: nativeMotion(this.document.strokes,
          stroke => this.anchors.resolve(stroke, false), viewport, this.nativeEpoch, revision, ++this.nativeMotionSequence,
          this.nativeBasis, this.gestures.erasedIds) };
        this.nativeFrameCache = encodeNativeRenderFrame(retained, this.win.location.href);
        this.nativeRetainedScene = true;
      } catch (error) {
        if (!this.warnings.has('native-motion-fallback')) {
          this.warnings.add('native-motion-fallback');
          this.report(new Error(`[native-motion-fallback] ${error instanceof Error ? error.message : String(error)}`));
        }
        this.nativeFrameCache = encodeNativeRenderFrame(frame, this.win.location.href);
      }
    } else this.nativeFrameCache = encodeNativeRenderFrame(frame, this.win.location.href);
    this.nativeSceneDirty = false;
    this.nativeSceneViewport = `${viewport.width},${viewport.height},${viewport.scale}`;
    this.nativeRevision = revision;
    for (const item of this.presentations) item.firstRevision ??= revision;
    if (this.nativeStatePending) this.nativeStateRevision = revision;
    engineWork.nativeFrames++;
    this.post({ type: 'frame-ready', epoch: frame.epoch, basis: frame.basis, revision, completed: frame.completions.length,
      ...(this.nativeRetainedScene ? { retained: true as const } : {}) });
  }
  private draw(): void {
    this.checkRoute();
    this.attach();
    const viewport = readViewport(this.win);
    const size = canvasSize(viewport.width, viewport.height, (this.win.devicePixelRatio || 1) * viewport.scale);
    for (const [property, value] of Object.entries({ left: viewport.offsetLeft, top: viewport.offsetTop,
      width: viewport.width, height: viewport.height })) {
      const css = `${value}px`;
      if (this.root.style.getPropertyValue(property) !== css) this.root.style.setProperty(property, css, 'important');
    }
    const webPreview = !this.nativeInput || !this.nativeSessionEnabled || this.nativeRenderer === 'browser';
    for (const canvas of [this.canvas, this.activeCanvas]) {
      const hidden = this.nativePresentation && this.nativeRenderer === 'native';
      const width = hidden || (canvas === this.activeCanvas && !webPreview) ? 1 : size.width;
      const height = hidden || (canvas === this.activeCanvas && !webPreview) ? 1 : size.height;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        this.committedDirty = this.activeDirty = true;
      }
    }
    this.beginResolution();
    const prepare = (context: CanvasRenderingContext2D): void => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, size.width, size.height);
      context.setTransform(size.width / viewport.width, 0, 0, size.height / viewport.height, 0, 0);
    };
    if (this.committedDirty) {
      const retained = this.nativePresentation && this.nativeRenderer === 'native';
      let painted: ReadonlySet<string> = new Set<string>();
      if (!retained) {
        prepare(this.context);
        painted = this.renderer.paint(this.context, this.document.strokes, viewport, this.gestures.erasedIds, null, this.anchors.resolve);
        this.checkLayoutWidth();
        const dimensions = this.resolvedMetrics();
        if (this.lastDimensions && (Math.abs(dimensions.width - this.lastDimensions.width) > 2 ||
          Math.abs(dimensions.height - this.lastDimensions.height) > 2)) this.warnLayout('extent');
        this.lastDimensions = dimensions;
      } else if (this.nativeSceneDirty) this.checkLayoutWidth();
      this.committedDirty = false;
      if (this.nativeRenderer === 'native') {
        try { this.publishNativeFrame(viewport); }
        catch (error) { this.committedDirty = true; throw error; }
      } else {
        // Legacy/browser paint completion, never flush/save completion.
        for (const { epoch, gesture, sequence, strokeId } of this.presentations.splice(0)) {
          if (epoch !== this.nativeEpoch) continue;
          const accepted = !strokeId || painted.has(strokeId);
          this.post({ type: 'presented', epoch, gesture, sequence, accepted });
          if (!accepted) this.report(new Error('[native-rejected] Stroke was not painted before presentation'));
        }
      }
    }
    if (this.nativeStatePending) this.postNativeState();
    if (this.activeDirty) {
      prepare(this.activeContext);
      if (webPreview) this.renderer.paint(this.activeContext, [], viewport, undefined, this.gestures.preview, this.anchors.resolve);
      this.activeDirty = false;
    }
  }
}
