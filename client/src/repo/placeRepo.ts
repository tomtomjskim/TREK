import { placesApi } from '../api/client'
import { offlineDb, upsertPlaces } from '../db/offlineDb'
import { generateUUID, mutationQueue, nextTempId } from '../sync/mutationQueue'
import { isEffectivelyOffline } from '../sync/networkMode'
import type { Place } from '../types'
import { assertCacheWriteAllowed, cacheWriteGuard, onlineThenCache, type CacheWriteGuard } from './withOfflineFallback'

export const placeRepo = {
  async list(
    tripId: number | string,
    params?: Record<string, unknown>,
    mayWriteCache: CacheWriteGuard = () => true,
  ): Promise<{ places: Place[] }> {
    const canWriteCache = cacheWriteGuard(mayWriteCache)
    return onlineThenCache(
      async () => {
        const result = await placesApi.list(tripId, params)
        assertCacheWriteAllowed(canWriteCache)
        await upsertPlaces(result.places).catch(() => {})
        assertCacheWriteAllowed(canWriteCache)
        return result
      },
      async () => ({
        places: await offlineDb.places.where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },

  async create(tripId: number | string, data: Record<string, unknown> & { name: string }): Promise<{ place: Place }> {
    const mayWriteCache = cacheWriteGuard()
    if (isEffectivelyOffline()) {
      const tempId = nextTempId()
      const tempPlace: Place = {
        ...(data as Partial<Place>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New place',
      } as Place
      await offlineDb.places.put(tempPlace)
      assertCacheWriteAllowed(mayWriteCache)
      const id = generateUUID()
      await mutationQueue.enqueue({
        id,
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/places`,
        body: data,
        resource: 'places',
        tempId,
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { place: tempPlace }
    }
    const result = await placesApi.create(tripId, data)
    assertCacheWriteAllowed(mayWriteCache)
    await offlineDb.places.put(result.place).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },

  async update(tripId: number | string, id: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    const mayWriteCache = cacheWriteGuard()
    const table = offlineDb.places
    if (isEffectivelyOffline()) {
      const existing = await table.get(Number(id))
      assertCacheWriteAllowed(mayWriteCache)
      // trip_id has to be there even when nothing was cached: every read goes
      // through places.where('trip_id'), and clearTripData() evicts by it too —
      // a row without it is invisible and never cleaned up.
      const optimistic: Place = {
        ...(existing ?? ({} as Place)),
        ...(data as Partial<Place>),
        id: Number(id),
        trip_id: Number(tripId),
      }
      await table.put(optimistic)
      assertCacheWriteAllowed(mayWriteCache)
      const mutId = generateUUID()
      const isTemp = Number(id) < 0
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'PUT',
        url: isTemp ? `/trips/${tripId}/places/{id}` : `/trips/${tripId}/places/${id}`,
        body: data,
        resource: 'places',
        entityId: Number(id),
        baseUpdatedAt: existing?.updated_at ?? null,
        ...(isTemp ? { tempEntityId: Number(id) } : {}),
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { place: optimistic }
    }
    const result = await placesApi.update(tripId, id, data)
    assertCacheWriteAllowed(mayWriteCache)
    await table.put(result.place).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },

  async delete(tripId: number | string, id: number | string): Promise<unknown> {
    const mayWriteCache = cacheWriteGuard()
    if (isEffectivelyOffline()) {
      await offlineDb.places.delete(Number(id))
      assertCacheWriteAllowed(mayWriteCache)
      const mutId = generateUUID()
      const isTemp = Number(id) < 0
      await mutationQueue.enqueue({
        id: mutId,
        tripId: Number(tripId),
        method: 'DELETE',
        url: isTemp ? `/trips/${tripId}/places/{id}` : `/trips/${tripId}/places/${id}`,
        body: undefined,
        resource: 'places',
        entityId: Number(id),
        ...(isTemp ? { tempEntityId: Number(id) } : {}),
      })
      assertCacheWriteAllowed(mayWriteCache)
      return { success: true }
    }
    const result = await placesApi.delete(tripId, id)
    assertCacheWriteAllowed(mayWriteCache)
    await offlineDb.places.delete(Number(id)).catch(() => {})
    assertCacheWriteAllowed(mayWriteCache)
    return result
  },

  async deleteMany(tripId: number | string, ids: number[]): Promise<unknown> {
    const mayWriteCache = cacheWriteGuard()
    if (isEffectivelyOffline()) {
      await offlineDb.places.bulkDelete(ids)
      assertCacheWriteAllowed(mayWriteCache)
      for (const id of ids) {
        const mutId = generateUUID()
        const isTemp = id < 0
        await mutationQueue.enqueue({
          id: mutId,
          tripId: Number(tripId),
          method: 'DELETE',
          url: isTemp ? `/trips/${tripId}/places/{id}` : `/trips/${tripId}/places/${id}`,
          body: undefined,
          resource: 'places',
          entityId: id,
          ...(isTemp ? { tempEntityId: id } : {}),
        })
        assertCacheWriteAllowed(mayWriteCache)
      }
      return { deleted: ids, count: ids.length }
    }
    const result = await placesApi.bulkDelete(tripId, ids)
    assertCacheWriteAllowed(mayWriteCache)
    await offlineDb.places.bulkDelete(ids)
    return result
  },

  async updateMany(
    tripId: number | string,
    ids: number[],
    data: Record<string, unknown>,
  ): Promise<{ updated: number[]; count: number }> {
    const mayWriteCache = cacheWriteGuard()
    const table = offlineDb.places
    if (isEffectivelyOffline()) {
      // Offline fans out one queued PUT per id (mirrors deleteMany's DELETE fan-out).
      for (const id of ids) {
        const existing = await table.get(id)
        assertCacheWriteAllowed(mayWriteCache)
        if (existing) await table.put({ ...existing, ...(data as Partial<Place>) })
        assertCacheWriteAllowed(mayWriteCache)
        const mutId = generateUUID()
        const isTemp = id < 0
        await mutationQueue.enqueue({
          id: mutId,
          tripId: Number(tripId),
          method: 'PUT',
          url: isTemp ? `/trips/${tripId}/places/{id}` : `/trips/${tripId}/places/${id}`,
          body: data,
          resource: 'places',
          entityId: id,
          baseUpdatedAt: existing?.updated_at ?? null,
          ...(isTemp ? { tempEntityId: id } : {}),
        })
        assertCacheWriteAllowed(mayWriteCache)
      }
      return { updated: ids, count: ids.length }
    }
    const result = await placesApi.bulkUpdate(tripId, ids, data as Parameters<typeof placesApi.bulkUpdate>[2])
    assertCacheWriteAllowed(mayWriteCache)
    const cached = await table.bulkGet(ids)
    assertCacheWriteAllowed(mayWriteCache)
    await table.bulkPut(cached.filter(Boolean).map(p => ({ ...(p as Place), ...(data as Partial<Place>) })))
    return result
  },
}
