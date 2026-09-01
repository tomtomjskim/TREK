/**
 * Auth gate — a single boolean the sync layer checks before touching the
 * offline DB. It lets logout disable all background sync (flush / syncAll /
 * periodic triggers) *before* awaiting the DB swap, so an in-flight loop can't
 * re-seed the database after the user has logged out.
 *
 * Kept separate from authStore to avoid an import cycle
 * (authStore → tripSyncManager → authStore).
 */
let _authed = false
let _generation = 0

/** A snapshot of the authenticated session that started an async sync job. */
export interface AuthLease {
  generation: number
}

export function setAuthed(value: boolean): void {
  // Every auth transition notification starts a new session generation. This
  // also invalidates work when a caller switches accounts without an
  // observable false state between the two login completions.
  _generation += 1
  _authed = value
}

export function isAuthed(): boolean {
  return _authed
}

/** Capture the current session, or null when no authenticated session exists. */
export function captureAuthLease(): AuthLease | null {
  return _authed ? { generation: _generation } : null
}

/** Return true only while the session that created the lease is still active. */
export function isAuthLeaseValid(lease: AuthLease): boolean {
  return _authed && lease.generation === _generation
}
