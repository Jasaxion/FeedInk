import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface AnnotationBounds { left: number; top: number; right: number; bottom: number }
/** Fixed overlays use layout-viewport coordinates, clipped to the visible reader. */
export function annotationBounds(reader: AnnotationBounds, viewport: AnnotationBounds): AnnotationBounds {
  return { left: Math.max(reader.left, viewport.left) + 8, top: Math.max(reader.top, viewport.top) + 8, right: Math.min(reader.right, viewport.right) - 8, bottom: Math.min(reader.bottom, viewport.bottom) - 8 };
}
export function placeAnnotation(bounds: AnnotationBounds, size: { width: number; height: number }, anchor?: AnnotationBounds) {
  const width = Math.min(size.width, Math.max(0, bounds.right - bounds.left)), height = Math.min(size.height, Math.max(0, bounds.bottom - bounds.top));
  const x = anchor ? (anchor.left + anchor.right - width) / 2 : bounds.right - width;
  const y = anchor ? (anchor.top - height - 8 >= bounds.top ? anchor.top - height - 8 : anchor.bottom + 8) : bounds.top;
  return { left: Math.max(bounds.left, Math.min(x, bounds.right - width)), top: Math.max(bounds.top, Math.min(y, bounds.bottom - height)) };
}

export function AnnotationFloat({ root, anchor, kind, children, onClose, onInvisible, label, testId }: {
  root: RefObject<HTMLDivElement | null>; anchor?: Range | null; kind: 'selection' | 'editor' | 'ink' | 'drawer' | 'notice'; children: ReactNode; onClose: () => void; onInvisible?: () => void; label: string; testId?: string;
}) {
  const element = useRef<HTMLDivElement>(null), callbacks = useRef({ onClose, onInvisible }); callbacks.current = { onClose, onInvisible };
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const host = root.current?.closest('.app-shell');
  useLayoutEffect(() => {
    const reader = root.current?.closest('.reader-scroll'), node = element.current;
    if (!reader || !node) return;
    let frame = 0;
    const position = () => {
      frame = 0;
      const viewport = window.visualViewport;
      const bounds = annotationBounds(reader.getBoundingClientRect(), { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, right: (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth), bottom: (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) });
      const maxWidth = Math.max(0, bounds.right - bounds.left), maxHeight = Math.max(0, bounds.bottom - bounds.top);
      const heightLimit = kind === 'drawer' && window.innerWidth < 700 ? maxHeight * .72 : maxHeight;
      node.style.maxWidth = `${maxWidth}px`; node.style.maxHeight = `${heightLimit}px`;
      let target: AnnotationBounds | undefined;
      if (anchor) {
        if (!root.current?.contains(anchor.startContainer) || !root.current.contains(anchor.endContainer)) { callbacks.current.onInvisible?.(); return; }
        const visible = Array.from(anchor.getClientRects()).filter(r => r.width && r.height && r.bottom > bounds.top && r.top < bounds.bottom && r.right > bounds.left && r.left < bounds.right);
        if (!visible.length) { if (kind === 'selection') callbacks.current.onInvisible?.(); }
        else target = { left: Math.min(...visible.map(r => r.left)), right: Math.max(...visible.map(r => r.right)), top: visible[0].top, bottom: visible[visible.length - 1].bottom };
      }
      const box = node.getBoundingClientRect();
      const position = placeAnnotation(bounds, box, target);
      if (kind === 'drawer') { position.top = window.innerWidth < 700 ? bounds.bottom - Math.min(box.height, heightLimit) : bounds.top; }
      setStyle({ ...position, maxWidth, maxHeight: heightLimit, visibility: maxWidth > 0 && maxHeight > 0 ? 'visible' : 'hidden' });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    const resize = new ResizeObserver(schedule); resize.observe(node); resize.observe(reader);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
    position();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule); };
  }, [host, anchor, kind, root]);
  useLayoutEffect(() => {
    if (style.visibility !== 'visible') return;
    if (kind === 'editor') element.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    if (kind === 'drawer') element.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [style.visibility, kind, anchor]);
  if (!host) return null;
  return createPortal(<div ref={element} className={`annotation-float annotation-${kind}`} data-annotation-ui="" data-testid={testId} role={kind === 'selection' || kind === 'ink' ? 'toolbar' : 'dialog'} aria-label={label} style={style}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); callbacks.current.onClose(); } }}>
    {children}
  </div>, host);
}
