import { budgetApi } from '../api/client'
import { offlineDb, upsertBudgetItems } from '../db/offlineDb'
import type { BudgetItem } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const budgetRepo = {
  async list(tripId: number | string, mayWriteCache: CacheWriteGuard = () => true): Promise<{ items: BudgetItem[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await budgetApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await upsertBudgetItems(result.items).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        items: await offlineDb.budgetItems.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },
}
