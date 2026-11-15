export type AuthOperation = 'local' | 'login' | 'revocation';
export class AuthCoordinationError extends Error {}
interface LockRecord { token: string; generation: string }
let tail: Promise<unknown> = Promise.resolve();
let activeCheck: (() => Promise<void>) | undefined;
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('feedink-auth-coordination', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('coordination');
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
}
async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const tx = db.transaction('coordination', mode);
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); }); void done.catch(() => {});
  try { const result = await work(tx.objectStore('coordination')); await done; return result; }
  catch (error) { try { tx.abort(); } catch { /* already completed */ } throw error; }
}
async function run<T>(action: () => Promise<T>, check?: () => Promise<void>): Promise<T> {
  activeCheck = check;
  try { await check?.(); const result = await action(); await check?.(); return result; }
  finally { activeCheck = undefined; }
}
export async function checkAuthOperation(): Promise<void> { await activeCheck?.(); }
async function storedLock<T>(action: () => Promise<T>, kind: AuthOperation): Promise<T> {
  let db: IDBDatabase;
  try { db = await database(); }
  catch {
    if (kind === 'revocation') throw new AuthCoordinationError('账号操作协调不可用，未撤销服务器会话。请恢复浏览器存储或在支持账号协调的浏览器中退出。');
    return run(action);
  }
  const token = crypto.randomUUID(); let generation: string | null = null; const deadline = Date.now() + 8000;
  try {
    while (generation === null) {
      generation = await transaction(db, 'readwrite', async store => {
        if (await request(store.get('lock'))) return null;
        const current = await request(store.get('generation')) as string | undefined || 'initial';
        await request(store.put({ token, generation: current } satisfies LockRecord, 'lock')); return current;
      });
      if (generation === null) {
        if (Date.now() >= deadline) throw new AuthCoordinationError('账号操作协调被另一个标签页占用。请先关闭其他账号操作标签页，再使用“恢复账号操作协调”；阅读缓存和排队更改不会删除。');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const check = () => transaction(db, 'readonly', async store => {
      const lock = await request(store.get('lock')) as LockRecord | undefined;
      const current = await request(store.get('generation')) as string | undefined || 'initial';
      if (lock?.token !== token || current !== generation || lock.generation !== generation) throw new AuthCoordinationError('账号操作协调已重置，旧操作已取消，请重试。');
    });
    return await run(action, check);
  } finally {
    await transaction(db, 'readwrite', async store => { const lock = await request(store.get('lock')) as LockRecord | undefined; if (lock?.token === token) await request(store.delete('lock')); }).catch(() => {});
    db.close();
  }
}
/** Never expires/steals an in-flight auth lock. Only explicit recovery advances its global generation. */
export async function coordinateAuthentication<T>(action: () => Promise<T>, kind: AuthOperation): Promise<T> {
  const execute = async (): Promise<T> => globalThis.navigator?.locks ? await navigator.locks.request('feedink-auth-network', () => run(action)) : storedLock(action, kind);
  const result = tail.then(execute, execute); tail = result.then(() => undefined, () => undefined); return result;
}
/** Caller must confirm other authentication tabs have been closed. Private reader stores are untouched. */
export async function resetAuthCoordination(): Promise<void> {
  const db = await database();
  try { await transaction(db, 'readwrite', async store => { await request(store.put(crypto.randomUUID(), 'generation')); await request(store.delete('lock')); }); }
  finally { db.close(); }
  if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('feedink-auth'); channel.postMessage({ type: 'coordination-reset' }); channel.close(); }
}
