import { DatabaseService } from '../database/database.service';
import { PHOTO_PROVIDER_REQUIREMENT, type PhotoProviderRequirement } from './require-photo-provider.decorator';
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/** Hides disabled or unknown provider routes before authentication or handlers run. */
@Injectable()
export class PhotoProviderGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<PhotoProviderRequirement | undefined>(PHOTO_PROVIDER_REQUIREMENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;

    const row = this.db.prepare('SELECT enabled FROM photo_providers WHERE id = ?').get(meta.providerId) as
      | { enabled: number }
      | undefined;
    if (row?.enabled !== 1) {
      throw new HttpException({ error: `${meta.label} provider is not enabled` }, 404);
    }
    return true;
  }
}
