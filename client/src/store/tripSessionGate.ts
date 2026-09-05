/** A snapshot of the active trip request/mutation generation. */
export interface TripSessionLease {
  generation: number
}

let tripSessionGeneration = 0
let activeTripIdentity: string | null = null

export class StaleTripSessionError extends Error {
  constructor() {
    super('The active trip changed while the request was in flight')
    this.name = 'StaleTripSessionError'
  }
}

/**
 * Enter a fresh full-load epoch. Even a same-trip full reload supersedes stale
 * optimistic snapshots; reconnect hydration deliberately does not call this
 * while the identity already matches.
 */
export function activateTripSession(tripId: number | string): TripSessionLease {
  tripSessionGeneration += 1
  activeTripIdentity = String(tripId)
  return { generation: tripSessionGeneration }
}

/** Invalidate pending work when the active trip is cleared. */
export function invalidateTripSession(): void {
  tripSessionGeneration += 1
  activeTripIdentity = null
}

/** Bind a mutation to whichever trip is active when the action starts. */
export function captureTripSessionLease(): TripSessionLease {
  return { generation: tripSessionGeneration }
}

export function isTripSessionLeaseValid(lease: TripSessionLease): boolean {
  return lease.generation === tripSessionGeneration
}

export function isActiveTripSession(tripId: number | string): boolean {
  return activeTripIdentity === String(tripId)
}

export function assertTripSessionLeaseValid(lease: TripSessionLease): void {
  if (!isTripSessionLeaseValid(lease)) throw new StaleTripSessionError()
}
