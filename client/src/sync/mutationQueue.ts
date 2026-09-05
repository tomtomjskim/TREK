/**
 * Mutation queue — offline write queue backed by IndexedDB (Dexie).
 *
 * Flow:
 *   offline create/update/delete → enqueue() → optimistic Dexie write (in repo)
 *   online trigger → flush() → replay REST with X-Idempotency-Key header → update Dexie
 */
import { offlineDb, captureOfflineDbLease, isOfflineDbLeaseValid } from '../db/offlineDb'
import { apiClient } from '../api/client'
import { captureAuthGenerationLease, isAuthGenerationLeaseValid, isAuthed } from './authGate'
import { isEffectivelyOffline } from './networkMode'
import { getOfflinePrefs } from './offlinePrefs'
import { randomId } from '../utils/randomId'
import type { QueuedMutation } from '../db/offlineDb'
import type { Table } from 'dexie'

// Map Dexie table names used in `resource` field → actual Dexie tables.
type EntityTables = Readonly<Record<string, Table>>

function currentEntityTables(): EntityTables {
  return {
    places:       offlineDb.places,
    packingItems: offlineDb.packingItems,
    todoItems:    offlineDb.todoItems,
    budgetItems:  offlineDb.budgetItems,
    reservations: offlineDb.reservations,
    tripFiles:    offlineDb.tripFiles,
  }
}

function getTable(resource: string, tables: EntityTables = currentEntityTables()): Table | undefined {
  return tables[resource]
}

/**
 * Generate a v4-style UUID using the platform crypto API.
 *
 * The implementation moved to utils/randomId so the axios interceptor, which
 * mints the same header for online writes, cannot drift away from it — this
 * value becomes the X-Idempotency-Key and a duplicate silently drops a write.
 */
export function generateUUID(): string {
  return randomId()
}

let _flushing = false
// A row sits on 'syncing' only while its request is in flight, and the shared
// axios instance times out at 8s. Anything still 'syncing' a minute later
// belongs to a flush that never reached its catch — the tab was killed, the PWA
// was evicted, the device slept mid-request. flush() only ever selects
// 'pending', so without recovery that row is stranded: counted in the badge,
// never replayed, and blocking every dependent behind it.
const STUCK_SYNCING_MS = 60_000
// Monotonically increasing timestamp so same-millisecond enqueues
// still get a deterministic FIFO order when sorted by createdAt.
let _lastTs = 0
// Monotonic counter for offline temp ids. Date.now() alone collides when two
// creates land in the same millisecond (bulk import, rapid tapping), which would
// overwrite one optimistic Dexie row. This guarantees distinct negative ids.
let _lastTempId = 0

/**
 * Mint a collision-free temporary (negative) id for an offline-created entity.
 * Monotonic across the session so same-millisecond creates never collide.
 */
export function nextTempId(): number {
  const now = Date.now()
  _lastTempId = now > _lastTempId ? now : _lastTempId + 1
  return -_lastTempId
}

/** HTTP statuses that should be retried later rather than treated as terminal. */
function isRetryableStatus(status: number | undefined): boolean {
  // 401: token expired mid-flush (offline window) — retry after re-auth.
  // 408/425/429: timeout / too-early / rate-limited — transient.
  return status === 401 || status === 408 || status === 425 || status === 429
}

/** Pull the server's current entity out of a 409 response body ({ server: {...} }). */
function extractConflictServer(err: unknown): unknown {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data && typeof data === 'object' && 'server' in data) {
    return (data as { server: unknown }).server
  }
  return null
}

/** Write a server entity into its Dexie table (used when "theirs" wins a conflict). */
async function applyServerEntity(mutation: QueuedMutation, server: unknown, tables?: EntityTables): Promise<void> {
  if (!mutation.resource || !server || typeof server !== 'object' || !('id' in server)) return
  const table = getTable(mutation.resource, tables)
  if (table) await table.put(server)
}

class StaleFlushError extends Error {
  constructor() {
    super('The authentication session or offline database changed while the queue was flushing')
    this.name = 'StaleFlushError'
  }
}

type FlushContext = {
  authLease: ReturnType<typeof captureAuthGenerationLease>
  dbLease: ReturnType<typeof captureOfflineDbLease>
  queue: Table
  tables: EntityTables
}

type QueueContext = FlushContext

function captureQueueContext(): QueueContext {
  return {
    authLease: captureAuthGenerationLease(),
    dbLease: captureOfflineDbLease(),
    queue: offlineDb.mutationQueue,
    tables: currentEntityTables(),
  }
}

function isQueueLeaseValid(context: QueueContext): boolean {
  return isAuthGenerationLeaseValid(context.authLease) && isOfflineDbLeaseValid(context.dbLease)
}

function assertFlushLease(context: FlushContext): void {
  if (!isFlushLeaseValid(context)) {
    throw new StaleFlushError()
  }
}

function isFlushLeaseValid(context: FlushContext): boolean {
  return isAuthed() && isAuthGenerationLeaseValid(context.authLease) && isOfflineDbLeaseValid(context.dbLease)
}

export const mutationQueue = {
  /**
   * Add a mutation to the queue.
   * Returns the UUID (= idempotency key).
   */
  async enqueue(
    mutation: Omit<QueuedMutation, 'status' | 'attempts' | 'createdAt' | 'lastError'>,
  ): Promise<string> {
    const context = captureQueueContext()
    const now = Date.now()
    _lastTs = now > _lastTs ? now : _lastTs + 1
    const item: QueuedMutation = {
      ...mutation,
      status: 'pending',
      attempts: 0,
      createdAt: _lastTs,
      lastError: null,
    }
    if (!isQueueLeaseValid(context)) return item.id
    await context.queue.put(item)
    // A late enqueue is isolated to the captured DB handle. Do not let its
    // result leak into a newer account's in-memory/UI state.
    if (!isQueueLeaseValid(context)) return item.id
    return item.id
  },

  /**
   * Drain the queue: replay each pending mutation against the server in FIFO order.
   * Stops on first network error (will retry on next trigger).
   * 4xx responses are marked failed and skipped.
   */
  async flush(): Promise<void> {
    if (_flushing || isEffectivelyOffline() || !isAuthed()) return
    const context = captureQueueContext()
    assertFlushLease(context)
    _flushing = true
    // tempId → realId learned during this flush, so a dependent edit/delete
    // queued against an offline-created entity (still holding the negative id)
    // can be rewritten to the server id before it is replayed.
    const idMap = new Map<number, number>()
    // resource:entityId → freshest updated_at applied during this flush. A second
    // queued edit of the same entity must send THIS token, not the stale one its
    // snapshot was loaded with, or it would 409 against our own first edit (#1135).
    const tokenMap = new Map<string, string>()
    // Set when a conflict auto-resolved as "mine wins": the mutation is re-queued
    // without its base token, so one more pass overwrites the server cleanly.
    let needsRetry = false
    try {
      // Reclaim what an interrupted flush left behind before picking up work.
      // Replaying is safe: the mutation id doubles as the X-Idempotency-Key, so
      // a write the server already applied is answered from its replay cache.
      const stuckBefore = Date.now() - STUCK_SYNCING_MS
      assertFlushLease(context)
      await context.queue
        .where('status')
        .equals('syncing')
        .filter(m => (m.syncingSince ?? 0) < stuckBefore)
        .modify(m => { m.status = 'pending'; m.syncingSince = undefined })
      assertFlushLease(context)

      assertFlushLease(context)
      const pending = await context.queue
        .where('status')
        .equals('pending')
        .sortBy('createdAt')
      assertFlushLease(context)

      for (const mutation of pending) {
        // Re-checked every pass, not just on entry: this loop writes server
        // responses straight into Dexie, and after a logout the proxy points at
        // the shared anonymous database. A flush that started before logout
        // would otherwise seed it with the previous account's rows.
        assertFlushLease(context)

        // Mark as syncing so UI can show progress. The stamp is what lets the
        // next flush tell an in-flight row from one a killed tab abandoned.
        assertFlushLease(context)
        await context.queue.update(mutation.id, { status: 'syncing', syncingSince: Date.now() })
        assertFlushLease(context)

        // Resolve a temp-id reference now that earlier CREATEs in this flush
        // may have completed (FIFO order guarantees the CREATE ran first).
        let reqUrl = mutation.url
        let reqEntityId = mutation.entityId
        if (mutation.tempEntityId !== undefined) {
          const realId = idMap.get(mutation.tempEntityId)
          if (realId !== undefined) {
            reqUrl = reqUrl.replace('{id}', String(realId))
            reqEntityId = realId
          }
        }
        // Placeholder still unresolved → the create it depended on is gone
        // (failed or missing). Surface it as failed rather than firing a 404.
        if (reqUrl.includes('{id}')) {
          assertFlushLease(context)
          await context.queue.update(mutation.id, {
            status: 'failed',
            attempts: mutation.attempts + 1,
            lastError: 'unresolved temp id (dependent create did not sync)',
          })
          assertFlushLease(context)
          continue
        }

        try {
          // Send the optimistic-concurrency token when we have one so the server
          // can reject a stale overwrite (409). Absent header => unconditional
          // write (back-compat with servers / resources that don't check it).
          // A newer token learned earlier in THIS flush (an earlier edit of the
          // same entity) overrides the snapshot's stale base.
          const headers: Record<string, string> = { 'X-Idempotency-Key': mutation.id }
          const tokenKey = mutation.resource !== undefined && reqEntityId !== undefined ? `${mutation.resource}:${reqEntityId}` : undefined
          const baseToken = (tokenKey && tokenMap.get(tokenKey)) || mutation.baseUpdatedAt
          if (baseToken) headers['X-Base-Updated-At'] = baseToken
          assertFlushLease(context)
          const response = await apiClient.request({
            method: mutation.method,
            url: reqUrl,
            data: mutation.body,
            headers,
          })
          assertFlushLease(context)

          // Apply canonical server response to Dexie
          if (mutation.method !== 'DELETE' && mutation.resource) {
            const table = getTable(mutation.resource, context.tables)
            if (table && response.data && typeof response.data === 'object') {
              // Server returns { place: {...} } or { item: {...} } — grab first value
              const values = Object.values(response.data as Record<string, unknown>)
              const entity = values[0]
              if (entity && typeof entity === 'object' && 'id' in entity) {
                const realId = (entity as { id: number }).id
                // Remove temp optimistic entry if id changed (CREATE case) and
                // remap any queued mutations that still target the negative id.
                if (mutation.tempId !== undefined && mutation.tempId !== realId) {
                  assertFlushLease(context)
                  await table.delete(mutation.tempId)
                  assertFlushLease(context)
                  idMap.set(mutation.tempId, realId)
                  // Durable rewrite so dependents survive a flush boundary / reload.
                  assertFlushLease(context)
                  await context.queue
                    .where('tripId')
                    .equals(mutation.tripId)
                    .filter(m => m.tempEntityId === mutation.tempId)
                    .modify(m => {
                      m.url = m.url.replace('{id}', String(realId))
                      m.entityId = realId
                      m.tempEntityId = undefined
                    })
                  assertFlushLease(context)
                }
                assertFlushLease(context)
                await table.put(entity)
                assertFlushLease(context)
                // Advance the base-version token of any other queued edits to the
                // same entity to the value we just wrote. Without this, a second
                // offline edit of the same place/item still carries the pre-flush
                // token and would 409 against our OWN just-applied first edit —
                // self-conflicting and risking loss of the later edit (#1135).
                const newToken = (entity as { updated_at?: unknown }).updated_at
                if (typeof newToken === 'string') {
                  // In-memory: consulted when the sibling is replayed later in this
                  // same flush (its snapshot still holds the stale base).
                  if (mutation.resource) tokenMap.set(`${mutation.resource}:${realId}`, newToken)
                  // Durable: survives a flush boundary / reload if the sibling is
                  // not reached this pass.
                  assertFlushLease(context)
                  await context.queue
                    .where('tripId')
                    .equals(mutation.tripId)
                    .filter(m =>
                      m.id !== mutation.id &&
                      m.resource === mutation.resource &&
                      m.entityId === realId &&
                      (m.status === 'pending' || m.status === 'syncing'),
                    )
                    .modify(m => { m.baseUpdatedAt = newToken })
                  assertFlushLease(context)
                }
              }
            }
          } else if (mutation.method === 'DELETE' && mutation.resource && reqEntityId !== undefined) {
            // DELETE was already applied optimistically; ensure it's gone
            const table = getTable(mutation.resource, context.tables)
            if (table) {
              assertFlushLease(context)
              await table.delete(reqEntityId)
              assertFlushLease(context)
            }
          }

          assertFlushLease(context)
          await context.queue.delete(mutation.id)
          assertFlushLease(context)
        } catch (err: unknown) {
          if (err instanceof StaleFlushError || !isFlushLeaseValid(context)) throw new StaleFlushError()
          const httpStatus = (err as { response?: { status: number } })?.response?.status

          // 409 = the entity changed on the server since this offline edit was
          // made. This is NOT a dropped change like other 4xx — resolve it per
          // the user's strategy instead of failing it. Deliberately scoped to
          // edits: an offline DELETE is "delete wins" by design (no CAS on the
          // delete path), so it never reaches here. See the wiki Offline doc.
          if (httpStatus === 409 && mutation.method !== 'DELETE') {
            const server = extractConflictServer(err)
            const strategy = getOfflinePrefs().conflictStrategy
            if (strategy === 'server') {
              // Theirs wins: adopt the server's version locally, drop our write.
              assertFlushLease(context)
              await applyServerEntity(mutation, server, context.tables)
              assertFlushLease(context)
              await context.queue.delete(mutation.id)
              assertFlushLease(context)
            } else if (strategy === 'mine') {
              // Mine wins: re-queue without the base token so the next pass
              // overwrites unconditionally.
              assertFlushLease(context)
              await context.queue.update(mutation.id, {
                status: 'pending', baseUpdatedAt: null, conflictServer: undefined,
                attempts: mutation.attempts + 1, lastError: null,
              })
              assertFlushLease(context)
              needsRetry = true
            } else {
              // Ask: park it as a conflict for the user to resolve.
              assertFlushLease(context)
              await context.queue.update(mutation.id, {
                status: 'conflict', conflictServer: server ?? null, conflictAt: Date.now(),
                attempts: mutation.attempts + 1, lastError: 'conflict',
              })
              assertFlushLease(context)
            }
            continue
          }

          const isTerminal =
            httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && !isRetryableStatus(httpStatus)
          if (isTerminal) {
            // Permanent client error — roll back the phantom optimistic CREATE so
            // it can't masquerade as synced, then mark failed and continue.
            if (mutation.method !== 'DELETE' && mutation.tempId !== undefined && mutation.resource) {
              const table = getTable(mutation.resource, context.tables)
              if (table) {
                assertFlushLease(context)
                await table.delete(mutation.tempId)
                assertFlushLease(context)
              }
            }
            assertFlushLease(context)
            await context.queue.update(mutation.id, {
              status: 'failed',
              attempts: mutation.attempts + 1,
              lastError: String(err),
            })
            assertFlushLease(context)
          } else {
            // Network / transient error — reset to pending, abort flush (retry next trigger)
            assertFlushLease(context)
            await context.queue.update(mutation.id, {
              status: 'pending',
              attempts: mutation.attempts + 1,
              lastError: String(err),
            })
            assertFlushLease(context)
            break
          }
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof StaleFlushError)) throw err
    } finally {
      _flushing = false
    }
    // A "mine wins" auto-resolution dropped its base token; one more pass now
    // overwrites the server unconditionally. Bounded: the retried write carries
    // no token, so it cannot 409 for the same reason.
    if (needsRetry && !isEffectivelyOffline() && isFlushLeaseValid(context)) {
      await this.flush()
    }
  },

  /**
   * Return all pending/syncing mutations, optionally filtered by tripId.
   * Used by the UI to show per-item pending indicators.
   */
  async pending(tripId?: number): Promise<QueuedMutation[]> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return []
    const result = tripId !== undefined
      ? await context.queue
        .where('tripId')
        .equals(tripId)
        .filter(m => m.status === 'pending' || m.status === 'syncing')
        .toArray()
      : await context.queue
        .where('status')
        .anyOf(['pending', 'syncing'])
        .toArray()
    if (!isQueueLeaseValid(context)) return []
    return result
  },

  /** Count pending mutations (for banner badge). */
  async pendingCount(): Promise<number> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return 0
    const count = await context.queue
      .where('status')
      .anyOf(['pending', 'syncing'])
      .count()
    return isQueueLeaseValid(context) ? count : 0
  },

  /** Count permanently-failed mutations (surfaced separately so the user knows
   *  changes were dropped — they are NOT folded into pendingCount). */
  async failedCount(): Promise<number> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return 0
    const count = await context.queue
      .where('status')
      .equals('failed')
      .count()
    return isQueueLeaseValid(context) ? count : 0
  },

  /** Count unresolved sync conflicts (offline edits the server rejected as stale). */
  async conflictCount(): Promise<number> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return 0
    const count = await context.queue
      .where('status')
      .equals('conflict')
      .count()
    return isQueueLeaseValid(context) ? count : 0
  },

  /** All unresolved conflicts, newest first, optionally scoped to one trip. */
  async conflicts(tripId?: number): Promise<QueuedMutation[]> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return []
    const all = await context.queue.where('status').equals('conflict').toArray()
    if (!isQueueLeaseValid(context)) return []
    const scoped = tripId === undefined ? all : all.filter(m => m.tripId === tripId)
    return scoped.sort((a, b) => (b.conflictAt ?? 0) - (a.conflictAt ?? 0))
  },

  /**
   * Resolve a conflict by keeping the local (offline) edit: re-queue it without
   * the base token so the next flush overwrites the server unconditionally.
   */
  async resolveKeepMine(id: string): Promise<void> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return
    const m = await context.queue.get(id)
    if (!isQueueLeaseValid(context)) return
    if (!m || m.status !== 'conflict') return
    await context.queue.update(id, {
      status: 'pending', baseUpdatedAt: null, conflictServer: undefined, conflictAt: undefined, lastError: null,
    })
    if (!isQueueLeaseValid(context)) return
    await this.flush()
    if (!isQueueLeaseValid(context)) return
  },

  /**
   * Resolve a conflict by keeping the server's version: adopt it into the local
   * cache and drop the queued write.
   */
  async resolveKeepServer(id: string): Promise<void> {
    const context = captureQueueContext()
    if (!isQueueLeaseValid(context)) return
    const m = await context.queue.get(id)
    if (!isQueueLeaseValid(context)) return
    if (!m || m.status !== 'conflict') return
    await applyServerEntity(m, m.conflictServer, context.tables)
    if (!isQueueLeaseValid(context)) return
    await context.queue.delete(id)
    if (!isQueueLeaseValid(context)) return
  },

  /** Reset internal flushing flag and timestamp counters — useful in tests. */
  _resetFlushing(): void {
    _flushing = false
    _lastTs = 0
    _lastTempId = 0
  },
}
