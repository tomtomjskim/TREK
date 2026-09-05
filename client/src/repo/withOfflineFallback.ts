import { isEffectivelyOffline } from '../sync/networkMode'
import { captureOfflineDbLease, isOfflineDbLeaseValid } from '../db/offlineDb'
import { captureAuthGenerationLease, isAuthGenerationLeaseValid } from '../sync/authGate'

/** Optional lease checked immediately before a read-through cache mutation. */
export type CacheWriteGuard = () => boolean

/** Bind cache writes to both the starting DB and an optional caller request. */
export function cacheWriteGuard(extra: CacheWriteGuard = () => true): CacheWriteGuard {
  const dbLease = captureOfflineDbLease()
  const authLease = captureAuthGenerationLease()
  return () => isOfflineDbLeaseValid(dbLease) && isAuthGenerationLeaseValid(authLease) && extra()
}

export class StaleCacheResponseError extends Error {
  constructor() {
    super('Cache response belongs to an expired auth or database session')
    this.name = 'StaleCacheResponseError'
  }
}

/** Stop callers from applying a response that belongs to another auth session. */
export function assertCacheWriteAllowed(guard: CacheWriteGuard): void {
  if (!guard()) throw new StaleCacheResponseError()
}

/**
 * True when an error means the request never reached the server — a network-level
 * failure (offline, captive portal, proxy auth wall, dropped connection, CORS).
 * Axios sets `response` only when the server actually replied; its absence (on an
 * Axios error) means we never got one. A real HTTP error (4xx/5xx) HAS a response
 * and must NOT be treated as a network failure — the server spoke, so the caller
 * needs to see it. Non-Axios errors are surfaced too.
 */
function isNetworkError(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; response?: unknown } | null
  return !!e && e.isAxiosError === true && e.response == null
}

/**
 * Read-through cache pattern shared by every repo's read methods.
 *
 * Reads degrade to the local Dexie cache in two situations:
 *   1. The browser reports it is offline (`navigator.onLine` false) — skip the
 *      doomed request entirely.
 *   2. The browser *thinks* it is online but the request fails at the network
 *      level — a lying `navigator.onLine` on a captive portal, a dropped
 *      connection (H2). Rather than surfacing that (which blanks the trip even
 *      though a good cached copy exists), we fall back to the cache.
 *
 * We gate on the effective offline state (real `navigator.onLine` OR the user's
 * force-offline override), NOT the connectivity probe: the probe is a coarse
 * global flag, and a single failed health check would otherwise force every read
 * to the (possibly empty) cache even when the request itself would succeed. The
 * network-error catch below covers the captive-portal case the probe was meant to.
 *
 * A genuine HTTP error (404/403/500 — the server responded) is NOT swallowed: it
 * is rethrown so callers can set error state, navigate away, etc.
 *
 * Writes must NOT use this — they go through the mutation queue so failures are
 * surfaced and retried, not silently swallowed.
 */
export async function onlineThenCache<T>(
  onlineFn: () => Promise<T>,
  cacheFn: () => Promise<T>,
): Promise<T> {
  // The returned value is also session-scoped. A request can finish after
  // logout/account switch even when it never writes through to Dexie, so use
  // the same DB/auth lease that protects read-through cache writes.
  const sessionGuard = cacheWriteGuard()
  if (isEffectivelyOffline()) {
    const cached = await cacheFn()
    assertCacheWriteAllowed(sessionGuard)
    return cached
  }
  try {
    const online = await onlineFn()
    assertCacheWriteAllowed(sessionGuard)
    return online
  } catch (err) {
    if (isNetworkError(err)) {
      assertCacheWriteAllowed(sessionGuard)
      const cached = await cacheFn()
      assertCacheWriteAllowed(sessionGuard)
      return cached
    }
    throw err
  }
}
