import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ANALYTICS_PAGE_TYPES,
  ANALYTICS_RANGES,
  ANALYTICS_RECORD_TYPES,
  AnalyticsPageType,
  AnalyticsRange,
  AnalyticsRecordType,
} from './analytics.types';

export class AnalyticsRangeQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_RANGES)
  range?: AnalyticsRange = '24h';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;
}

export class AnalyticsRecordsQueryDto extends AnalyticsRangeQueryDto {
  @IsOptional()
  @IsIn(['kook', 'heychat', 'qq', 'panel'])
  platform?: string;

  @IsOptional()
  @IsIn(ANALYTICS_RECORD_TYPES)
  type?: AnalyticsRecordType = 'share';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 50;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  server?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  serverSnowflakeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  serverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsIn(['success', 'not_started', 'pending'])
  outcome?: 'success' | 'not_started' | 'pending';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  endReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  eventType?: string;
}

export class AnalyticsClientStatsQueryDto extends AnalyticsRangeQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_PAGE_TYPES)
  pageType?: AnalyticsPageType;
}
