import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, Bookmark, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Download, ExternalLink, Folder, Grid2X2, HelpCircle, Home, Image, Inbox, List, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Rss, Search, Settings, Share2, SlidersHorizontal, Tag, Trash2, User, Volume2, WifiOff, X, PanelLeftClose, PanelLeftOpen, BookOpen, Archive, Sun, Mail, Play, Pause, Square, Pin, BellOff } from 'lucide-react';
import { useApp } from './context';
import { ownedAssetUrl } from './logic';

const icons = { back: ArrowLeft, up: ArrowUp, down: ArrowDown, saved: Bookmark, check: Check, allRead: CheckCheck, collapse: ChevronDown, left: ChevronLeft, right: ChevronRight, previous: ChevronUp, next: ChevronDown, unread: Circle, download: Download, external: ExternalLink, folder: Folder, grid: Grid2X2, help: HelpCircle, home: Home, image: Image, inbox: Inbox, list: List, loading: LoaderCircle, logout: LogOut, menu: Menu, more: MoreHorizontal, add: Plus, refresh: RefreshCw, rss: Rss, search: Search, settings: Settings, share: Share2, filters: SlidersHorizontal, tag: Tag, delete: Trash2, user: User, audio: Volume2, offline: WifiOff, close: X, sidebarClose: PanelLeftClose, sidebarOpen: PanelLeftOpen, article: BookOpen, archive: Archive, theme: Sun, mail: Mail, play: Play, pause: Pause, stop: Square, pin: Pin, mute: BellOff };
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
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) { return <label className="toggle"><span>{label}{hint && <small>{hint}</small>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /></label>; }
export function Empty({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ReactNode }) { return <div className="empty"><Icon name={icon} size={32} /><h2>{title}</h2>{children}</div>; }

export function AssetImage({ src, alt, className = '', onClick }: { src: string | null; alt: string; className?: string; onClick?: () => void }) {
  const { session, store } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true; let objectUrl = '';
    const safe = src && ownedAssetUrl(src); setUrl(safe || null); setFailed(false);
    if (safe) void store.image(session.user.id, safe).then(blob => { if (blob && alive) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => {});
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, session.user.id, store]);
  if (!url || failed) return null;
  return <img className={className} src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} onClick={onClick} />;
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
