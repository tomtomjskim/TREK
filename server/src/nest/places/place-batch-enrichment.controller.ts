import { Body, Controller, Headers, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import type { User } from '../../types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TripAccessGuard } from '../permissions/trip-access.guard';
import { PlaceEnrichmentApplyDto, PlaceEnrichmentPreviewDto } from './places.dto';
import { PlaceBatchEnrichmentService } from './place-batch-enrichment.service';

@Controller('api/trips/:tripId/places/enrichment')
@UseGuards(JwtAuthGuard, TripAccessGuard)
@RequirePermission('place_edit')
export class PlaceBatchEnrichmentController {
  constructor(private readonly batch: PlaceBatchEnrichmentService) {}

  private configurationError(error: unknown): null {
    if (error instanceof Error && error.message === 'PLACE_ENRICHMENT_DISABLED') throw new HttpException({ error: 'Place enrichment is disabled by an administrator', code: 'PLACE_ENRICHMENT_DISABLED' }, 403);
    if (error instanceof Error && error.message === 'PLACE_ENRICHMENT_NOT_CONFIGURED') throw new HttpException({ error: 'Google Maps enrichment is not configured', code: 'PLACE_ENRICHMENT_NOT_CONFIGURED' }, 400);
    return null;
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@CurrentUser() user: User, @Body() body: PlaceEnrichmentPreviewDto, @Param('tripId') tripId: string) {
    let result;
    try { result = await this.batch.preview(tripId, user.id, body); } catch (error) { this.configurationError(error); throw error; }
    if (result.stopped && result.processed === 0) throw new HttpException({ error: result.stopped.error, code: result.stopped.code, sku: result.stopped.sku, usage: result.stopped.usage }, result.stopped.code === 'PLACE_ENRICHMENT_DISABLED' ? 403 : 429);
    return result;
  }

  @Post('apply')
  @HttpCode(200)
  async apply(@CurrentUser() user: User, @Body() body: PlaceEnrichmentApplyDto, @Param('tripId') tripId: string, @Headers('x-socket-id') socketId?: string) {
    let result;
    try { result = await this.batch.apply(tripId, user.id, body, socketId); } catch (error) { this.configurationError(error); throw error; }
    if (result.stopped && result.processed === 0) throw new HttpException({ error: result.stopped.error, code: result.stopped.code, sku: result.stopped.sku, usage: result.stopped.usage }, result.stopped.code === 'PLACE_ENRICHMENT_DISABLED' ? 403 : 429);
    return result;
  }
}
