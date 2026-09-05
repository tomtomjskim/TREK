import { accommodationsApi } from '../api/client'
import { offlineDb, upsertAccommodations } from '../db/offlineDb'
import type { Accommodation } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache } from './withOfflineFallback'

export const accommodationRepo = {
  async list(tripId: number | string): Promise<{ accommodations: Accommodation[] }> {
    const mayWriteCache = cacheWriteGuard()
    return onlineThenCache(
      async () => {
        const result = await accommodationsApi.list(tripId)
        assertCacheWriteAllowed(mayWriteCache)
        await upsertAccommodations(result.accommodations || []).catch(() => {})
        assertCacheWriteAllowed(mayWriteCache)
        return result
      },
      async () => ({
        accommodations: await offlineDb.accommodations.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },
}
