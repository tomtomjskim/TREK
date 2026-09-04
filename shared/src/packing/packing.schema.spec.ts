import {
  packingCreateItemRequestSchema,
  packingImportRequestSchema,
  packingCreateBagRequestSchema,
  packingUpdateItemRequestSchema,
  packingUpdateBagRequestSchema,
  packingSaveTemplateRequestSchema,
} from './packing.schema';

import { describe, it, expect } from 'vitest';

describe('packingCreateItemRequestSchema', () => {
  it('requires a non-empty name; category/checked optional', () => {
    expect(packingCreateItemRequestSchema.safeParse({ name: 'Socks' }).success).toBe(true);
    expect(
      packingCreateItemRequestSchema.safeParse({
        name: 'Socks',
        category: 'Clothes',
        checked: true,
      }).success,
    ).toBe(true);
    expect(packingCreateItemRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('carries weight_grams, bag_id and quantity like the update schema (#2154)', () => {
    const parsed = packingCreateItemRequestSchema.safeParse({
      name: 'Tent',
      weight_grams: 300,
      bag_id: 19,
      quantity: 3,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ name: 'Tent', weight_grams: 300, bag_id: 19, quantity: 3 });
    // Nullable, mirroring the update contract.
    expect(packingCreateItemRequestSchema.safeParse({ name: 'Tent', weight_grams: null, bag_id: null }).success).toBe(
      true,
    );
    expect(packingCreateItemRequestSchema.safeParse({ name: 'Tent', bag_id: 'carry-on' }).success).toBe(false);
  });

  it('rejects non-finite/fractional/negative weights and invalid quantities', () => {
    for (const weight of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(packingCreateItemRequestSchema.safeParse({ name: 'Tent', weight_grams: weight }).success).toBe(false);
      expect(packingUpdateItemRequestSchema.safeParse({ weight_grams: weight }).success).toBe(false);
    }
    for (const quantity of [0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(packingCreateItemRequestSchema.safeParse({ name: 'Tent', quantity }).success).toBe(false);
      expect(packingUpdateItemRequestSchema.safeParse({ quantity }).success).toBe(false);
    }
    expect(packingCreateItemRequestSchema.safeParse({ name: 'Tent', weight_grams: 0, quantity: 1 }).success).toBe(true);
    expect(packingUpdateItemRequestSchema.safeParse({ weight_grams: null, quantity: 999 }).success).toBe(true);
  });

  it('still strips unknown keys — camelCase was never part of the contract', () => {
    const parsed = packingCreateItemRequestSchema.safeParse({ name: 'Tent', weightGrams: 300, bagId: 19 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ name: 'Tent' });
  });
});

describe('packingImportRequestSchema', () => {
  it('accepts an array of open item rows', () => {
    expect(
      packingImportRequestSchema.safeParse({
        items: [{ name: 'a' }, { name: 'b', anything: 1 }],
      }).success,
    ).toBe(true);
  });
});

describe('packingCreateBagRequestSchema', () => {
  it('requires a name', () => {
    expect(packingCreateBagRequestSchema.safeParse({ name: 'Carry-on' }).success).toBe(true);
    expect(packingCreateBagRequestSchema.safeParse({}).success).toBe(false);
  });

  it('carries weight_limit_grams like the update schema (#2154)', () => {
    const parsed = packingCreateBagRequestSchema.safeParse({ name: 'Backpack', weight_limit_grams: 8000 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ name: 'Backpack', weight_limit_grams: 8000 });
    expect(packingCreateBagRequestSchema.safeParse({ name: 'Backpack', weight_limit_grams: null }).success).toBe(true);
    expect(packingCreateBagRequestSchema.safeParse({ name: 'Backpack', weight_limit_grams: 'heavy' }).success).toBe(
      false,
    );
  });

  it('requires a finite nonnegative integer weight limit for create and update', () => {
    for (const weight of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(packingCreateBagRequestSchema.safeParse({ name: 'Bag', weight_limit_grams: weight }).success).toBe(false);
      expect(packingUpdateBagRequestSchema.safeParse({ weight_limit_grams: weight }).success).toBe(false);
    }
    expect(packingCreateBagRequestSchema.safeParse({ name: 'Bag', weight_limit_grams: 0 }).success).toBe(true);
    expect(packingUpdateBagRequestSchema.safeParse({ weight_limit_grams: null }).success).toBe(true);
  });
});

describe('packingSaveTemplateRequestSchema', () => {
  it('requires a name', () => {
    expect(packingSaveTemplateRequestSchema.safeParse({ name: 'Summer' }).success).toBe(true);
    expect(packingSaveTemplateRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
