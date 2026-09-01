import { GoogleApiTransportService } from '../../src/nest/google-api-usage/google-api-transport.service';
import { GoogleApiUsageService } from '../../src/nest/google-api-usage/google-api-usage.service';
import type { DatabaseService } from '../../src/nest/database/database.service';

/** Production-equivalent transport for tests backed by the migrated test DB. */
export function meteredGoogleApiTransport(database: DatabaseService): GoogleApiTransportService {
  return new GoogleApiTransportService(new GoogleApiUsageService(database));
}

/**
 * Transport seam for isolated map tests whose DB collaborator is intentionally
 * only a query stub. Billing behavior itself is covered by the usage/transport
 * suites; this keeps endpoint rewriting and request headers on the real path.
 */
export function isolatedGoogleApiTransport(): GoogleApiTransportService {
  return new GoogleApiTransportService({ reserve: () => undefined } as unknown as GoogleApiUsageService);
}
