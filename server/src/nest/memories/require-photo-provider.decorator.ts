import { SetMetadata } from '@nestjs/common';

export const PHOTO_PROVIDER_REQUIREMENT = 'trek:require-photo-provider';

export interface PhotoProviderRequirement {
  providerId: string;
  /** Leads the 404 body: `${label} provider is not enabled`. */
  label: string;
}

/**
 * Gate a provider controller on its admin-managed photo provider row.
 * Pair this with PhotoProviderGuard before JwtAuthGuard so disabled providers
 * are hidden from anonymous callers just like disabled addons.
 */
export const RequirePhotoProvider = (providerId: string, label: string) =>
  SetMetadata<string, PhotoProviderRequirement>(PHOTO_PROVIDER_REQUIREMENT, { providerId, label });
