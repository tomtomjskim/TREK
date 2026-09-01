/**
 * Trip sync manager — seeds Dexie with trip data for offline use.
 *
 * Cache scope: trips where end_date >= today OR end_date is null/empty.
 * Eviction: trips where end_date < today - 7 days.
 * File blobs: all non-photo files (MIME type != image/*) for cached trips.
 *
 * Call syncAll() on:
 *   - login success
 *   - trip list refresh (DashboardPage)
 *   - WS reconnect (phase 7)
 */
import { tripsApi, tagsApi, categoriesApi } from '../api/client'
import {
  offlineDb,
  upsertTrip,
  upsertDays,
  upsertPlaces,
  replacePackingItemsForTrip,
  upsertTodoItems,
  upsertBudgetItems,
  upsertReservations,
  upsertTripFiles,
  upsertAccommodations,
  upsertTripMembers,
  upsertTags,
  upsertCategories,
  upsertSyncMeta,
  clearTripData,
  enforceBlobBudget,
} from '../db/offlineDb'
import { prefetchTilesForTrip } from './tilePrefetcher'
import { captureAuthLease, isAuthLeaseValid, type AuthLease } from './authGate'
import { getOfflinePrefs, isTripOfflineEnabled } from './offlinePrefs'
import { useSettingsStore } from '../store/settingsStore'
import type { Trip, Day, Place, PackingItem, TodoItem, BudgetItem, Reservation, TripFile, Accommodation, TripMember } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TripBundle {
  trip: Trip
  days: Day[]
  places: Place[]
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  budgetItems: BudgetItem[]
  reservations: Reservation[]
  files: TripFile[]
  accommodations: Accommodation[]
  members: TripMember[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Trip dates are plain local calendar dates, so format ours the same way.
// toISOString() would hand back the UTC day and drop an ongoing trip a day
// early west of UTC (and keep a finished one a day too long east of it).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayStr(): string {
  return ymd(new Date())
}

/**
 * Run work once the browser has nothing better to do, with a ceiling so it
 * still happens on browsers without requestIdleCallback (Safari) or in a tab
 * that never goes idle.
 */
function whenIdle(fn: () => void | Promise<void>): void {
  const run = () => { void Promise.resolve(fn()).catch(console.error) }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 2_000)
}

function shouldCache(trip: Trip): boolean {
  if (!trip.end_date) return true            // no end date → cache forever
  return trip.end_date >= todayStr()          // ongoing or future
}

function isStale(trip: Trip): boolean {
  if (!trip.end_date) return false
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  return trip.end_date < ymd(cutoff)
}

function isPhoto(file: TripFile): boolean {
  return file.mime_type.startsWith('image/')
}

// Videos can be hundreds of MB — never prefetch them into the bounded offline
// blob cache, or a single clip would evict the trip's real documents (#823).
function isVideo(file: TripFile): boolean {
  return file.mime_type.startsWith('video/')
}

// ── Core logic ────────────────────────────────────────────────────────────────

/** Fetch bundle + write all entities for one trip into Dexie. */
async function writeWithLease(lease: AuthLease, write: () => Promise<void>): Promise<boolean> {
  if (!isAuthLeaseValid(lease)) return false
  await write()
  return isAuthLeaseValid(lease)
}

async function syncTrip(tripId: number, lease: AuthLease): Promise<void> {
  const bundle = await tripsApi.bundle(tripId) as TripBundle

  // A response can arrive after logout/account switch. Do not let that old
  // response seed the newly selected (anonymous or other-user) Proxy DB.
  if (!isAuthLeaseValid(lease)) return
  if (!await writeWithLease(lease, () => upsertTrip(bundle.trip))) return
  if (!await writeWithLease(lease, () => upsertDays(bundle.days))) return
  if (!await writeWithLease(lease, () => upsertPlaces(bundle.places))) return
  if (!await writeWithLease(lease, () => replacePackingItemsForTrip(tripId, bundle.packingItems))) return
  if (!await writeWithLease(lease, () => upsertTodoItems(bundle.todoItems))) return
  if (!await writeWithLease(lease, () => upsertBudgetItems(bundle.budgetItems))) return
  if (!await writeWithLease(lease, () => upsertReservations(bundle.reservations))) return
  if (!await writeWithLease(lease, () => upsertTripFiles(bundle.files))) return
  if (!await writeWithLease(lease, () => upsertAccommodations(bundle.accommodations || []))) return
  if (!await writeWithLease(lease, () => upsertTripMembers(tripId, bundle.members || []))) return
  await writeWithLease(lease, () => upsertSyncMeta({
    tripId,
    lastSyncedAt: Date.now(),
    status: 'idle',
    tilesBbox: null,
    filesCachedCount: 0,
  }))
}

/** Cache non-photo file blobs for a trip. Fire-and-forget safe. */
async function cacheFilesForTrip(tripId: number, files: TripFile[], lease: AuthLease): Promise<void> {
  const nonPhotos = files.filter(f => f.url && !isPhoto(f) && !isVideo(f))
  // `present` is what syncMeta.filesCachedCount reports (files available
  // offline afterwards); `downloaded` only counts what this run actually wrote.
  let present = 0
  let downloaded = 0

  for (const file of nonPhotos) {
    // A logout mid-loop repoints offlineDb at the anonymous database, so anything
    // written after it would leave the previous account's documents on the device.
    if (!isAuthLeaseValid(lease)) return
    // Skip if already cached
    const existing = await offlineDb.blobCache.get(file.url!)
    if (!isAuthLeaseValid(lease)) return
    if (existing) { present++; continue }

    try {
      const resp = await fetch(file.url!, { credentials: 'include' })
      if (!resp.ok) continue
      const blob = await resp.blob()
      if (!isAuthLeaseValid(lease)) return
      await offlineDb.blobCache.put({ url: file.url!, tripId: file.trip_id, blob, bytes: blob.size, mime: file.mime_type, cachedAt: Date.now() })
      if (!isAuthLeaseValid(lease)) return
      present++
      downloaded++
    } catch {
      // Network failure — skip this file, will retry next sync
    }
  }

  // Keep the blob cache within its size/count budget after adding new files.
  if (downloaded > 0 && isAuthLeaseValid(lease)) await enforceBlobBudget().catch(() => {})

  if (!isAuthLeaseValid(lease)) return
  const meta = await offlineDb.syncMeta.get(tripId)
  if (!isAuthLeaseValid(lease)) return
  if (meta) await upsertSyncMeta({ ...meta, filesCachedCount: present })
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Progress callback payload for a {@link tripSyncManager.prepareForOffline} run. */
export interface PrepareProgress {
  /** Current stage. 'done' fires once at the end. */
  phase: 'trips' | 'files' | 'tiles' | 'done'
  /** 1-based index of the trip currently processed in this phase. */
  current: number
  /** Total trips to process in this phase. */
  total: number
  /** Name of the trip currently processed (for the UI). */
  label?: string
}

let _syncing = false

/**
 * Decide which trips to cache and which to drop, honouring both the date rule
 * and the user's per-trip offline choices (#1135 ask 2). Returns the trips to
 * sync; clears Dexie for stale or user-disabled trips as a side effect.
 */
async function reconcileTrips(trips: Trip[], lease: AuthLease): Promise<Trip[]> {
  if (!isAuthLeaseValid(lease)) return []
  const accessibleIds = new Set(trips.map((trip) => trip.id))
  const cachedTrips = await offlineDb.trips.toArray()
  if (!isAuthLeaseValid(lease)) return []
  const revoked = cachedTrips.filter((trip) => !accessibleIds.has(trip.id))
  const stale = trips.filter(isStale)
  // Trips the user turned off explicitly are evicted regardless of date.
  const disabled = trips.filter(t => !isTripOfflineEnabled(t.id))
  for (const trip of [...revoked, ...stale, ...disabled]) {
    if (!isAuthLeaseValid(lease)) return []
    await clearTripData(trip.id).catch(console.error)
  }
  return trips.filter(t => shouldCache(t) && isTripOfflineEnabled(t.id))
}

export const tripSyncManager = {
  /**
   * Sync all cache-eligible trips.
   * Evicts stale and user-disabled trips. Caches file blobs + map tiles in the
   * background. No-ops when offline.
   */
  async syncAll(): Promise<void> {
    const lease = captureAuthLease()
    if (_syncing || !navigator.onLine || !lease) return
    _syncing = true
    try {
      const { trips } = await tripsApi.list() as { trips: Trip[] }
      const toSync = await reconcileTrips(trips, lease)

      for (const trip of toSync) {
        // The gate is re-read per trip: a logout halfway through must not keep
        // writing the old account's rows into the (now anonymous) offline DB.
        if (!isAuthLeaseValid(lease)) return
        try {
          await syncTrip(trip.id, lease)
        } catch (err) {
          console.error(`[tripSync] failed for trip ${trip.id}:`, err)
        }
      }

      // Cache global user data (tags + categories) — fire-and-forget, so the
      // gate has to be re-read when the response lands, not when it was issued:
      // a logout in between would put these rows in the anonymous database.
      tagsApi.list().then(d => { if (isAuthLeaseValid(lease)) return upsertTags(d.tags) }).catch(() => {})
      categoriesApi.list().then(d => { if (isAuthLeaseValid(lease)) return upsertCategories(d.categories) }).catch(() => {})

      // Cache file blobs + map tiles in background (don't block syncAll)
      const cacheTiles = getOfflinePrefs().cacheTiles
      const tileUrl = useSettingsStore.getState().settings.map_tile_url || undefined
      const cartoKey = useSettingsStore.getState().settings.carto_api_key || undefined
      for (const trip of toSync) {
        if (!isAuthLeaseValid(lease)) return
        const files = await offlineDb.tripFiles.where('trip_id').equals(trip.id).toArray()
        if (!isAuthLeaseValid(lease)) return
        cacheFilesForTrip(trip.id, files, lease).catch(console.error)
      }

      // Map tiles last, and only once the browser goes idle. syncAll runs right
      // after login, where the app is still mounting the first screen — starting
      // a bulk tile download into that leaves the UI waiting behind our own
      // background traffic.
      if (cacheTiles) {
        whenIdle(async () => {
          for (const trip of toSync) {
            if (!isAuthLeaseValid(lease) || !navigator.onLine) return
            const places = await offlineDb.places.where('trip_id').equals(trip.id).toArray()
            if (!isAuthLeaseValid(lease)) return
            await prefetchTilesForTrip(trip.id, places, tileUrl, undefined, cartoKey, lease).catch(console.error)
          }
        })
      }
    } finally {
      _syncing = false
    }
  },

  /**
   * "Prepare for offline" (#1135 ask 1): a fully-awaited sync the user runs while
   * still online so everything they need is guaranteed on-device before they go
   * offline. Unlike syncAll it awaits the file-blob and map-tile downloads up
   * front instead of deferring them to idle time, reports progress, and forces
   * the tile prefetch to run even for a bbox we believe is already cached.
   *
   * Returns the number of trips prepared.
   */
  async prepareForOffline(onProgress?: (p: PrepareProgress) => void): Promise<number> {
    const lease = captureAuthLease()
    if (_syncing || !navigator.onLine || !lease) return 0
    _syncing = true
    try {
      const { trips } = await tripsApi.list() as { trips: Trip[] }
      const toSync = await reconcileTrips(trips, lease)
      const total = toSync.length

      // 1) Trip bundles (structured data).
      let i = 0
      for (const trip of toSync) {
        if (!isAuthLeaseValid(lease)) return 0
        onProgress?.({ phase: 'trips', current: ++i, total, label: trip.title })
        try {
          await syncTrip(trip.id, lease)
        } catch (err) {
          console.error(`[tripSync] prepare failed for trip ${trip.id}:`, err)
        }
      }

      // Global user data (tags + categories) — awaited here.
      await Promise.all([
        tagsApi.list().then(d => { if (isAuthLeaseValid(lease)) return upsertTags(d.tags) }).catch(() => {}),
        categoriesApi.list().then(d => { if (isAuthLeaseValid(lease)) return upsertCategories(d.categories) }).catch(() => {}),
      ])
      if (!isAuthLeaseValid(lease)) return 0

      // 2) File blobs — awaited so "prepared" really means downloaded.
      i = 0
      for (const trip of toSync) {
        if (!isAuthLeaseValid(lease)) return 0
        onProgress?.({ phase: 'files', current: ++i, total, label: trip.title })
        const files = await offlineDb.tripFiles.where('trip_id').equals(trip.id).toArray()
        if (!isAuthLeaseValid(lease)) return 0
        await cacheFilesForTrip(trip.id, files, lease).catch(console.error)
        if (!isAuthLeaseValid(lease)) return 0
      }

      // 3) Map tiles — awaited, and only when the user opted to store them.
      if (getOfflinePrefs().cacheTiles) {
        const tileUrl = useSettingsStore.getState().settings.map_tile_url || undefined
        const cartoKey = useSettingsStore.getState().settings.carto_api_key || undefined
        i = 0
        for (const trip of toSync) {
          if (!isAuthLeaseValid(lease)) return 0
          onProgress?.({ phase: 'tiles', current: ++i, total, label: trip.title })
          const places = await offlineDb.places.where('trip_id').equals(trip.id).toArray()
          if (!isAuthLeaseValid(lease)) return 0
          await prefetchTilesForTrip(trip.id, places, tileUrl, true, cartoKey, lease).catch(console.error)
          if (!isAuthLeaseValid(lease)) return 0
        }
      }

      if (!isAuthLeaseValid(lease)) return 0
      onProgress?.({ phase: 'done', current: total, total })
      return total
    } finally {
      _syncing = false
    }
  },

  /** Reset syncing flag — useful in tests. */
  _resetSyncing(): void {
    _syncing = false
  },
}
