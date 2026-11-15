import type { AnnotationContext, AnnotationDocument, AnnotationMode, Session } from '@feedink/shared';
import { api, HttpError } from './api';
import { assertAuthEpoch, getApiSession, updateCredentials, withAuthNetworkLock } from './authEpoch';
import { annotationKey, assertContext, payloadOf, validateAnnotations, type StoredAnnotations } from './annotationData';
import type { OfflineStore } from './offline';
import { withOwnerLock, OwnerMismatchError } from './stateSync';

export const annotationPath = (context: Pick<AnnotationContext, 'articleId' | 'mode'> & Partial<AnnotationContext>) => `/articles/${encodeURIComponent(context.articleId)}/annotations?${new URLSearchParams({ mode: context.mode, ...(context.contentHash ? { contentHash: context.contentHash } : {}) })}`;
export async function fetchAnnotations(articleId: string, mode: AnnotationMode, contentHash?: string) {
  const expected = { articleId, mode, contentHash };
  const result = await api<AnnotationDocument>(annotationPath(expected)); assertContext(result, expected); return result;
}
export async function synchronizeAnnotations(store: OfflineStore, owner: string, epoch: number): Promise<void> {
  return withAuthNetworkLock(() => withOwnerLock(store, owner, async check => {
    const guard = async () => { assertAuthEpoch(epoch); if (getApiSession()?.user.id !== owner) throw new OwnerMismatchError(); await check(); assertAuthEpoch(epoch); };
    await guard();
    const session = await api<Session>('/session'); await guard();
    if (session.user.id !== owner) throw new OwnerMismatchError();
    updateCredentials(session, epoch);
    for (const row of await store.pendingAnnotations(owner)) {
      if (row.conflict) continue;
      await guard();
      const current = await store.annotations(owner, row.document.context); await guard();
      if (current?.localVersion !== row.localVersion) continue;
      try {
        const result = await api<AnnotationDocument>(annotationPath(row.document.context), { method: 'PUT', headers: { 'If-Match': `"${row.document.revision}"` }, body: JSON.stringify(payloadOf(validateAnnotations(row.document))) });
        await guard(); assertContext(result, row.document.context);
        await store.acknowledgeAnnotations(owner, row, result); await guard();
      } catch (error) {
        await guard();
        if (!(error instanceof HttpError) || error.status !== 412) throw error;
        const server = await fetchAnnotations(row.document.context.articleId, row.document.context.mode, row.document.contentHash); await guard();
        await store.annotationConflict(owner, row.document.context, server); await guard();
      }
    }
    window.dispatchEvent(new Event('feedink:annotations-synced'));
  }));
}

interface LiveNotes { owner: string; email: string; flush: () => Promise<void>; freeze: () => void; snapshot: () => StoredAnnotations | null }
const live = new Set<LiveNotes>();
// Only a verified matching session may move locked in-memory failures back into active storage.
const locked = new Map<string, { email: string; rows: StoredAnnotations[] }>();
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (locked.size) { event.preventDefault(); event.returnValue = ''; }
});
export function guardLockedAnnotationLogin(email: string, demo: boolean) {
  if ([...locked.values()].some(value => demo || value.email.toLowerCase() !== email.toLowerCase())) throw new Error('请先登录原账号恢复未同步笔记；草稿仍锁定在此标签页。');
}
export async function recoverLockedAnnotations(store: OfflineStore, owner: string) {
  if ([...locked.keys()].some(id => id !== owner)) throw new Error('未同步笔记属于另一账号，未启用此账号。');
  const retained = locked.get(owner); if (!retained) return;
  for (const row of retained.rows) {
    const existing = await store.annotations(owner, row.document.context);
    if (existing?.localVersion === row.localVersion && !existing.pending) continue;
    const next = existing && existing.localVersion !== row.localVersion ? { ...row, conflict: existing.document } : row;
    await store.putAnnotations(owner, next, existing?.localVersion ?? null);
  }
  locked.delete(owner);
}
export function discardLockedAnnotations(owner: string) { locked.delete(owner); }
export function registerNotes(notes: LiveNotes) { live.add(notes); return () => live.delete(notes); }
export async function flushActiveNotes() { for (const notes of live) await notes.flush(); }
export function freezeActiveNotes(owner?: string) {
  const entries = [...live].filter(note => !owner || note.owner === owner);
  for (const notes of entries) {
    notes.freeze();
    const row = notes.snapshot();
    if (row?.pending) {
      const old = locked.get(notes.owner)?.rows || [];
      locked.set(notes.owner, { email: notes.email, rows: [...new Map([...old, structuredClone(row)].map(value => [annotationKey(value.document.context), value])).values()] });
    }
  }
  return Promise.all(entries.map(notes => notes.flush()));
}
export function liveAnnotationDrafts(owner: string) {
  return [...live].filter(notes => notes.owner === owner).map(notes => notes.snapshot()).filter((row): row is StoredAnnotations => !!row && row.pending);
}
export async function allAnnotationDrafts(store: OfflineStore, owner: string) {
  let entries: StoredAnnotations[] = [];
  try { entries = await store.annotationDocuments(owner); } catch (error) { if (!liveAnnotationDrafts(owner).length && !locked.get(owner)?.rows.length) throw error; }
  const merged = new Map(entries.map(row => [annotationKey(row.document.context), row]));
  for (const row of [...(locked.get(owner)?.rows || []), ...liveAnnotationDrafts(owner)]) {
    const id = annotationKey(row.document.context), saved = merged.get(id);
    if (!saved || saved.localVersion !== row.localVersion) merged.set(id, row);
  }
  return [...merged.values()].filter(row => row.pending);
}
