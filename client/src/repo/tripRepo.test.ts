// FE-REPO-TRIP-001 to FE-REPO-TRIP-011
import 'fake-indexeddb/auto'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTrip } from '../../tests/helpers/factories'
import { server } from '../../tests/helpers/msw/server'
import { clearAll, offlineDb } from '../db/offlineDb'
import { setAuthed } from '../sync/authGate'
import { tripRepo } from './tripRepo'
import { StaleCacheResponseError } from './withOfflineFallback'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, writable: true, configurable: true })
}

beforeEach(async () => {
  await clearAll()
  setOnline(true)
})

afterEach(() => {
  setAuthed(false)
  vi.restoreAllMocks()
})

describe('tripRepo.list', () => {
  it('FE-REPO-TRIP-001: online — merges active + archived and caches both in Dexie', async () => {
    const active = buildTrip({ title: 'Lisbon' })
    const archived = buildTrip({ title: 'Old Trip', is_archived: 1 })
    server.use(
      http.get('/api/trips', ({ request }) => {
        const isArchived = new URL(request.url).searchParams.get('archived')
        return HttpResponse.json({ trips: isArchived ? [archived] : [active] })
      }),
    )

    const result = await tripRepo.list()
    expect(result.trips.map(t => t.title)).toEqual(['Lisbon'])
    expect(result.archivedTrips.map(t => t.title)).toEqual(['Old Trip'])

    await new Promise(r => setTimeout(r, 0))
    expect(await offlineDb.trips.get(active.id)).toBeDefined()
    expect(await offlineDb.trips.get(archived.id)).toBeDefined()
  })

  it('FE-REPO-TRIP-002: offline — splits the Dexie cache by is_archived', async () => {
    await offlineDb.trips.bulkPut([buildTrip({ id: 71, is_archived: 0 }), buildTrip({ id: 72, is_archived: 1 })])
    setOnline(false)

    let restCalled = false
    server.use(
      http.get('/api/trips', () => {
        restCalled = true
        return HttpResponse.json({ trips: [] })
      }),
    )

    const result = await tripRepo.list()
    expect(result.trips.map(t => t.id)).toEqual([71])
    expect(result.archivedTrips.map(t => t.id)).toEqual([72])
    expect(restCalled).toBe(false)
  })

  it('FE-REPO-TRIP-003: rethrows a server error instead of falling back to the cache', async () => {
    await offlineDb.trips.put(buildTrip({ id: 73 }))
    server.use(http.get('/api/trips', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))

    await expect(tripRepo.list()).rejects.toThrow()
  })
})

describe('tripRepo.get', () => {
  it('FE-REPO-TRIP-004: online — returns the trip and caches it', async () => {
    const trip = buildTrip({ id: 80, title: 'Kyoto' })
    server.use(http.get('/api/trips/80', () => HttpResponse.json({ trip })))

    const result = await tripRepo.get(80)
    expect(result.trip.title).toBe('Kyoto')

    await new Promise(r => setTimeout(r, 0))
    expect((await offlineDb.trips.get(80))!.title).toBe('Kyoto')
  })

  it('FE-REPO-TRIP-005: offline — serves the cached trip', async () => {
    await offlineDb.trips.put(buildTrip({ id: 81, title: 'Cached' }))
    setOnline(false)

    const result = await tripRepo.get('81')
    expect(result.trip.title).toBe('Cached')
  })

  it('FE-REPO-TRIP-006: offline with nothing cached — throws so the caller can show an error', async () => {
    setOnline(false)
    await expect(tripRepo.get(999)).rejects.toThrow('No cached trip data available offline')
  })

  it('FE-REPO-TRIP-007: network-level failure falls back to the cache (captive portal)', async () => {
    await offlineDb.trips.put(buildTrip({ id: 82, title: 'Fallback' }))
    server.use(http.get('/api/trips/82', () => HttpResponse.error()))

    const result = await tripRepo.get(82)
    expect(result.trip.title).toBe('Fallback')
  })

  it('FE-REPO-TRIP-012: waits for the cache write and rejects when auth changes before it commits', async () => {
    const trip = buildTrip({ id: 83, title: 'Delayed cache' })
    const write = deferred<void>()
    const put = vi.spyOn(offlineDb.trips, 'put').mockImplementation(
      (async () => {
        await write.promise
        return trip.id
      }) as unknown as typeof offlineDb.trips.put,
    )
    server.use(http.get('/api/trips/83', () => HttpResponse.json({ trip })))
    setAuthed(true, 1)

    let settled = false
    const request = tripRepo.get(83)
    void request.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
    expect(settled).toBe(false)

    setAuthed(false)
    write.resolve()
    await expect(request).rejects.toBeInstanceOf(StaleCacheResponseError)
  })
})

describe('tripRepo.active', () => {
  // Local calendar dates, like the repo itself.
  function dateOffset(days: number): string {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('FE-REPO-TRIP-008: online — passes the server answer straight through', async () => {
    server.use(
      http.get('/api/trips/active', () =>
      HttpResponse.json({ trip: { id: 90, title: 'Server pick', start_date: null, end_date: null } }),
      ),
    )

    const result = await tripRepo.active()
    expect(result.trip!.id).toBe(90)
  })

  it('FE-REPO-TRIP-009: offline — ranks ongoing over upcoming over past', async () => {
    await offlineDb.trips.put(buildTrip({ id: 91, start_date: dateOffset(-40), end_date: dateOffset(-30) }))
    await offlineDb.trips.put(buildTrip({ id: 92, start_date: dateOffset(10), end_date: dateOffset(14) }))
    await offlineDb.trips.put(buildTrip({ id: 93, start_date: dateOffset(-1), end_date: dateOffset(2) }))
    setOnline(false)

    expect((await tripRepo.active()).trip!.id).toBe(93)

    await offlineDb.trips.delete(93)
    expect((await tripRepo.active()).trip!.id).toBe(92)

    await offlineDb.trips.delete(92)
    expect((await tripRepo.active()).trip!.id).toBe(91)
  })

  it('FE-REPO-TRIP-010: offline — skips archived trips and answers null when nothing is left', async () => {
    await offlineDb.trips.put(
      buildTrip({ id: 94, is_archived: 1, start_date: dateOffset(-1), end_date: dateOffset(2) }),
    )
    setOnline(false)

    expect((await tripRepo.active()).trip).toBeNull()
  })

  it('FE-REPO-TRIP-011: an HTTP error still rejects instead of falling back', async () => {
    await offlineDb.trips.put(buildTrip({ id: 95 }))
    server.use(http.get('/api/trips/active', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))

    await expect(tripRepo.active()).rejects.toThrow()
  })
})
