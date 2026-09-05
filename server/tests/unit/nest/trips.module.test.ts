import { describe, expect, it } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { TripsModule } from '../../../src/nest/trips/trips.module';
import { TripsService } from '../../../src/nest/trips/trips.service';
import { AddonsModule } from '../../../src/nest/addons/addons.module';
import { AddonsService } from '../../../src/nest/addons/addons.service';
import { VacayModule } from '../../../src/nest/vacay/vacay.module';
import { VacayService } from '../../../src/nest/vacay/vacay.service';

describe('TripsModule dependency boundary', () => {
  it('does not import VacayModule for the trip aggregate', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, TripsModule) as unknown[];

    expect(imports).toEqual(expect.any(Array));
    expect(imports).not.toContain(VacayModule);
    expect(imports).toContain(AddonsModule);
  });

  it('injects the addon capability without a VacayService collaborator', () => {
    const collaborators = Reflect.getMetadata('design:paramtypes', TripsService) as unknown[];

    expect(collaborators).toContain(AddonsService);
    expect(collaborators).not.toContain(VacayService);
  });
});
