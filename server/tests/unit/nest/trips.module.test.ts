import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { TripsModule } from '../../../src/nest/trips/trips.module';
import { TripsService } from '../../../src/nest/trips/trips.service';
import { VacayModule } from '../../../src/nest/vacay/vacay.module';

describe('TripsModule dependency boundary', () => {
  it('does not import VacayModule for the trip aggregate', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, TripsModule) as unknown[];

    expect(imports).toEqual(expect.any(Array));
    expect(imports).not.toContain(VacayModule);
  });

  it('constructs TripsService without a VacayService collaborator', () => {
    expect(TripsService.length).toBe(8);
  });
});
