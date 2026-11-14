import type { ApiError } from '@feedink/shared';
import { assertAuthEpoch, authEpoch, beginAuthTransition, getApiSession, withAuthNetworkLock } from './authEpoch';
export { setApiSession, getApiSession } from './authEpoch';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = '') { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (['/auth/login', '/auth/register', '/auth/demo'].includes(path)) beginAuthTransition();
  const epoch = authEpoch();
  const current = getApiSession();
  const execute = async (): Promise<T> => {
  assertAuthEpoch(epoch);
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && current?.csrfToken) headers.set('X-CSRF-Token', current.csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  assertAuthEpoch(epoch);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as ApiError | null;
    assertAuthEpoch(epoch);
    if (response.status === 401 && !path.startsWith('/auth/') && path !== '/session') window.dispatchEvent(new Event('feedink:unauthorized'));
    const retry = response.status === 429 ? `；请求过于频繁，请${response.headers.get('Retry-After') && /^\d+$/.test(response.headers.get('Retry-After')!) ? `在 ${response.headers.get('Retry-After')} 秒后` : '稍后'}重试` : '';
    throw new HttpError(response.status, (error?.error?.message || `请求失败 (${response.status})`) + retry, error?.error?.code);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json() as T;
  assertAuthEpoch(epoch);
  return body;
  };
  return path.startsWith('/auth/') ? withAuthNetworkLock(execute) : execute();
}
export const mutate = <T>(path: string, method: string, data?: unknown) => api<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
export async function download(path: string, name: string): Promise<void> {
  if (!/^\/api\/(export\/(opml|archive)|ebooks\/[a-zA-Z0-9_-]+\/download|assets\/[a-zA-Z0-9_-]+)$/.test(path)) throw new Error('无效的下载地址');
  const epoch = authEpoch();
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as ApiError | null;
    assertAuthEpoch(epoch);
    throw new HttpError(response.status, error?.error?.message || `下载失败 (${response.status})`);
  }
  const blob = await response.blob(); assertAuthEpoch(epoch);
  downloadBlob(blob, name);
}
export function downloadCachedImage(source: string, name: string) {
  if (!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/.test(source)) throw new Error('无效的缓存图片下载');
  const anchor = document.createElement('a'); anchor.href = source; anchor.download = name; anchor.click();
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
