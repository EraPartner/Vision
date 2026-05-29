/**
 * Admin auth token storage (frontend).
 *
 * The backend's admin endpoints accept `Authorization: Bearer <token>` when
 * `ADMIN_AUTH_TOKEN` is configured server-side (see middleware/adminAuth.js).
 * Previously the frontend never sent that header, so setting the token made the
 * admin UI unusable (every admin request 401'd). This holds the token in
 * sessionStorage — NOT localStorage — so it is scoped to the browser session
 * and never persisted to disk.
 *
 * When no token is stored, requests carry no Authorization header and the
 * backend falls back to its loopback/private-network allowlist: unchanged
 * default behaviour. The header is only added once a token is explicitly set.
 */
const KEY = 'vision.adminToken';

function sessionStore(): Storage | null {
  // sessionStorage access throws in some privacy modes / sandboxed iframes.
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The stored admin token, or null when unset/blank/unavailable. */
export function getAdminToken(): string | null {
  const value = sessionStore()?.getItem(KEY);
  return value && value.trim() ? value.trim() : null;
}

/** Store the admin token (a blank value clears it). */
export function setAdminToken(token: string): void {
  const store = sessionStore();
  if (!store) return;
  const trimmed = token.trim();
  if (trimmed) store.setItem(KEY, trimmed);
  else store.removeItem(KEY);
}

/** Remove the stored admin token. */
export function clearAdminToken(): void {
  sessionStore()?.removeItem(KEY);
}

/** Whether an admin token is currently stored. */
export function hasAdminToken(): boolean {
  return getAdminToken() !== null;
}
