import { filesApi } from '../api/client'
import { offlineDb, upsertTripFiles } from '../db/offlineDb'
import type { TripFile } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const fileRepo = {
  async list(tripId: number | string, mayWriteCache: CacheWriteGuard = () => true): Promise<{ files: TripFile[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await filesApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await upsertTripFiles(result.files).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        files: await offlineDb.tripFiles.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },
}
