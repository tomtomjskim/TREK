import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AddonsService } from './addons.service';
import { REQUIRE_ADDON, type RequireAddonMeta } from './require-addon.decorator';

/**
 * Request-local proof that the global addon gate already checked this addon.
 * A symbol keeps the marker out of serialized request data and application
 * namespaces; the Set also supports a future request that crosses more than
 * one addon-decorated controller boundary without making route guards query
 * the same toggle again.
 */
export const ADDON_GUARD_PASSED = Symbol('trek:addon-guard-passed');
type AddonRequest = Request & { [ADDON_GUARD_PASSED]?: Set<string> };

/**
 * Enforces @RequireAddon. Replaces the three hand-written addon guards
 * (collections, airtrail, journey), which differed only in which addon id they
 * read and which word led the 404 body.
 *
 * A handler-level @RequireAddon overrides the controller's, so a route group
 * can carry one addon and a single endpoint another. Without the decorator the
 * guard is a no-op — it never gates a route that did not ask for it.
 */
@Injectable()
export class AddonGuard implements CanActivate {
  constructor(
    private readonly addons: AddonsService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<RequireAddonMeta | undefined>(REQUIRE_ADDON, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest<AddonRequest>();
    if (req[ADDON_GUARD_PASSED]?.has(meta.addonId)) return true;

    if (!this.addons.isAddonEnabled(meta.addonId)) {
      throw new HttpException({ error: `${meta.label} addon is not enabled` }, 404);
    }

    if (!req[ADDON_GUARD_PASSED]) {
      Object.defineProperty(req, ADDON_GUARD_PASSED, {
        configurable: true,
        value: new Set<string>(),
      });
    }
    req[ADDON_GUARD_PASSED]!.add(meta.addonId);
    return true;
  }
}
