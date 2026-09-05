import { daysApi } from '../api/client'
import { offlineDb, upsertDays } from '../db/offlineDb'
import type { Day } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const dayRepo = {
  async list(tripId: number | string, mayWriteCache: CacheWriteGuard = () => true): Promise<{ days: Day[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await daysApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await upsertDays(result.days).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        days: (await offlineDb.days
          .where('trip_id')
          .equals(Number(tripId))
          .sortBy('day_number' as keyof Day)) as Day[],
      }),
    )
  },
}
