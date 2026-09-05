import { Module } from '@nestjs/common';
import { TripShareController, SharedController } from './share.controller';
import { ShareService } from './share.service';
import { ShareMcp } from './share.mcp';
import { SettingsModule } from '../settings/settings.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { QueryHelpersModule } from '../query-helpers/query-helpers.module';
import { PlacePhotosModule } from '../place-photos/place-photos.module';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { McpSharedModule } from '../mcp-shared/mcp-shared.module';
import { AddonsModule } from '../addons/addons.module';

@Module({
  imports: [McpSharedModule, SettingsModule, PermissionsModule, QueryHelpersModule, AuthModule, PlacePhotosModule, StorageModule, AddonsModule],
  controllers: [TripShareController, SharedController],
  providers: [ShareService, ShareMcp],
})
export class ShareModule {}
