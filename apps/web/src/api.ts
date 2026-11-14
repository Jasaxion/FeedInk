import type { ApiError, Session } from '@feedink/shared';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = '') { super(message); }
}
let current: Session | null = null;
let generation = 0;
export function setApiSession(session: Session | null) { if (current?.user.id !== session?.user.id) generation++; current = session; }
export function getApiSession() { return current; }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const epoch = generation;
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && current?.csrfToken) headers.set('X-CSRF-Token', current.csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (epoch !== generation) throw new Error('账号已变更，请重试');
  if (!response.ok) {
    const error = await response.json().catch(() => null) as ApiError | null;
    if (response.status === 401 && !path.startsWith('/auth/') && path !== '/session') window.dispatchEvent(new Event('feedink:unauthorized'));
    throw new HttpError(response.status, error?.error?.message || `请求失败 (${response.status})`, error?.error?.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const mutate = <T>(path: string, method: string, data?: unknown) => api<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
export async function download(path: string, name: string): Promise<void> {
  if (!/^\/api\/(export\/(opml|archive)|ebooks\/[a-zA-Z0-9_-]+\/download|assets\/[a-zA-Z0-9_-]+)$/.test(path)) throw new Error('无效的下载地址');
  const epoch = generation;
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as ApiError | null;
    throw new HttpError(response.status, error?.error?.message || `下载失败 (${response.status})`);
  }
  const blob = await response.blob();
  if (epoch !== generation) throw new Error('账号已变更，下载已取消');
  downloadBlob(blob, name);
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
