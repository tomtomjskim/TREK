import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

/** Trips aggregate root. Controller route ordering keeps aggregate endpoints
 * distinct from nested sub-domain mounts (collab, files, ...). */
@Module({
  controllers: [TripsController],
  providers: [TripsService],
})
export class TripsModule {}
