import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import {
  buildCategory,
  buildDay,
  buildPackingItem,
  buildPlace,
  buildTodoItem,
  buildTrip,
  buildUser,
} from '../../tests/helpers/factories'
import { server } from '../../tests/helpers/msw/server'
import { resetAllStores, seedStore } from '../../tests/helpers/store'
import { authApi } from '../api/client'
import { upsertTrip } from '../db/offlineDb'
import { setAuthed } from '../sync/authGate'
import { useAddonStore } from './addonStore'
import { beginExternalAuthAttempt, useAuthStore } from './authStore'
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore'
import { useTripStore } from './tripStore'

const dbControl = vi.hoisted(() => ({
  deleteGate: null as Promise<void> | null,
}))

const dbMocks = vi.hoisted(() => ({
  upsertTrip: vi.fn(async () => {}),
  deleteCurrentUserDb: vi.fn(async () => {
    await dbControl.deleteGate
  }),
  reopenForUser: vi.fn(async () => {}),
}))

vi.mock('../db/offlineDb', async importOriginal => {
  const actual = await importOriginal<typeof import('../db/offlineDb')>()
  return {
    ...actual,
    ...dbMocks,
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetAllStores()
  server.resetHandlers()
  vi.clearAllMocks()
  dbControl.deleteGate = null
  localStorage.removeItem('trek_pending_server_logout')
  seedStore(useAddonStore, { addons: [], bagTracking: false, loaded: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  )
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
      http.get('/api/trips/1/days', () =>
        HttpResponse.json({ days: [buildDay({ id: 1, trip_id: 1, day_number: 1 })] }),
      ),
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
    expect(vi.mocked(upsertTrip)).not.toHaveBeenCalled()
  })

  it('FE-AUTH-002: a login started during logout waits for DB teardown and remains signed in', async () => {
    const logoutGate = deferred<Response>()
    const deleteGate = deferred<void>()
    const nextUser = buildUser({ id: 2, email: 'next@example.test' })
    const loginRequest = vi.spyOn(authApi, 'login').mockResolvedValue({ user: nextUser, token: 'next-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => logoutGate.promise),
    )
    dbControl.deleteGate = deleteGate.promise
    seedStore(useAuthStore, {
      user: buildUser({ id: 1, email: 'old@example.test' }),
      isAuthenticated: true,
    })

    const logoutPromise = useAuthStore.getState().logout()
    const loginPromise = useAuthStore.getState().login(nextUser.email, 'password')

    // An auth attempt must not open a new user's DB while the old user's DB is
    // still the target of logout teardown.
    expect(loginRequest).not.toHaveBeenCalled()

    logoutGate.resolve(new Response(null, { status: 204 }))
    deleteGate.resolve()
    await expect(logoutPromise).resolves.toBeUndefined()
    await expect(loginPromise).resolves.toEqual({ user: nextUser, token: 'next-token' })

    expect(loginRequest).toHaveBeenCalledOnce()
    expect(dbMocks.deleteCurrentUserDb).toHaveBeenCalledOnce()
    expect(dbMocks.reopenForUser).toHaveBeenCalledWith(nextUser.id)
    expect(useAuthStore.getState()).toMatchObject({
      user: nextUser,
      isAuthenticated: true,
      loggingOut: false,
    })
  })

  it('FE-AUTH-003: a profile response from before logout cannot restore the old user', async () => {
    const oldUser = buildUser({ id: 1, username: 'old-user' })
    const profileResponse = deferred<{ user: typeof oldUser }>()
    vi.spyOn(authApi, 'updateSettings').mockReturnValue(profileResponse.promise)
    seedStore(useAuthStore, { user: oldUser, isAuthenticated: true })

    const pendingUpdate = useAuthStore.getState().updateProfile({ username: 'late-old-user' })
    await useAuthStore.getState().logout()
    profileResponse.resolve({ user: { ...oldUser, username: 'late-old-user' } })

    await expect(pendingUpdate).rejects.toThrow('authentication session changed')
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('FE-AUTH-004: an external auth attempt is registered before a same-tick logout can cancel it', async () => {
    const pendingAttempt = beginExternalAuthAttempt()
    expect(pendingAttempt).not.toBeInstanceOf(Promise)
    const attempt = await Promise.resolve(pendingAttempt)

    const logout = useAuthStore.getState().logout()
    expect(attempt.isCurrent()).toBe(false)
    expect(attempt.signal.aborted).toBe(true)
    await logout
  })

  it('FE-AUTH-005: a non-critical browser-storage failure cannot skip server or DB teardown', async () => {
    const oldUser = buildUser({ id: 1 })
    seedStore(useAuthStore, { user: oldUser, isAuthenticated: true })
    setAuthed(true, oldUser.id)
    const storageLength = vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(dbMocks.deleteCurrentUserDb).toHaveBeenCalledOnce()
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false })
    storageLength.mockRestore()
  })

  it('FE-AUTH-006: a current /me 401 invalidates auth and trip leases before late responses return', async () => {
    const oldUser = buildUser({ id: 1, username: 'expired-user' })
    const profileResponse = deferred<{ user: typeof oldUser }>()
    vi.spyOn(authApi, 'me').mockRejectedValue({ response: { status: 401 } })
    vi.spyOn(authApi, 'updateSettings').mockReturnValue(profileResponse.promise)
    seedStore(useAuthStore, { user: oldUser, isAuthenticated: true })
    seedStore(useTripStore, {
      trip: buildTrip({ id: 11 }),
      categories: [buildCategory({ id: 7, name: 'Expired account category' })],
    })
    setAuthed(true, oldUser.id)

    const pendingUpdate = useAuthStore.getState().updateProfile({ username: 'late-user' })
    await expect(useAuthStore.getState().loadUser()).resolves.toBe(true)
    profileResponse.resolve({ user: { ...oldUser, username: 'late-user' } })

    await expect(pendingUpdate).rejects.toThrow('authentication session changed')
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false })
    expect(useTripStore.getState().trip).toBeNull()
    expect(useTripStore.getState().categories).toEqual([])
  })

  it('FE-AUTH-007: logout clears account settings, tags, capability flags, and every map cache', async () => {
    const cacheDelete = vi.fn(async (_name: string) => true)
    vi.stubGlobal('caches', { delete: cacheDelete })
    const oldUser = buildUser({ id: 1 })
    seedStore(useAuthStore, { user: oldUser, isAuthenticated: true, hasMapsKey: true })
    seedStore(useSettingsStore, {
      settings: {
        ...DEFAULT_SETTINGS,
        carto_api_key: 'account-a-carto',
        mapbox_access_token: 'account-a-mapbox',
        map_provider: 'mapbox-gl',
      },
      isLoaded: true,
    })
    seedStore(useTripStore, {
      tags: [{ id: 9, name: 'Account A', color: '#fff' }],
      categories: [buildCategory({ id: 8, name: 'Account A category' })],
    })
    setAuthed(true, oldUser.id)

    await useAuthStore.getState().logout()

    expect(useAuthStore.getState().hasMapsKey).toBe(false)
    expect(useSettingsStore.getState()).toMatchObject({
      isLoaded: false,
      settings: { carto_api_key: '', mapbox_access_token: '', map_provider: 'leaflet' },
    })
    expect(useTripStore.getState().tags).toEqual([])
    expect(useTripStore.getState().categories).toEqual([])
    expect(cacheDelete.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'api-data',
        'user-uploads',
        'map-tiles',
        'gl-map-styles',
        'mapbox-tiles',
        'gl-map-offline',
      ]),
    )
  })

  it('FE-AUTH-008: a black-holed logout times out, releases teardown, and is retried before the next login', async () => {
    vi.useFakeTimers()
    const oldUser = buildUser({ id: 1 })
    seedStore(useAuthStore, { user: oldUser, isAuthenticated: true })
    setAuthed(true, oldUser.id)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )

    const logout = useAuthStore.getState().logout()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(logout).resolves.toBeUndefined()
    expect(localStorage.getItem('trek_pending_server_logout')).toBe('1')
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false })

    vi.useRealTimers()
    const retryFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', retryFetch)
    const nextUser = buildUser({ id: 2 })
    vi.spyOn(authApi, 'login').mockResolvedValue({ user: nextUser, token: 'next-token' })
    vi.spyOn(authApi, 'getAppConfig').mockResolvedValue({ has_maps_key: false } as never)

    await expect(useAuthStore.getState().login(nextUser.email, 'password')).resolves.toMatchObject({ user: nextUser })
    expect(retryFetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(localStorage.getItem('trek_pending_server_logout')).toBeNull()
  })
})
