import { packingRepo } from '../../repo/packingRepo'
import { packingApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { PackingItem } from '../../types'
import { getApiErrorMessage } from '../../types'
import { notify } from '../notify'
import {
  assertStoreSessionLeaseValid,
  captureStoreSessionLease,
  isStoreSessionLeaseValid,
} from '../sessionGate'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface PackingSlice {
  addPackingItem: (tripId: number | string, data: Partial<PackingItem> & { name: string }) => Promise<PackingItem>
  updatePackingItem: (tripId: number | string, id: number, data: Partial<PackingItem>) => Promise<PackingItem>
  deletePackingItem: (tripId: number | string, id: number) => Promise<void>
  togglePackingItem: (tripId: number | string, id: number, checked: boolean) => Promise<void>
  reorderPackingItems: (tripId: number | string, orderedIds: number[]) => Promise<void>
  // Three-tier sharing (#858)
  setPackingItemSharing: (tripId: number | string, id: number, visibility: 'common' | 'personal' | 'shared', recipientIds: number[]) => Promise<void>
  clonePackingItem: (tripId: number | string, id: number) => Promise<void>
  addPackingContributor: (tripId: number | string, id: number) => Promise<void>
  removePackingContributor: (tripId: number | string, id: number, userId: number) => Promise<void>
}

export const createPackingSlice = (set: SetState, get: GetState): PackingSlice => ({
  addPackingItem: async (tripId, data) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingRepo.create(tripId, data as Record<string, unknown> & { name: string })
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ packingItems: [...state.packingItems, result.item] }))
      return result.item
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error adding item'))
    }
  },

  updatePackingItem: async (tripId, id, data) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingRepo.update(tripId, id, data as Record<string, unknown>)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({
        packingItems: state.packingItems.map(item => item.id === id ? result.item : item)
      }))
      return result.item
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error updating item'))
    }
  },

  deletePackingItem: async (tripId, id) => {
    const sessionLease = captureStoreSessionLease()
    const prev = get().packingItems
    set(state => ({ packingItems: state.packingItems.filter(item => item.id !== id) }))
    try {
      await packingRepo.delete(tripId, id)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      set({ packingItems: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting item'))
    }
  },

  togglePackingItem: async (tripId, id, checked) => {
    const sessionLease = captureStoreSessionLease()
    set(state => ({
      packingItems: state.packingItems.map(item =>
        item.id === id ? { ...item, checked: checked ? 1 : 0 } : item
      )
    }))
    try {
      await packingRepo.update(tripId, id, { checked })
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      // The caller fires this optimistically and doesn't await, so rolling back
      // silently would just flip the checkbox with no explanation. Surface it.
      set(state => ({
        packingItems: state.packingItems.map(item =>
          item.id === id ? { ...item, checked: checked ? 0 : 1 } : item
        )
      }))
      notify(getApiErrorMessage(err, 'Error updating item'), 'error')
    }
  },

  reorderPackingItems: async (tripId, orderedIds) => {
    const sessionLease = captureStoreSessionLease()
    const prev = get().packingItems
    // Optimistic reorder: exchange only the slots occupied by requested items.
    // Items omitted from orderedIds (notably Shared items owned by somebody
    // else) remain exactly where the server will leave them after refresh.
    // Unknown and duplicate ids are discarded before filling those slots.
    set(state => {
      const byId = new Map(state.packingItems.map(i => [i.id, i]))
      const uniqueIds = [...new Set(orderedIds)]
      const reordered = uniqueIds
        .map(id => byId.get(id))
        .filter((i): i is PackingItem => i !== undefined)
      const reorderedIds = new Set(reordered.map(item => item.id))
      const occupiedSlots = state.packingItems
        .filter(item => reorderedIds.has(item.id))
        .map(item => item.sort_order)
      const preserveSlots = new Set(occupiedSlots).size === occupiedSlots.length
      let nextIndex = 0
      return {
        packingItems: state.packingItems.map(slot => {
          if (!reorderedIds.has(slot.id)) return slot
          const item = reordered[nextIndex]
          const sortOrder = preserveSlots ? slot.sort_order : nextIndex
          nextIndex += 1
          return { ...item, sort_order: sortOrder }
        }),
      }
    })
    try {
      await packingApi.reorder(tripId, orderedIds)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      set({ packingItems: prev })
      notify(getApiErrorMessage(err, 'Error reordering items'), 'error')
    }
  },

  // ── Three-tier sharing (#858) ──────────────────────────────────────────────
  setPackingItemSharing: async (tripId, id, visibility, recipientIds) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingApi.setSharing(tripId, id, { visibility, recipient_ids: recipientIds })
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ packingItems: state.packingItems.map(i => i.id === id ? result.item : i) }))
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      notify(getApiErrorMessage(err, 'Error updating sharing'), 'error')
      throw err
    }
  },

  clonePackingItem: async (tripId, id) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingApi.clone(tripId, id)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => (state.packingItems.some(i => i.id === result.item.id) ? {} : { packingItems: [...state.packingItems, result.item] }))
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      notify(getApiErrorMessage(err, 'Error copying item'), 'error')
    }
  },

  addPackingContributor: async (tripId, id) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingApi.addContributor(tripId, id)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ packingItems: state.packingItems.map(i => i.id === id ? result.item : i) }))
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      notify(getApiErrorMessage(err, 'Error joining item'), 'error')
    }
  },

  removePackingContributor: async (tripId, id, userId) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await packingApi.removeContributor(tripId, id, userId)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ packingItems: state.packingItems.map(i => i.id === id ? result.item : i) }))
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      notify(getApiErrorMessage(err, 'Error leaving item'), 'error')
    }
  },
})
