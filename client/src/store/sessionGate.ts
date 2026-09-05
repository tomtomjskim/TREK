import {
  assertAuthGenerationLeaseValid,
  captureAuthGenerationLease,
  isAuthGenerationLeaseValid,
  type AuthLease,
} from '../sync/authGate'
import {
  assertTripSessionLeaseValid,
  captureTripSessionLease,
  isTripSessionLeaseValid,
  type TripSessionLease,
} from './tripSessionGate'

/** One detachable guard for every async trip-store action. */
export interface StoreSessionLease {
  auth: AuthLease
  trip: TripSessionLease
}

export function captureStoreSessionLease(): StoreSessionLease {
  return {
    auth: captureAuthGenerationLease(),
    trip: captureTripSessionLease(),
  }
}

export function isStoreSessionLeaseValid(lease: StoreSessionLease): boolean {
  return isAuthGenerationLeaseValid(lease.auth) && isTripSessionLeaseValid(lease.trip)
}

export function assertStoreSessionLeaseValid(lease: StoreSessionLease): void {
  assertAuthGenerationLeaseValid(lease.auth)
  assertTripSessionLeaseValid(lease.trip)
}
