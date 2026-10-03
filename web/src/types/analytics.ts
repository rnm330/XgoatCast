export type AnalyticsRange = '24h' | '7d' | '30d' | 'month' | 'all' | 'custom';

export type AnalyticsRecordType = 'share' | 'server' | 'server-event';

export type ClientPageType = 'share' | 'view' | 'server_admin';

export type ClientTelemetryEventType = 'page_open' | 'start_failed';

export type ClientDeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface ClientEnvironment {
  deviceType: ClientDeviceType;
  osName: string;
  browserName: string;
  browserMajor: string;
}

export interface PlatformCoverage {
  memberCount: number | null; capturedAt: number | null; isStale: boolean;
  serversTotal: number; serversSucceeded: number; knownSpaces?: number;
}
export interface AnalyticsRealtime {
  recoveringRooms?: number;
  coverageByPlatform?: Record<string, PlatformCoverage>;
  platformSpaces?: Record<string, { total: number; active: number; removed: number }>;

  coverageScope?: { platforms: string[]; excludedHeychatRooms: number };
  collectedAt: number;
  servers: {
    botPresent: number;
    bound: number;
    agoraConfigured: number;
    ready: number;
    removed: number;
  };
  sharing: {
    ongoing: number;
    pending: number;
    shareConnections: number;
    viewerConnections: number;
    adminSessions: number;
  };
  coverage: {
    memberCount: number;
    capturedAt: number | null;
    isStale: boolean;
    serversTotal: number;
    serversSucceeded: number;
  };
}

export interface AnalyticsOverviewSummary {
  successfulShares: number;
  unstartedShares: number;
  startSuccessRate: number;
  abnormalEnds: number;
  shareDurationMs: number;
  viewerJoins: number;
  viewerDurationMs: number;
  standardMinutes: number;
}

export interface AnalyticsSeriesPoint {
  timestamp: number;
  successfulShares: number;
  unstartedShares: number;
  shareDurationMs: number;
  viewerJoins: number;
  viewerDurationMs: number;
  standardMinutes: number;
}

export interface CoverageSeriesPoint {
  timestamp: number;
  memberCount: number;
}

export interface AnalyticsOverview {
  coverageSeriesByPlatform?: Record<string, Array<{ timestamp: number; memberCount: number | null }>>;
  range: {
    from: number | null;
    to: number;
    bucket: string;
  };
  summary: AnalyticsOverviewSummary;
  series: AnalyticsSeriesPoint[];
  coverageSeries: CoverageSeriesPoint[];
  endReasons: Array<{ reason: string; count: number }>;
  startFailureReasons: Array<{ reason: string; count: number }>;
}

export interface ShareAnalyticsRecord {
  id: string;
  platform?: string;
  serverSnowflakeId: string;
  serverName: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  viewerJoins: number;
  viewerDurationMs: number | null;
  peakViewers: number;
  quality: string;
  lowLatency: boolean;
  standardMinutes: number;
  endReason: string | null;
  startFailureReason: string | null;
  deviceType: string | null;
  osName: string | null;
  browserName: string | null;
  browserMajor: string | null;
}

export interface ServerAnalyticsRecord {
  id: string | number;
  platform?: string;
  serverSnowflakeId: string;
  serverName: string;
  eventType: string;
  reason?: string;
  occurredAt: number;
}

export interface ServerStateAnalyticsRecord {
  id: string;
  platform?: string;
  serverSnowflakeId: string;
  serverName: string;
  botPresent: boolean;
  bound: boolean;
  agoraConfigured: boolean;
  ready: boolean;
  removed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AnalyticsRecords<T extends ShareAnalyticsRecord | ServerAnalyticsRecord | ServerStateAnalyticsRecord> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClientStatsItem {
  pageType: ClientPageType;
  deviceType: string;
  osName: string;
  browserName: string;
  browserMajor: string;
  count: number;
}

export interface ClientStatsResponse {
  items: ClientStatsItem[];
}

export interface AnalyticsRangeQuery {
  range: AnalyticsRange;
  from?: number;
  to?: number;
}

export interface AnalyticsRecordQuery extends AnalyticsRangeQuery {
  platform?: string;
  type: AnalyticsRecordType;
  page: number;
  pageSize: number;
  status?: string;
  server?: string;
}

export interface ShareTelemetryPayload extends ClientEnvironment {
  token: string;
  pageType: ClientPageType;
  eventType: ClientTelemetryEventType;
  failureReason?: string;
}
