import { Module } from '@nestjs/common';
import { GoogleApiTransportService } from './google-api-transport.service';
import { GoogleApiUsageService } from './google-api-usage.service';

@Module({
  providers: [GoogleApiUsageService, GoogleApiTransportService],
  exports: [GoogleApiUsageService, GoogleApiTransportService],
})
export class GoogleApiUsageModule {}
