import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { SuperAdminGuard } from './super-admin.guard';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, SuperAdminGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
