import { reservationsApi } from '../api/client'
import { offlineDb, upsertReservations } from '../db/offlineDb'
import type { Reservation } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const reservationRepo = {
  async list(
    tripId: number | string,
    mayWriteCache: CacheWriteGuard = () => true,
  ): Promise<{ reservations: Reservation[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await reservationsApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await upsertReservations(result.reservations).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        reservations: await offlineDb.reservations.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },
}
