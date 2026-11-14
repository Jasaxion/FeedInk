import type { Session } from '@feedink/shared';

let epoch = 0;
let session: Session | null = null;
export class ObsoleteSessionError extends Error { constructor() { super('账号已变更，旧操作已取消'); } }
export function authEpoch() { return epoch; }
export function assertAuthEpoch(expected: number) { if (epoch !== expected) throw new ObsoleteSessionError(); }
/** Called synchronously before login, logout, revocation and cross-tab identity transitions. */
export function beginAuthTransition() { session = null; return ++epoch; }
export function setApiSession(value: Session | null, expected = epoch) {
  assertAuthEpoch(expected);
  if (session?.user.id !== value?.user.id) epoch++;
  session = value;
  return epoch;
}
export function getApiSession() { return session; }
let authNetworkTail: Promise<unknown> = Promise.resolve();
export async function withAuthNetworkLock<T>(action: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request('feedink-auth-network', action);
  const result = authNetworkTail.then(action, action); authNetworkTail = result.then(() => undefined, () => undefined); return result;
}
export function updateCredentials(value: Session, expected: number) {
  assertAuthEpoch(expected);
  if (session?.user.id !== value.user.id) throw new ObsoleteSessionError();
  session = { ...session, csrfToken: value.csrfToken };
}
