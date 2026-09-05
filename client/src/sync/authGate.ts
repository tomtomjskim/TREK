/**
 * Auth gate — a single boolean the sync layer checks before touching the
 * offline DB. It lets logout disable all background sync (flush / syncAll /
 * periodic triggers) *before* awaiting the DB swap, so an in-flight loop can't
 * re-seed the database after the user has logged out.
 *
 * Kept separate from authStore to avoid an import cycle
 * (authStore → tripSyncManager → authStore).
 */
function initialAuthIdentity(): string | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('trek_auth_snapshot') : null
    if (!raw) return null
    const state = JSON.parse(raw)?.state
    return state?.isAuthenticated && state?.user?.id != null ? String(state.user.id) : null
  } catch {
    return null
  }
}

let _authed = false
let _generation = 0
let _identity = initialAuthIdentity()

/** A snapshot of the authenticated session that started an async sync job. */
export interface AuthLease {
  generation: number
}

/** Raised when an async UI action finishes after logout or an account switch. */
export class StaleAuthSessionError extends Error {
  constructor() {
    super('The authentication session changed while the request was in flight')
    this.name = 'StaleAuthSessionError'
  }
}

export function setAuthed(value: boolean, userId?: number | string): void {
  const nextIdentity = value
    ? (userId == null ? _identity : String(userId))
    : null
  // Invalidate on logout and on an actual account change. A same-user
  // loadUser validation must not cancel cache reads already started during
  // persisted-session boot.
  if (!value || nextIdentity !== _identity) _generation += 1
  _authed = value
  _identity = nextIdentity
}

export function isAuthed(): boolean {
  return _authed
}

/** Capture the current session, or null when no authenticated session exists. */
export function captureAuthLease(): AuthLease | null {
  return _authed ? { generation: _generation } : null
}

/** Capture the auth generation even before/after authentication is established. */
export function captureAuthGenerationLease(): AuthLease {
  return { generation: _generation }
}

/** Return true only while the session that created the lease is still active. */
export function isAuthLeaseValid(lease: AuthLease): boolean {
  return _authed && lease.generation === _generation
}

/** Detect any login/logout/account transition without requiring an authed state. */
export function isAuthGenerationLeaseValid(lease: AuthLease): boolean {
  return lease.generation === _generation
}

/** Prevent a late response from mutating state owned by a different account. */
export function assertAuthGenerationLeaseValid(lease: AuthLease): void {
  if (!isAuthGenerationLeaseValid(lease)) throw new StaleAuthSessionError()
}
