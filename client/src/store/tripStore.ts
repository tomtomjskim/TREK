import { create } from 'zustand'
import { categoriesApi, tagsApi, tripsApi } from '../api/client'
import { offlineDb } from '../db/offlineDb'
import { budgetRepo } from '../repo/budgetRepo'
import { dayRepo } from '../repo/dayRepo'
import { fileRepo } from '../repo/fileRepo'
import { packingRepo } from '../repo/packingRepo'
import { placeRepo } from '../repo/placeRepo'
import { reservationRepo } from '../repo/reservationRepo'
import { todoRepo } from '../repo/todoRepo'
import { tripRepo } from '../repo/tripRepo'
import {
  assertAuthGenerationLeaseValid,
  captureAuthGenerationLease,
  isAuthGenerationLeaseValid,
  StaleAuthSessionError,
  type AuthLease,
} from '../sync/authGate'
import { isEffectivelyOnline } from '../sync/networkMode'
import type {
  AssignmentsMap,
  BudgetItem,
  Category,
  Day,
  DayNotesMap,
  PackingItem,
  Place,
  Reservation,
  Tag,
  TodoItem,
  Trip,
  TripFile,
  WebSocketEvent,
} from '../types'
import { getApiErrorMessage } from '../types'
import { useAddonStore } from './addonStore'
import { assertStoreSessionLeaseValid, captureStoreSessionLease, isStoreSessionLeaseValid } from './sessionGate'
import type { AssignmentsSlice } from './slices/assignmentsSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import type { BudgetSlice } from './slices/budgetSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import type { DayNotesSlice } from './slices/dayNotesSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import type { DaysSlice } from './slices/daysSlice'
import { createDaysSlice } from './slices/daysSlice'
import type { FilesSlice } from './slices/filesSlice'
import { createFilesSlice } from './slices/filesSlice'
import type { PackingSlice } from './slices/packingSlice'
import { createPackingSlice } from './slices/packingSlice'
import type { PlacesSlice } from './slices/placesSlice'
import { createPlacesSlice } from './slices/placesSlice'
import { handleRemoteEvent } from './slices/remoteEventHandler'
import type { ReservationsSlice } from './slices/reservationsSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import type { TodoSlice } from './slices/todoSlice'
import { createTodoSlice } from './slices/todoSlice'
import {
  activateTripSession,
  captureTripSessionLease,
  invalidateTripSession,
  isActiveTripSession,
  isTripSessionLeaseValid,
  type TripSessionLease,
} from './tripSessionGate'

function isNotFoundError(err: unknown): boolean {
  return (err as { response?: { status?: number } }).response?.status === 404
}

let fullLoadGeneration = 0
let hydrationGeneration = 0
let activeFullLoadGeneration: number | null = null
const pendingAddonFeedWaiters = new Set<() => void>()

function cancelPendingAddonFeedWaiters(): void {
  for (const cancel of Array.from(pendingAddonFeedWaiters)) {
    cancel()
  }
}

interface TripRequestLease {
  requestGeneration: number
  trip: TripSessionLease
}

function startFullTripLoad(tripId: number | string): TripRequestLease {
  cancelPendingAddonFeedWaiters()
  fullLoadGeneration += 1
  hydrationGeneration += 1
  activeFullLoadGeneration = fullLoadGeneration
  return {
    requestGeneration: fullLoadGeneration,
    trip: activateTripSession(tripId),
  }
}

function finishFullTripLoad(requestGeneration: number): void {
  if (activeFullLoadGeneration === requestGeneration) activeFullLoadGeneration = null
}

function startTripHydration(
  tripId: number | string,
  currentTripId: number | null | undefined,
): TripRequestLease | null {
  // A reconnect refresh cannot establish or replace the active trip, and it
  // must not cancel the full load that owns trip/isLoading state.
  if (activeFullLoadGeneration !== null || currentTripId == null || String(currentTripId) !== String(tripId))
    return null
  if (!isActiveTripSession(tripId)) activateTripSession(tripId)
  cancelPendingAddonFeedWaiters()
  hydrationGeneration += 1
  return {
    requestGeneration: hydrationGeneration,
    trip: captureTripSessionLease(),
  }
}

function invalidateTripRequests(): void {
  cancelPendingAddonFeedWaiters()
  fullLoadGeneration += 1
  hydrationGeneration += 1
  activeFullLoadGeneration = null
  invalidateTripSession()
}

function mayApplyFullLoad(request: TripRequestLease, authLease: AuthLease): boolean {
  return (
    request.requestGeneration === fullLoadGeneration &&
    isTripSessionLeaseValid(request.trip) &&
    isAuthGenerationLeaseValid(authLease)
  )
}

function mayApplyHydration(request: TripRequestLease, authLease: AuthLease): boolean {
  return (
    request.requestGeneration === hydrationGeneration &&
    isTripSessionLeaseValid(request.trip) &&
    isAuthGenerationLeaseValid(authLease)
  )
}

function waitForAddonFeedSettled(): Promise<boolean> {
  const addonStore = useAddonStore.getState()
  if (addonStore.loaded) return Promise.resolve(true)

  return new Promise(resolve => {
    let finished = false
    let unsubscribeAddon: (() => void) | null = null
    const finish = (value: boolean) => {
      if (finished) return
      finished = true
      unsubscribeAddon?.()
      pendingAddonFeedWaiters.delete(cancel)
      resolve(value)
    }
    const cancel = () => finish(false)
    pendingAddonFeedWaiters.add(cancel)
    unsubscribeAddon = useAddonStore.subscribe(() => {
      if (useAddonStore.getState().loaded) {
        finish(true)
      }
    })
  })
}

async function loadPackingAndTodoIfEnabled(
  tripId: number | string,
  isCurrent: () => boolean,
): Promise<{ packingItems?: PackingItem[]; todoItems?: TodoItem[] } | null> {
  const settled = await waitForAddonFeedSettled()
  if (!settled || !isCurrent()) return null
  const addonStore = useAddonStore.getState()
  if (!addonStore.isEnabled('packing')) {
    return { packingItems: [], todoItems: [] }
  }

  const [packingResult, todoResult] = await Promise.allSettled([
    packingRepo.list(tripId, isCurrent),
    todoRepo.list(tripId, isCurrent),
  ])
  if (!isCurrent()) return null

  if (packingResult.status === 'rejected' && isNotFoundError(packingResult.reason)) throw packingResult.reason
  if (todoResult.status === 'rejected' && isNotFoundError(todoResult.reason)) throw todoResult.reason

  const addonItems: { packingItems?: PackingItem[]; todoItems?: TodoItem[] } = {}
  if (packingResult.status === 'fulfilled') {
    addonItems.packingItems = packingResult.value.items
  }
  if (todoResult.status === 'fulfilled') {
    addonItems.todoItems = todoResult.value.items
  }
  return addonItems
}

export interface TripStoreState
  extends
    PlacesSlice,
    AssignmentsSlice,
    DaysSlice,
    DayNotesSlice,
    PackingSlice,
    TodoSlice,
    BudgetSlice,
    ReservationsSlice,
    FilesSlice {
  trip: Trip | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  dayNotes: DayNotesMap
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  tags: Tag[]
  categories: Category[]
  budgetItems: BudgetItem[]
  files: TripFile[]
  reservations: Reservation[]
  selectedDayId: number | null
  // Places filter (list + map markers). Lives here, not in the sidebar, so the
  // applied filter and the filter UI can never drift apart when the Plan tab
  // unmounts and remounts (#1541).
  placesFilter: string
  placesCategoryFilter: Set<string>
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | null) => void
  setPlacesFilter: (filter: string) => void
  setPlacesCategoryFilter: (categoryIds: Set<string>) => void
  handleRemoteEvent: (event: WebSocketEvent) => void
  resetTrip: (options?: { clearUserData?: boolean }) => void
  loadTrip: (tripId: number | string) => Promise<void>
  hydrateActiveTrip: (tripId: number | string) => Promise<void>
  refreshDays: (tripId: number | string) => Promise<void>
  updateTrip: (
    tripId: number | string,
    data: Partial<Trip> & { date_shift_mode?: 'keep_bookings' | 'shift_all' },
  ) => Promise<Trip>
  addTag: (data: Partial<Tag> & { name: string }) => Promise<Tag>
  addCategory: (data: Partial<Category> & { name: string }) => Promise<Category>
}

export const useTripStore = create<TripStoreState>((set, get) => ({
  trip: null,
  days: [],
  places: [],
  assignments: {},
  dayNotes: {},
  packingItems: [],
  todoItems: [],
  tags: [],
  categories: [],
  budgetItems: [],
  files: [],
  reservations: [],
  selectedDayId: null,
  placesFilter: 'all',
  placesCategoryFilter: new Set<string>(),
  isLoading: false,
  error: null,

  setSelectedDay: (dayId: number | null) => set({ selectedDayId: dayId }),
  setPlacesFilter: (filter: string) => set({ placesFilter: filter }),
  setPlacesCategoryFilter: (categoryIds: Set<string>) => set({ placesCategoryFilter: categoryIds }),

  handleRemoteEvent: (event: WebSocketEvent) => handleRemoteEvent(set, get, event),

  // Clear every trip-scoped slice so switching trips (or losing access to one)
  // can never leave a previous trip's data visible. Global tags/categories are
  // left intact. Also invalidates any pending trip request so late writes from
  // a stale load/hydration cannot land after a logout or route reset.
  resetTrip: options => {
    invalidateTripRequests()
    set({
      trip: null,
      days: [],
      places: [],
      assignments: {},
      dayNotes: {},
      packingItems: [],
      todoItems: [],
      ...(options?.clearUserData ? { tags: [], categories: [] } : {}),
      budgetItems: [],
      files: [],
      reservations: [],
      selectedDayId: null,
      placesFilter: 'all',
      placesCategoryFilter: new Set<string>(),
      isLoading: false,
      error: null,
    })
  },

  loadTrip: async (tripId: number | string) => {
    const request = startFullTripLoad(tripId)
    const authLease = captureAuthGenerationLease()
    const mayWriteCache = () => mayApplyFullLoad(request, authLease)
    set({
      trip: null,
      days: [],
      places: [],
      assignments: {},
      dayNotes: {},
      packingItems: [],
      todoItems: [],
      tags: [],
      budgetItems: [],
      files: [],
      reservations: [],
      selectedDayId: null,
      placesFilter: 'all',
      placesCategoryFilter: new Set<string>(),
      error: null,
    })
    set({ isLoading: true, error: null })
    try {
      const [tripData, daysData, placesData, budgetData, reservationsData, filesData, tagsData, categoriesData] =
        await Promise.all([
          tripRepo.get(tripId, mayWriteCache),
          dayRepo.list(tripId, mayWriteCache),
          placeRepo.list(tripId, undefined, mayWriteCache),
        // Budget / reservations / files are hydrated here too so the offline
        // path is uniform (no separate tab-gated effects). Non-fatal: a failure
        // in any of these must not blank the whole trip.
          budgetRepo.list(tripId, mayWriteCache).catch(() => ({ items: [] as BudgetItem[] })),
          reservationRepo.list(tripId, mayWriteCache).catch(() => ({ reservations: [] as Reservation[] })),
          fileRepo.list(tripId, mayWriteCache).catch(() => ({ files: [] as TripFile[] })),
        isEffectivelyOnline()
          ? tagsApi.list().catch(() => offlineDb.tags.toArray().then(tags => ({ tags })))
          : offlineDb.tags.toArray().then(tags => ({ tags })),
        isEffectivelyOnline()
          ? categoriesApi.list().catch(() => offlineDb.categories.toArray().then(categories => ({ categories })))
          : offlineDb.categories.toArray().then(categories => ({ categories })),
      ])

      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }

      if (!mayWriteCache()) return
      set({
        trip: tripData.trip,
        days: daysData.days,
        places: placesData.places,
        assignments: assignmentsMap,
        dayNotes: dayNotesMap,
        packingItems: [],
        todoItems: [],
        budgetItems: budgetData.items,
        reservations: reservationsData.reservations,
        files: filesData.files,
        tags: tagsData.tags,
        categories: categoriesData.categories,
        isLoading: false,
      })

      const addonItems = await loadPackingAndTodoIfEnabled(tripId, mayWriteCache)
      if (addonItems && mayWriteCache()) {
        set({
          packingItems: addonItems.packingItems ?? [],
          todoItems: addonItems.todoItems ?? [],
        })
      }
    } catch (err: unknown) {
      if (!mayWriteCache()) return
      const message = err instanceof Error ? err.message : 'Unknown error'
      set({ isLoading: false, error: message })
      throw err
    } finally {
      finishFullTripLoad(request.requestGeneration)
    }
  },

  // Silently re-fetch the active trip's collaborative state into the store after
  // the network comes back (WS reconnect or `online` event) so edits missed while
  // offline appear in place — no splash, no resetTrip. Each resource is
  // best-effort; a failure on one must not wipe the others.
  hydrateActiveTrip: async (tripId: number | string) => {
    const request = startTripHydration(tripId, get().trip?.id)
    if (!request) return
    const authLease = captureAuthGenerationLease()
    const mayWriteCache = () => mayApplyHydration(request, authLease)
    const [daysResult, placesResult, budgetResult, reservationsResult, filesResult] = await Promise.allSettled([
      dayRepo.list(tripId, mayWriteCache),
      placeRepo.list(tripId, undefined, mayWriteCache),
      budgetRepo.list(tripId, mayWriteCache),
      reservationRepo.list(tripId, mayWriteCache),
      fileRepo.list(tripId, mayWriteCache),
    ])
    if (!mayWriteCache()) return
    const daysData = daysResult.status === 'fulfilled' ? daysResult.value : null
    const placesData = placesResult.status === 'fulfilled' ? placesResult.value : null
    const budgetData = budgetResult.status === 'fulfilled' ? budgetResult.value : null
    const reservationsData = reservationsResult.status === 'fulfilled' ? reservationsResult.value : null
    const filesData = filesResult.status === 'fulfilled' ? filesResult.value : null
    const nextState: Partial<TripStoreState> = {}
    if (daysData) {
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      nextState.days = daysData.days
      nextState.assignments = assignmentsMap
      nextState.dayNotes = dayNotesMap
    }
    set(state => ({
      ...nextState,
      places: placesData?.places ?? state.places,
      budgetItems: budgetData?.items ?? state.budgetItems,
      reservations: reservationsData?.reservations ?? state.reservations,
      files: filesData?.files ?? state.files,
    }))
    const addonItems = await loadPackingAndTodoIfEnabled(tripId, mayWriteCache)
    if (addonItems && mayWriteCache()) {
      set(state => ({
        ...('packingItems' in addonItems ? { packingItems: addonItems.packingItems ?? state.packingItems } : {}),
        ...('todoItems' in addonItems ? { todoItems: addonItems.todoItems ?? state.todoItems } : {}),
      }))
    }
    if (!mayWriteCache()) return
    // Accommodations live in planner-local state, not this store — nudge the
    // planner to reload them too (e.g. a trip date change made while offline).
    window.dispatchEvent(new CustomEvent('accommodations:refresh'))
  },

  refreshDays: async (tripId: number | string) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const daysData = await dayRepo.list(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      console.error('Failed to refresh days:', err)
    }
  },

  updateTrip: async (
    tripId: number | string,
    data: Partial<Trip> & { date_shift_mode?: 'keep_bookings' | 'shift_all' },
  ) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await tripsApi.update(tripId, data)
      assertStoreSessionLeaseValid(sessionLease)
      set({ trip: result.trip })
      const daysData = await dayRepo.list(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
      // A date change re-anchors bookings server-side (#1288); the socket echo is
      // suppressed for this client, so pull the fresh reservations here.
      await get().loadReservations(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      return result.trip
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error updating trip'))
    }
  },

  addTag: async (data: Partial<Tag> & { name: string }) => {
    const authLease = captureAuthGenerationLease()
    try {
      const result = await tagsApi.create(data)
      assertAuthGenerationLeaseValid(authLease)
      set(state => ({ tags: [...state.tags, result.tag] }))
      return result.tag
    } catch (err: unknown) {
      if (!isAuthGenerationLeaseValid(authLease)) throw new StaleAuthSessionError()
      throw new Error(getApiErrorMessage(err, 'Error creating tag'))
    }
  },

  addCategory: async (data: Partial<Category> & { name: string }) => {
    const authLease = captureAuthGenerationLease()
    try {
      const result = await categoriesApi.create(data)
      assertAuthGenerationLeaseValid(authLease)
      set(state => ({ categories: [...state.categories, result.category] }))
      return result.category
    } catch (err: unknown) {
      if (!isAuthGenerationLeaseValid(authLease)) throw new StaleAuthSessionError()
      throw new Error(getApiErrorMessage(err, 'Error creating category'))
    }
  },

  ...createPlacesSlice(set, get),
  ...createAssignmentsSlice(set, get),
  ...createDaysSlice(set, get),
  ...createDayNotesSlice(set, get),
  ...createPackingSlice(set, get),
  ...createTodoSlice(set, get),
  ...createBudgetSlice(set, get),
  ...createReservationsSlice(set, get),
  ...createFilesSlice(set, get),
}))
