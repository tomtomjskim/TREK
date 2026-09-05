import { daysApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Day } from '../../types'
import { getApiErrorMessage } from '../../types'
import { assertStoreSessionLeaseValid, captureStoreSessionLease, isStoreSessionLeaseValid } from '../sessionGate'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface DaysSlice {
  reorderDays: (tripId: number | string, orderedIds: number[]) => Promise<void>
  insertDay: (tripId: number | string, position?: number) => Promise<Day | undefined>
}

export const createDaysSlice = (set: SetState, get: GetState): DaysSlice => ({
  // Move whole days. Day rows stay stable (assignments/notes/bookings ride along
  // by id); only positions change and, on a dated trip, dates stay pinned to
  // their slots while the content moves across them. Optimistically reorder the
  // list, then refresh to pull the server-side re-stamped dates + booking times.
  reorderDays: async (tripId, orderedIds) => {
    const sessionLease = captureStoreSessionLease()
    const prevDays = get().days
    const byId = new Map(prevDays.map(d => [d.id, d]))
    const sortedDates = prevDays.map(d => d.date).filter((d): d is string => !!d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const optimistic = orderedIds
      .map((id, i) => {
        const d = byId.get(id)
        if (!d) return null
        return { ...d, day_number: i + 1, date: sortedDates.length ? (sortedDates[i] ?? null) : d.date }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)

    set({ days: optimistic })

    try {
      await daysApi.reorder(tripId, orderedIds)
      assertStoreSessionLeaseValid(sessionLease)
      await get().refreshDays(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      await get().loadReservations(tripId)
      assertStoreSessionLeaseValid(sessionLease)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      set({ days: prevDays })
      throw new Error(getApiErrorMessage(err, 'Error reordering days'))
    }
  },

  // Insert a new empty day at a 1-based position (omit to append). On a dated
  // trip this extends the trip by one day and re-pins dates server-side.
  insertDay: async (tripId, position) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await daysApi.create(tripId, { position })
      assertStoreSessionLeaseValid(sessionLease)
      await get().refreshDays(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      await get().loadReservations(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      return result.day
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error adding day'))
    }
  },
})
