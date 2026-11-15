import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, Bookmark, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Download, ExternalLink, Folder, Grid2X2, HelpCircle, Home, Image, Inbox, List, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Rss, Search, Settings, Share2, SlidersHorizontal, Tag, Trash2, User, Volume2, WifiOff, X, PanelLeftClose, PanelLeftOpen, BookOpen, Archive, Sun, Mail, Play, Pause, Square, Pin, BellOff, Maximize2, Minimize2 } from 'lucide-react';
import { useApp } from './context';
import { ownedImageUrl } from './logic';

const icons = { back: ArrowLeft, up: ArrowUp, down: ArrowDown, saved: Bookmark, check: Check, allRead: CheckCheck, collapse: ChevronDown, left: ChevronLeft, right: ChevronRight, previous: ChevronUp, next: ChevronDown, unread: Circle, download: Download, external: ExternalLink, folder: Folder, grid: Grid2X2, help: HelpCircle, home: Home, image: Image, inbox: Inbox, list: List, loading: LoaderCircle, logout: LogOut, menu: Menu, more: MoreHorizontal, add: Plus, refresh: RefreshCw, rss: Rss, search: Search, settings: Settings, share: Share2, filters: SlidersHorizontal, tag: Tag, delete: Trash2, user: User, audio: Volume2, offline: WifiOff, close: X, sidebarClose: PanelLeftClose, sidebarOpen: PanelLeftOpen, article: BookOpen, archive: Archive, theme: Sun, mail: Mail, play: Play, pause: Pause, stop: Square, pin: Pin, mute: BellOff, focus: Maximize2, focusExit: Minimize2 };
export type IconName = keyof typeof icons;
export function Icon({ name, size = 19 }: { name: IconName; size?: number }) { const Component = icons[name]; return <Component size={size} strokeWidth={1.65} aria-hidden="true" />; }
export function IconButton({ icon, label, ...props }: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}><Icon name={icon} /></button>;
}
export function Logo({ text = false }: { text?: boolean }) { return <span className="logo"><img src="/icon.svg" alt="" width="30" height="30" />{text && <strong>FeedInk</strong>}</span>; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby="modal-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h2 id="modal-title">{title}</h2><IconButton icon="close" label="关闭对话框" onClick={onClose} /></header><div className="modal-content">{children}</div>
  </dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const labelControls = (nodes: ReactNode): ReactNode => Children.map(nodes, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    if (['input', 'select', 'textarea'].includes(String(child.type))) return cloneElement(child, { 'aria-labelledby': id, 'aria-describedby': hint ? `${id}-hint` : undefined });
    return child.props.children !== undefined ? cloneElement(child, { children: labelControls(child.props.children as ReactNode) }) : child;
  });
  return <label className="field"><span id={id}>{label}</span>{labelControls(children)}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) { return <label className="toggle"><span>{label}{hint && <small>{hint}</small>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /></label>; }
export function Empty({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ReactNode }) { return <div className="empty"><Icon name={icon} size={32} /><h2>{title}</h2>{children}</div>; }

export function AssetImage({ src, alt, className = '', onClick }: { src: string | null; alt: string; className?: string; onClick?: () => void }) {
  const { session, store } = useApp();
  const [result, setResult] = useState<{ source: string; owner: string; url: string; failed: boolean } | null>(null);
  const currentUrl = useRef('');
  useEffect(() => {
    let alive = true; setResult(null); currentUrl.current = '';
    const safe = src && ownedImageUrl(src);
    if (safe) void (async () => {
      // Resolve IDB first: a failing network URL must never hide a cached replacement.
      const cached = await store.imageSource(session.user.id, safe).catch(() => undefined);
      if (!alive) return;
      const url = cached || safe;
      if (!alive) return; currentUrl.current = url;
      setResult({ source: safe, owner: session.user.id, url, failed: false });
    })().catch(() => { if (alive) setResult(null); });
    return () => { alive = false; currentUrl.current = ''; };
  }, [src, session.user.id, store]);
  if (!result || result.source !== src || result.owner !== session.user.id || result.failed) return null;
  return <img key={result.url} className={className} src={result.url} alt={alt} loading={result.url.startsWith('data:image/') ? 'eager' : 'lazy'} referrerPolicy="no-referrer" onError={() => { if (currentUrl.current === result.url) setResult(old => old?.url === result.url ? { ...old, failed: true } : old); }} onClick={onClick} />;
}
export function SourceIcon({ subscriptionId, size = 15 }: { subscriptionId: string | null; size?: number }) {
  const { library } = useApp(); const subscription = library.subscriptions.find(item => item.id === subscriptionId);
  return <span className="source-icon"><Icon name="rss" size={size} />{subscription?.iconUrl && <AssetImage src={subscription.iconUrl} alt={`${subscription.title}图标`} />}</span>;
}

export function ResizeHandle({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const start = useRef<{ x: number; value: number } | null>(null);
  return <div className="resize-handle" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuenow={draft ?? value} aria-valuemin={min} aria-valuemax={max}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onChange(Math.max(min, Math.min(max, value + (event.key === 'ArrowRight' ? 16 : -16)))); } }}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); start.current = { x: event.clientX, value }; setDraft(value); }}
    onPointerMove={event => { if (start.current) setDraft(Math.max(min, Math.min(max, start.current.value + event.clientX - start.current.x))); }}
    onPointerUp={() => { if (draft !== null) onChange(draft); start.current = null; setDraft(null); }} onPointerCancel={() => { start.current = null; setDraft(null); }}>
    {draft !== null && <span className="resize-value">{draft}px</span>}
  </div>;
}
