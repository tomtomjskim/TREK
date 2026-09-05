import { budgetApi } from '../../api/client'
import { budgetRepo } from '../../repo/budgetRepo'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { BudgetItem, BudgetItemMember } from '../../types'
import type { BudgetCreateItemRequest, BudgetUpdateItemRequest } from '@trek/shared'
import { getApiErrorMessage } from '../../types'
import { notify } from '../notify'
import { assertStoreSessionLeaseValid, captureStoreSessionLease, isStoreSessionLeaseValid } from '../sessionGate'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface BudgetSlice {
  loadBudgetItems: (tripId: number | string) => Promise<void>
  addBudgetItem: (tripId: number | string, data: BudgetCreateItemRequest) => Promise<BudgetItem>
  updateBudgetItem: (tripId: number | string, id: number, data: BudgetUpdateItemRequest) => Promise<BudgetItem>
  deleteBudgetItem: (tripId: number | string, id: number) => Promise<void>
  setBudgetItemMembers: (tripId: number | string, itemId: number, userIds: number[]) => Promise<{ members: BudgetItemMember[]; item: BudgetItem }>
  toggleBudgetMemberPaid: (tripId: number | string, itemId: number, userId: number, paid: boolean) => Promise<void>
  reorderBudgetItems: (tripId: number | string, orderedIds: number[]) => Promise<void>
  reorderBudgetCategories: (tripId: number | string, orderedCategories: string[]) => Promise<void>
}

export const createBudgetSlice = (set: SetState, get: GetState): BudgetSlice => ({
  loadBudgetItems: async (tripId) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const data = await budgetRepo.list(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      set({ budgetItems: data.items })
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      console.error('Failed to load budget items:', err)
    }
  },

  addBudgetItem: async (tripId, data) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await budgetApi.create(tripId, data)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ budgetItems: [...state.budgetItems, result.item] }))
      return result.item
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error adding budget item'))
    }
  },

  updateBudgetItem: async (tripId, id, data) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await budgetApi.update(tripId, id, data)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({
        budgetItems: state.budgetItems.map(item => item.id === id ? result.item : item)
      }))
      if (result.item.reservation_id && data.total_price !== undefined) {
        assertStoreSessionLeaseValid(sessionLease)
        get().loadReservations(tripId)
        assertStoreSessionLeaseValid(sessionLease)
      }
      assertStoreSessionLeaseValid(sessionLease)
      return result.item
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error updating budget item'))
    }
  },

  deleteBudgetItem: async (tripId, id) => {
    const sessionLease = captureStoreSessionLease()
    const prev = get().budgetItems
    set(state => ({ budgetItems: state.budgetItems.filter(item => item.id !== id) }))
    try {
      await budgetApi.delete(tripId, id)
      assertStoreSessionLeaseValid(sessionLease)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      set({ budgetItems: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting budget item'))
    }
  },

  setBudgetItemMembers: async (tripId, itemId, userIds) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const result = await budgetApi.setMembers(tripId, itemId, userIds);
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({
        budgetItems: state.budgetItems.map(item =>
          item.id === itemId ? { ...item, members: result.members, persons: result.item.persons } : item
        )
      }));
      return result;
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error updating budget members'))
    }
  },

  toggleBudgetMemberPaid: async (tripId, itemId, userId, paid) => {
    const sessionLease = captureStoreSessionLease()
    try {
      await budgetApi.togglePaid(tripId, itemId, userId, paid);
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({
        budgetItems: state.budgetItems.map(item =>
          item.id === itemId
            // The server persists `paid` as 0/1 and broadcasts the same 0/1 over
            // WebSocket, so the optimistic write normalises the boolean toggle to
            // that numeric contract instead of parking a boolean under a cast.
            ? { ...item, members: (item.members || []).map(m => m.user_id === userId ? { ...m, paid: paid ? 1 : 0 } : m) }
            : item
        )
      }));
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      throw new Error(getApiErrorMessage(err, 'Error updating budget member'))
    }
  },

  reorderBudgetItems: async (tripId, orderedIds) => {
    const sessionLease = captureStoreSessionLease()
    // Optimistic: reorder locally
    set(state => {
      const byId = new Map(state.budgetItems.map(i => [i.id, i]))
      // Drop unknown ids before reindexing, otherwise a stale id leaves a gap
      // in the local sort_order sequence.
      const reordered = orderedIds
        .map(id => byId.get(id))
        .filter((i): i is BudgetItem => i !== undefined)
        .map((item, idx): BudgetItem => ({ ...item, sort_order: idx }))
      // Keep items not in orderedIds at the end
      const remaining = state.budgetItems.filter(i => !orderedIds.includes(i.id))
      return { budgetItems: [...reordered, ...remaining] }
    })
    try {
      await budgetApi.reorderItems(tripId, orderedIds)
      assertStoreSessionLeaseValid(sessionLease)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      // Reload on failure to restore the server's ordering, and tell the user
      // their reorder didn't stick (the caller fires this without awaiting, so
      // a failing reload must not escape as an unhandled rejection).
      try {
        const data = await budgetApi.list(tripId)
        assertStoreSessionLeaseValid(sessionLease)
        set({ budgetItems: data.items })
      } catch {
        if (!isStoreSessionLeaseValid(sessionLease)) return
        /* offline too — the next successful load restores the order */
      }
      if (!isStoreSessionLeaseValid(sessionLease)) return
      notify(getApiErrorMessage(err, 'Error reordering budget items'), 'error')
    }
  },

  reorderBudgetCategories: async (tripId, orderedCategories) => {
    const sessionLease = captureStoreSessionLease()
    // Optimistic: reorder items by new category order (Map preserves insertion order for numeric keys)
    set(state => {
      const grouped = new Map<string, BudgetItem[]>()
      for (const item of state.budgetItems) {
        const cat = item.category || 'Other'
        if (!grouped.has(cat)) grouped.set(cat, [])
        grouped.get(cat)!.push(item)
      }
      const reordered: BudgetItem[] = []
      for (const cat of orderedCategories) {
        const items = grouped.get(cat)
        if (items) reordered.push(...items)
      }
      for (const [cat, items] of grouped) {
        if (!orderedCategories.includes(cat)) reordered.push(...items)
      }
      return { budgetItems: reordered }
    })
    try {
      await budgetApi.reorderCategories(tripId, orderedCategories)
      assertStoreSessionLeaseValid(sessionLease)
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      // Reload on failure to restore the server's ordering, and tell the user
      // their reorder didn't stick (the caller fires this without awaiting, so
      // a failing reload must not escape as an unhandled rejection).
      try {
        const data = await budgetApi.list(tripId)
        assertStoreSessionLeaseValid(sessionLease)
        set({ budgetItems: data.items })
      } catch {
        if (!isStoreSessionLeaseValid(sessionLease)) return
        /* offline too — the next successful load restores the order */
      }
      if (!isStoreSessionLeaseValid(sessionLease)) return
      notify(getApiErrorMessage(err, 'Error reordering budget items'), 'error')
    }
  },
})
