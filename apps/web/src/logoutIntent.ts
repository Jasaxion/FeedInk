export interface LogoutIntent { id: string; owner: string | null }
const key = 'feedink-logout-pending';
export function readLogoutIntent(): LogoutIntent | null {
  const value = localStorage.getItem(key); if (!value) return null;
  try { const parsed = JSON.parse(value); if (typeof parsed.id === 'string' && (typeof parsed.owner === 'string' || parsed.owner === null)) return parsed; } catch { /* legacy unbound marker */ }
  // An old unbound marker may block restoration, but must never revoke an arbitrary current account.
  return { id: value, owner: null };
}
export function createLogoutIntent(owner?: string): LogoutIntent {
  const intent = { id: crypto.randomUUID(), owner: owner || null }; localStorage.setItem(key, JSON.stringify(intent)); return intent;
}
export function isCurrentLogout(intent: LogoutIntent): boolean {
  const current = readLogoutIntent(); return current?.id === intent.id && current.owner === intent.owner;
}
export function clearLogoutIntent(intent: LogoutIntent) { if (isCurrentLogout(intent)) localStorage.removeItem(key); }
