export const ANALYTICS_RANGES = ['24h', '7d', '30d', 'month', 'all', 'custom'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const ANALYTICS_PAGE_TYPES = ['share', 'view', 'server_admin'] as const;
export type AnalyticsPageType = (typeof ANALYTICS_PAGE_TYPES)[number];
export type AnalyticsPageTypeInput = AnalyticsPageType | 'admin';

export const ANALYTICS_RECORD_TYPES = ['share', 'server', 'server-event', 'coverage'] as const;
export type AnalyticsRecordType = (typeof ANALYTICS_RECORD_TYPES)[number];

export interface AnalyticsRangeInput {
  range?: AnalyticsRange;
  from?: string;
  to?: string;
}

export interface AnalyticsRangeWindow {
  preset: AnalyticsRange;
  from: number;
  to: number;
  timezone: 'Asia/Hong_Kong';
  bucket: 'hour' | 'day';
}

export interface AnalyticsClientDimensions {
  deviceType?: string;
  osName?: string;
  browserName?: string;
  browserMajor?: string;
}

export interface AnalyticsClientTelemetry extends AnalyticsClientDimensions {
  pageType?: AnalyticsPageTypeInput;
  eventType: 'environment' | 'start_failure' | 'page_open' | 'start_failed';
  failureCode?: string;
  failureReason?: string;
}

export interface AnalyticsServerEventInput {
  eventKey?: string;
  serverSnowflakeId: string;
  serverName?: string;
  eventType: string;
  reason?: string;
  occurredAt?: number;
}

export interface AnalyticsCoverageSnapshotInput {
  snapshotKey?: string;
  capturedAt?: number;
  totalMemberCount: number;
  successfulServerCount: number;
  failedServerCount: number;
}

export interface AnalyticsRecordsInput extends AnalyticsRangeInput {
  platform?: string;
  type?: AnalyticsRecordType;
  page?: number;
  pageSize?: number;
  server?: string;
  serverSnowflakeId?: string;
  serverName?: string;
  status?: string;
  outcome?: 'success' | 'not_started' | 'pending';
  endReason?: string;
  eventType?: string;
}
