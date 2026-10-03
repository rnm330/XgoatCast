import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from './super-admin.guard';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsClientStatsQueryDto,
  AnalyticsRangeQueryDto,
  AnalyticsRecordsQueryDto,
} from './analytics.dto';

@Controller('api/super/analytics')
@UseGuards(SuperAdminGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('realtime')
  getRealtime() {
    return this.analytics.getRealtime();
  }

  @Get('overview')
  getOverview(@Query() query: AnalyticsRangeQueryDto) {
    return this.analytics.getOverview(query);
  }

  @Get('records')
  getRecords(@Query() query: AnalyticsRecordsQueryDto) {
    return this.analytics.getRecords(query);
  }

  @Get('client-stats')
  getClientStats(@Query() query: AnalyticsClientStatsQueryDto) {
    return this.analytics.getClientStats(query);
  }
}
