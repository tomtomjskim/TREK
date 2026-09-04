import { AddonGuard } from '../../../src/nest/addons/addon.guard';
import { JwtAuthGuard } from '../../../src/nest/auth/jwt-auth.guard';
import { ImmichMemoriesController } from '../../../src/nest/memories/immich.controller';
import { PhotoProviderGuard } from '../../../src/nest/memories/photo-provider.guard';
import {
  PHOTO_PROVIDER_REQUIREMENT,
  RequirePhotoProvider,
  type PhotoProviderRequirement,
} from '../../../src/nest/memories/require-photo-provider.decorator';
import { SynologyMemoriesController } from '../../../src/nest/memories/synology.controller';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { describe, expect, it, vi } from 'vitest';

function ctxFor(handler: object, cls: object = class {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

function thrown(fn: () => unknown) {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof HttpException ? { status: err.getStatus(), body: err.getResponse() } : err;
  }
}

function decorated(providerId: string, label: string) {
  class Gated {}
  RequirePhotoProvider(providerId, label)(Gated);
  return Gated;
}

function dbWith(enabled: number | undefined) {
  const get = vi.fn(() => (enabled === undefined ? undefined : { enabled }));
  return { db: { prepare: vi.fn(() => ({ get })) }, get };
}

describe('PhotoProviderGuard', () => {
  it('PHOTO-PROVIDER-GUARD-001: is a no-op without provider metadata', () => {
    const { db, get } = dbWith(0);
    const guard = new PhotoProviderGuard(db as never, new Reflector());

    expect(guard.canActivate(ctxFor(() => {}, class {}))).toBe(true);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('PHOTO-PROVIDER-GUARD-002: passes an enabled provider and asks for its exact id', () => {
    const { db, get } = dbWith(1);
    const guard = new PhotoProviderGuard(db as never, new Reflector());
    const cls = decorated('immich', 'Immich');

    expect(guard.canActivate(ctxFor(() => {}, cls))).toBe(true);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM photo_providers'));
    expect(get).toHaveBeenCalledWith('immich');
  });

  it.each([
    [undefined, 'immich', 'Immich'],
    [0, 'synologyphotos', 'Synology Photos'],
    [-1, 'immich', 'Immich'],
    [2, 'synologyphotos', 'Synology Photos'],
  ])(
    'PHOTO-PROVIDER-GUARD-003: returns a hiding 404 for missing/disabled/noncanonical providers',
    (enabled, providerId, label) => {
      const { db } = dbWith(enabled);
      const guard = new PhotoProviderGuard(db as never, new Reflector());
      const cls = decorated(providerId, label);

      expect(thrown(() => guard.canActivate(ctxFor(() => {}, cls)))).toEqual({
        status: 404,
        body: { error: `${label} provider is not enabled` },
      });
    },
  );
});

describe('Memories provider controller capability metadata', () => {
  const metaOf = (cls: object): PhotoProviderRequirement | undefined =>
    Reflect.getMetadata(PHOTO_PROVIDER_REQUIREMENT, cls);
  const guardsOf = (cls: object): unknown[] => Reflect.getMetadata('__guards__', cls) ?? [];

  it.each([
    ['ImmichMemoriesController', ImmichMemoriesController, 'immich', 'Immich'],
    ['SynologyMemoriesController', SynologyMemoriesController, 'synologyphotos', 'Synology Photos'],
  ])(
    'PHOTO-PROVIDER-GUARD-004: %s declares exact provider metadata and guard order',
    (_name, cls, providerId, label) => {
      expect(metaOf(cls)).toEqual({ providerId, label });
      expect(guardsOf(cls).slice(0, 3)).toEqual([AddonGuard, PhotoProviderGuard, JwtAuthGuard]);
    },
  );
});
