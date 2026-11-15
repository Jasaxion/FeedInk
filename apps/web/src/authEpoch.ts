import type { Session } from '@feedink/shared';
import { coordinateAuthentication, type AuthOperation } from './authCoordinator';

let epoch = 0;
let session: Session | null = null;
export class ObsoleteSessionError extends Error { constructor() { super('账号已变更，旧操作已取消'); } }
export function authEpoch() { return epoch; }
export function assertAuthEpoch(expected: number) { if (epoch !== expected) throw new ObsoleteSessionError(); }
/** Called synchronously before login, logout, revocation and cross-tab identity transitions. */
export function beginAuthTransition() { session = null; if (typeof window !== 'undefined') window.dispatchEvent(new Event('feedink:identity-lock')); return ++epoch; }
export function setApiSession(value: Session | null, expected = epoch) {
  assertAuthEpoch(expected);
  if (session?.user.id !== value?.user.id) epoch++;
  session = value;
  return epoch;
}
export function getApiSession() { return session; }
/** Metadata comes from React/server updates; credentials remain authoritative in this module. */
export function mergeSessionMetadata(value: Session, expected: number): Session {
  assertAuthEpoch(expected);
  if (!session || session.user.id !== value.user.id) throw new ObsoleteSessionError();
  return { ...value, csrfToken: session.csrfToken };
}
export async function withAuthNetworkLock<T>(action: () => Promise<T>, kind: AuthOperation = 'local'): Promise<T> { return coordinateAuthentication(action, kind); }
export function updateCredentials(value: Session, expected: number) {
  assertAuthEpoch(expected);
  if (session?.user.id !== value.user.id) throw new ObsoleteSessionError();
  session = { ...session, csrfToken: value.csrfToken };
}
