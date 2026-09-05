import { packingApi } from '../api/client'
import { offlineDb, replacePackingItemsForTrip } from '../db/offlineDb'
import { generateUUID, mutationQueue, nextTempId } from '../sync/mutationQueue'
import { isEffectivelyOffline } from '../sync/networkMode'
import type { PackingItem } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const packingRepo = {
  async list(tripId: number | string, mayWriteCache: CacheWriteGuard = () => true): Promise<{ items: PackingItem[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await packingApi.list(tripId)
        assertCacheWriteAllowed(canWriteCache)
        await replacePackingItemsForTrip(Number(tripId), result.items)
        return result
      },
      async () => ({
        items: await offlineDb.packingItems.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },

  async create(
    tripId: number | string,
    data: Record<string, unknown> & { name: string },
  ): Promise<{ item: PackingItem }> {
    const mayWriteCache = cacheWriteGuard()
    if (isEffectivelyOffline()) {
      const tempId = nextTempId()
      const tempItem: PackingItem = {
        ...(data as Partial<PackingItem>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New item',
        checked: 0,
      } as PackingItem
      await offlineDb.packingItems.put(tempItem)
      assertCacheWriteAllowed(mayWriteCache)
      const id = generateUUID()
      await mutationQueue.enqueue({
        id,
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/packing`,
        body: data,
        resource: 'packingItems',
        tempId,
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { item: tempItem }
    }
    const result = await packingApi.create(tripId, data)
    assertCacheWriteAllowed(mayWriteCache)
    await offlineDb.packingItems.put(result.item).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    const mayWriteCache = cacheWriteGuard()
    const table = offlineDb.packingItems
    if (isEffectivelyOffline()) {
      const existing = await table.get(id)
      assertCacheWriteAllowed(mayWriteCache)
      const optimistic: PackingItem = { ...(existing ?? ({} as PackingItem)), ...(data as Partial<PackingItem>), id }
      await table.put(optimistic)
      assertCacheWriteAllowed(mayWriteCache)
      const mutId = generateUUID()
      const isTemp = id < 0
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'PUT',
        url: isTemp ? `/trips/${tripId}/packing/{id}` : `/trips/${tripId}/packing/${id}`,
        body: data,
        resource: 'packingItems',
        entityId: id,
        baseUpdatedAt: existing?.updated_at ?? null,
        ...(isTemp ? { tempEntityId: id } : {}),
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { item: optimistic }
    }
    const result = await packingApi.update(tripId, id, data)
    assertCacheWriteAllowed(mayWriteCache)
    await table.put(result.item).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    const mayWriteCache = cacheWriteGuard()
    if (isEffectivelyOffline()) {
      await offlineDb.packingItems.delete(id)
      assertCacheWriteAllowed(mayWriteCache)
      const mutId = generateUUID()
      const isTemp = id < 0
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'DELETE',
        url: isTemp ? `/trips/${tripId}/packing/{id}` : `/trips/${tripId}/packing/${id}`,
        body: undefined,
        resource: 'packingItems',
        entityId: id,
        ...(isTemp ? { tempEntityId: id } : {}),
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { success: true }
    }
    const result = await packingApi.delete(tripId, id)
    assertCacheWriteAllowed(mayWriteCache)
    await offlineDb.packingItems.delete(id).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },
}
