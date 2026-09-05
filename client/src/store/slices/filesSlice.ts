import { filesApi } from '../../api/client'
import { fileRepo } from '../../repo/fileRepo'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { TripFile } from '../../types'
import { getApiErrorMessage } from '../../types'
import { assertStoreSessionLeaseValid, captureStoreSessionLease, isStoreSessionLeaseValid } from '../sessionGate'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface FilesSlice {
  loadFiles: (tripId: number | string) => Promise<void>
  addFile: (tripId: number | string, formData: FormData) => Promise<TripFile>
  deleteFile: (tripId: number | string, id: number) => Promise<void>
}

export const createFilesSlice = (set: SetState, get: GetState): FilesSlice => ({
  loadFiles: async (tripId) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const data = await fileRepo.list(tripId)
      assertStoreSessionLeaseValid(sessionLease)
      set({ files: data.files })
    } catch (err: unknown) {
      if (!isStoreSessionLeaseValid(sessionLease)) return
      console.error('Failed to load files:', err)
    }
  },

  addFile: async (tripId, formData) => {
    const sessionLease = captureStoreSessionLease()
    try {
      const data = await filesApi.upload(tripId, formData)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ files: [data.file, ...state.files] }))
      return data.file
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error uploading file'))
    }
  },

  deleteFile: async (tripId, id) => {
    const sessionLease = captureStoreSessionLease()
    try {
      await filesApi.delete(tripId, id)
      assertStoreSessionLeaseValid(sessionLease)
      set(state => ({ files: state.files.filter(f => f.id !== id) }))
    } catch (err: unknown) {
      assertStoreSessionLeaseValid(sessionLease)
      throw new Error(getApiErrorMessage(err, 'Error deleting file'))
    }
  },
})
