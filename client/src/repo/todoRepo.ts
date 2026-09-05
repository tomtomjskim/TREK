import { todoApi } from '../api/client'
import { offlineDb, upsertTodoItems } from '../db/offlineDb'
import type { TodoItem } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const todoRepo = {
  async list(tripId: number | string, mayWriteCache: CacheWriteGuard = () => true): Promise<{ items: TodoItem[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await todoApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await upsertTodoItems(result.items).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        items: await offlineDb.todoItems.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },
}
