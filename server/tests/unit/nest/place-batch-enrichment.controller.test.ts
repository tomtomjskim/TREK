import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { PlaceBatchEnrichmentController } from '../../../src/nest/places/place-batch-enrichment.controller';
import { JwtAuthGuard } from '../../../src/nest/auth/jwt-auth.guard';
import { TRIP_PERMISSION_KEY, TripAccessGuard } from '../../../src/nest/permissions/trip-access.guard';

describe('PlaceBatchEnrichmentController', () => {
  it('passes preview through with the current trip/user contract', async () => {
    const batch = { preview: vi.fn(async () => ({ entries: [], errors: [], requested: 0, processed: 0, skipped: 0, stopped: null, usage: [] })) } as any;
    await expect(new PlaceBatchEnrichmentController(batch).preview({ id: 7 } as any, {}, '5')).resolves.toMatchObject({ requested: 0 });
    expect(batch.preview).toHaveBeenCalledWith('5', 7, {});
  });

  it('turns a quota stop before progress into a 429 envelope', async () => {
    const batch = { preview: vi.fn(async () => ({ entries: [], errors: [], requested: 1, processed: 0, skipped: 0, stopped: { code: 'GOOGLE_API_MONTHLY_CAP_REACHED', error: 'cap', sku: 'text_search_pro' }, usage: [] })) } as any;
    try { await new PlaceBatchEnrichmentController(batch).preview({ id: 7 } as any, {}, '5'); throw new Error('expected 429'); } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'GOOGLE_API_MONTHLY_CAP_REACHED', sku: 'text_search_pro' });
    }
  });

  it('turns a disabled stop before progress into a stable 403 envelope', async () => {
    const batch = { preview: vi.fn(async () => ({
      entries: [], errors: [], requested: 1, processed: 0, skipped: 1,
      stopped: { code: 'PLACE_ENRICHMENT_DISABLED', error: 'Place enrichment was disabled by an administrator' }, usage: [],
    })) } as any;
    try { await new PlaceBatchEnrichmentController(batch).preview({ id: 7 } as any, {}, '5'); throw new Error('expected 403'); } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
      expect((error as HttpException).getResponse()).toEqual({ code: 'PLACE_ENRICHMENT_DISABLED', error: 'Place enrichment was disabled by an administrator' });
    }
  });

  it('keeps both POST routes on the existing 200 response contract', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PlaceBatchEnrichmentController.prototype.preview)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PlaceBatchEnrichmentController.prototype.apply)).toBe(200);
  });

  it('requires JWT, trip access, and place_edit before either provider operation', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlaceBatchEnrichmentController)).toEqual([
      JwtAuthGuard,
      TripAccessGuard,
    ]);
    expect(Reflect.getMetadata(TRIP_PERMISSION_KEY, PlaceBatchEnrichmentController)).toBe('place_edit');
  });

  it.each([
    ['PLACE_ENRICHMENT_DISABLED', 403, 'PLACE_ENRICHMENT_DISABLED'],
    ['PLACE_ENRICHMENT_NOT_CONFIGURED', 400, 'PLACE_ENRICHMENT_NOT_CONFIGURED'],
  ])('maps %s to the stable configuration envelope', async (message, status, code) => {
    const batch = { preview: vi.fn().mockRejectedValue(new Error(message)) } as any;

    try {
      await new PlaceBatchEnrichmentController(batch).preview({ id: 7 } as any, {}, '5');
      throw new Error(`expected ${status}`);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).getResponse()).toMatchObject({ code });
    }
  });

  it('passes apply matches and the socket id through to the service', async () => {
    const response = { updated: [{ id: 3 }], errors: [], requested: 1, processed: 1, skipped: 0, stopped: null, usage: [] };
    const batch = { apply: vi.fn().mockResolvedValue(response) } as any;
    const body = { matches: [{ place_id: 3, google_place_id: 'g3' }], lang: 'ko' };

    await expect(new PlaceBatchEnrichmentController(batch).apply({ id: 7 } as any, body, '5', 'socket')).resolves.toBe(response);
    expect(batch.apply).toHaveBeenCalledWith('5', 7, body, 'socket');
  });

  it('returns partial progress instead of converting it to a 429', async () => {
    const response = {
      entries: [{ place_id: 1 }], errors: [], requested: 2, processed: 1, skipped: 1,
      stopped: { code: 'GOOGLE_API_MONTHLY_CAP_REACHED', error: 'cap' }, usage: [],
    };
    const batch = { preview: vi.fn().mockResolvedValue(response) } as any;

    await expect(new PlaceBatchEnrichmentController(batch).preview({ id: 7 } as any, {}, '5')).resolves.toBe(response);
  });
});
