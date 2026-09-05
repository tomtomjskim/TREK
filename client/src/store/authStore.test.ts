import { http, HttpResponse } from 'msw'
import { waitFor } from '@testing-library/react'
import { server } from '../../tests/helpers/msw/server'
import { resetAllStores, seedStore } from '../../tests/helpers/store'
import { buildDay, buildPackingItem, buildPlace, buildTodoItem, buildTrip } from '../../tests/helpers/factories'
import { useAddonStore } from './addonStore'
import { useAuthStore } from './authStore'
import { useTripStore } from './tripStore'

vi.mock('../db/offlineDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/offlineDb')>()
  return {
    ...actual,
    deleteCurrentUserDb: vi.fn(async () => {}),
    reopenForUser: vi.fn(async () => {}),
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  resetAllStores()
  server.resetHandlers()
  seedStore(useAddonStore, { addons: [], bagTracking: false, loaded: false })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('authStore.logout', () => {
  it('FE-AUTH-001: resetTrip clears a pending trip load and blocks late writes after logout', async () => {
    const tripCore = deferred<Response>()
    let packingCalls = 0
    let todoCalls = 0

    seedStore(useTripStore, {
      trip: buildTrip({ id: 1, title: 'Stale trip' }),
      days: [],
      places: [],
      packingItems: [buildPackingItem({ id: 88, trip_id: 1 })],
      todoItems: [buildTodoItem({ id: 89, trip_id: 1 })],
    })

    server.use(
      http.get('/api/trips/1', () => tripCore.promise),
      http.get('/api/trips/1/days', () => HttpResponse.json({ days: [buildDay({ id: 1, trip_id: 1, day_number: 1 })] })),
      http.get('/api/trips/1/places', () => HttpResponse.json({ places: [buildPlace({ id: 501, trip_id: 1 })] })),
      http.get('/api/trips/1/packing', () => {
        packingCalls += 1
        return HttpResponse.json({ items: [buildPackingItem({ id: 611, trip_id: 1 })] })
      }),
      http.get('/api/trips/1/todo', () => {
        todoCalls += 1
        return HttpResponse.json({ items: [buildTodoItem({ id: 711, trip_id: 1 })] })
      }),
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/reservations', () => HttpResponse.json({ reservations: [] })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
      http.get('/api/tags', () => HttpResponse.json({ tags: [] })),
      http.get('/api/categories', () => HttpResponse.json({ categories: [] })),
    )

    const loadPromise = useTripStore.getState().loadTrip(1)
    await waitFor(() => expect(useTripStore.getState().isLoading).toBe(true))

    const logoutPromise = useAuthStore.getState().logout()
    tripCore.resolve(HttpResponse.json({ trip: buildTrip({ id: 1, title: 'Fresh trip' }) }))
    useAddonStore.setState({
      addons: [{ id: 'packing', name: 'Packing', type: 'packing', icon: 'package', enabled: true }],
      bagTracking: false,
      loaded: true,
    })

    await expect(loadPromise).resolves.toBeUndefined()
    await expect(logoutPromise).resolves.toBeUndefined()

    const state = useTripStore.getState()
    expect(state.trip).toBeNull()
    expect(state.packingItems).toEqual([])
    expect(state.todoItems).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(packingCalls).toBe(0)
    expect(todoCalls).toBe(0)
  })
})
