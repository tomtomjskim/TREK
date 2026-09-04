import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrekPhotosModule } from '../photos/trek-photos.module';
import { JourneyDomainService } from './journey-domain.service';
import { PluginGuardsModule } from '../plugins/host/plugin-guards.module';
import { JourneyShareService } from './journey-share.service';

/**
 * Leaf module holding the journey domain itself, without the controllers.
 *
 * Places, assignments and the plugin host each need a handful of journey
 * functions; importing the full JourneyModule for that would drag MemoriesModule
 * (and with it both photo providers) into their graphs. This carries the two
 * services and nothing else - same shape as TrekPhotosModule.
 *
 * JournalRpc moved out to JournalRpcModule when it started writing photo bytes:
 * that needs StorageService and MemoriesModule, and pulling those in here would
 * undo the whole point of this module.
 *
 * RealtimeModule is imported explicitly even though it is @Global, so a
 * single-domain e2e TestingModule can still resolve the broadcast.
 */
@Module({
  imports: [RealtimeModule, TrekPhotosModule, PluginGuardsModule],
  providers: [JourneyDomainService, JourneyShareService],
  exports: [JourneyDomainService, JourneyShareService],
})
export class JourneyDomainModule {}
