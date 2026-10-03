import { BadRequestException, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService, ServerSession } from '../database/database.service';
import {
  getAudioCoefficient,
  getQualityInfo,
  getVideoCoefficient,
} from '../session/session.types';
import {
  AnalyticsClientDimensions,
  AnalyticsClientTelemetry,
  AnalyticsCoverageSnapshotInput,
  AnalyticsPageType,
  AnalyticsPageTypeInput,
  AnalyticsRange,
  AnalyticsRangeInput,
  AnalyticsRangeWindow,
  AnalyticsRecordsInput,
  AnalyticsServerEventInput,
} from './analytics.types';

interface ShareRow {
  share_id: string;
  server_snowflake_id: string;
  server_name: string;
  created_at: number;
  attributed_at: number;
  first_started_at: number | null;
  final_ended_at: number | null;
  status: string;
  end_reason: string;
  start_failure_reason: string;
  abnormal_end: number;
  peak_viewers: number;
  duration_ms: number;
  viewer_joins: number;
  viewer_duration_ms: number;
  viewer_duration_estimated: number;
  standard_minutes: number;
  standard_minutes_estimated: number;
  quality: string;
  low_latency: number;
  updated_at: number;
}

interface PresenceEntry {
  lastSeenAt: number;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COVERAGE_STALE_AFTER_MS = 8 * HOUR_MS;
const ALLOWED_DEVICE_TYPES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);
const ALLOWED_OS_NAMES = new Set(['Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS', 'Unknown']);
const ALLOWED_BROWSER_NAMES = new Set([
  'Edge', 'Opera', 'Samsung Internet', 'Firefox', 'Chrome', 'Safari', 'Unknown',
]);
const ALLOWED_START_FAILURES = new Set([
  'capture_permission_denied', 'insecure_context', 'screen_audio_unavailable',
  'rtc_sdk_unavailable', 'session_ended', 'network_error', 'publish_failed',
  'start_rejected', 'unknown',
]);

@Injectable()
export class AnalyticsService {
  private readonly presence = new Map<AnalyticsPageType, Map<string, PresenceEntry>>([
    ['share', new Map()],
    ['view', new Map()],
    ['server_admin', new Map()],
  ]);

  private readonly presenceTtlMs: Record<AnalyticsPageType, number> = {
    share: 120_000,
    view: 120_000,
    server_admin: 120_000,
  };

  constructor(private readonly db: DatabaseService) {
    this.db.integrationDatabase.exec(`CREATE TABLE IF NOT EXISTS analytics_platform_coverage (
      platform TEXT NOT NULL, bucket INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      member_count INTEGER, spaces_total INTEGER NOT NULL, spaces_succeeded INTEGER NOT NULL,
      PRIMARY KEY(platform,bucket));`);
    this.backfillMissingStandardMinutes();
  }

  // ===== Share lifecycle integration =====

  recordShareCreated(session: ServerSession): void {
    const snapshot = this.getServerSnapshot(session);
    const createdAt = this.nonNegativeInteger(session.createdAt, Date.now());
    this.db.runAnalytics(`
      INSERT OR IGNORE INTO analytics_share_records (
        share_id, server_snowflake_id, server_name, created_at, attributed_at,
        status, quality, low_latency, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `, [
      this.safeId(session.id),
      snapshot.serverSnowflakeId,
      snapshot.serverName,
      createdAt,
      createdAt,
      this.safeCode(session.quality, '1080p_2'),
      session.lowLatency ? 1 : 0,
      Date.now(),
    ]);
  }

  recordShareStarted(session: ServerSession): void {
    this.recordShareCreated(session);
    const startedAt = this.nonNegativeInteger(session.startedAt, Date.now());
    this.db.runAnalytics(`
      UPDATE analytics_share_records
      SET first_started_at = COALESCE(first_started_at, ?),
          attributed_at = CASE WHEN first_started_at IS NULL THEN ? ELSE attributed_at END,
          status = CASE WHEN final_ended_at IS NULL THEN 'ongoing' ELSE status END,
          quality = ?, low_latency = ?, updated_at = ?
      WHERE share_id = ?
    `, [
      startedAt,
      startedAt,
      this.safeCode(session.quality, '1080p_2'),
      session.lowLatency ? 1 : 0,
      Date.now(),
      this.safeId(session.id),
    ]);
  }

  recordShareMetrics(session: ServerSession, standardMinutes?: number): void {
    if (session.startedAt) this.recordShareStarted(session);
    else this.recordShareCreated(session);

    const durationMs = this.getSessionDurationMs(session);
    // Lightweight estimate: assume the peak audience watched for the full
    // first-start-to-final-end duration. No per-viewer intervals are retained.
    const viewerDurationEstimated = true;
    const viewerDurationMs = this.nonNegativeInteger(session.peakViewers) * durationMs;
    const calculatedStandardMinutes = standardMinutes == null
      ? this.calculateStandardMinutes(
          durationMs,
          viewerDurationMs,
          session.quality,
          !!session.lowLatency,
        )
      : this.nonNegativeNumber(standardMinutes);

    this.db.runAnalytics(`
      UPDATE analytics_share_records
      SET duration_ms = MAX(duration_ms, ?),
          viewer_joins = MAX(viewer_joins, ?),
          peak_viewers = MAX(peak_viewers, ?),
          viewer_duration_ms = MAX(viewer_duration_ms, ?),
          viewer_duration_estimated = ?,
          standard_minutes = MAX(standard_minutes, ?),
          standard_minutes_estimated = ?,
          quality = ?, low_latency = ?, updated_at = ?
      WHERE share_id = ?
    `, [
      durationMs,
      this.nonNegativeInteger(session.totalViewerJoins),
      this.nonNegativeInteger(session.peakViewers),
      viewerDurationMs,
      viewerDurationEstimated ? 1 : 0,
      calculatedStandardMinutes,
      standardMinutes == null ? 1 : 0,
      this.safeCode(session.quality, '1080p_2'),
      session.lowLatency ? 1 : 0,
      Date.now(),
      this.safeId(session.id),
    ]);
  }

  recordShareEnded(
    session: ServerSession,
    endReason: string,
    abnormalEnd?: boolean,
    standardMinutes?: number,
  ): void {
    this.recordShareMetrics(session, standardMinutes);
    const endedAt = this.nonNegativeInteger(session.endedAt, Date.now());
    const reason = this.safeCode(endReason, 'unknown');
    const abnormal = abnormalEnd ?? this.inferAbnormalEnd(reason);
    this.db.runAnalytics(`
      UPDATE analytics_share_records
      SET final_ended_at = COALESCE(final_ended_at, ?),
          status = 'ended',
          end_reason = CASE
            WHEN end_reason = '' OR end_reason = 'legacy_unknown' THEN ?
            ELSE end_reason
          END,
          abnormal_end = MAX(abnormal_end, ?),
          duration_ms = CASE
            WHEN first_started_at IS NULL THEN 0
            ELSE MAX(duration_ms, ? - first_started_at)
          END,
          updated_at = ?
      WHERE share_id = ?
    `, [endedAt, reason, abnormal ? 1 : 0, endedAt, Date.now(), this.safeId(session.id)]);
  }

  recordClientTelemetry(session: ServerSession, data: AnalyticsClientTelemetry): void {
    this.recordShareCreated(session);
    if (data.eventType === 'environment' || data.eventType === 'page_open') {
      const pageType = data.pageType === 'view' ? 'view' : 'share';
      this.incrementClientStat(pageType, data);
      return;
    }
    const requestedFailure = this.safeCode(data.failureCode || data.failureReason, 'unknown');
    const failureCode = ALLOWED_START_FAILURES.has(requestedFailure)
      ? requestedFailure
      : 'unknown';
    this.db.runAnalytics(`
      UPDATE analytics_share_records
      SET start_failure_reason = ?, updated_at = ?
      WHERE share_id = ? AND first_started_at IS NULL
    `, [failureCode, Date.now(), this.safeId(session.id)]);
  }

  // ===== Anonymous client presence and aggregate environment stats =====

  clientConnected(
    pageType: AnalyticsPageTypeInput,
    connectionId: string,
    dimensions?: AnalyticsClientDimensions,
  ): void {
    const normalizedPage = this.normalizePageType(pageType);
    const key = this.presenceKey(connectionId);
    const entries = this.presence.get(normalizedPage)!;
    const isNew = !entries.has(key);
    entries.set(key, { lastSeenAt: Date.now() });
    if (isNew && dimensions) this.incrementClientStat(normalizedPage, dimensions);
  }

  /** Heartbeat is also an upsert, so an admin page can recover after a restart. */
  clientHeartbeat(pageType: AnalyticsPageTypeInput, connectionId: string): void {
    const normalizedPage = this.normalizePageType(pageType);
    this.presence.get(normalizedPage)!.set(this.presenceKey(connectionId), {
      lastSeenAt: Date.now(),
    });
  }

  clientDisconnected(pageType: AnalyticsPageTypeInput, connectionId: string): void {
    this.presence.get(this.normalizePageType(pageType))!.delete(this.presenceKey(connectionId));
  }

  incrementClientStat(
    pageType: AnalyticsPageTypeInput,
    dimensions: AnalyticsClientDimensions,
    count = 1,
    occurredAt = Date.now(),
  ): void {
    const bucketStart = Math.floor(occurredAt / HOUR_MS) * HOUR_MS;
    this.db.runAnalytics(`
      INSERT INTO analytics_client_stats (
        bucket_start, page_type, device_type, os_name, browser_name,
        browser_major, count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        bucket_start, page_type, device_type, os_name, browser_name, browser_major
      ) DO UPDATE SET count = count + excluded.count
    `, [
      bucketStart,
      this.normalizePageType(pageType),
      this.safeEnumDimension(dimensions.deviceType, ALLOWED_DEVICE_TYPES, 'unknown'),
      this.safeEnumDimension(dimensions.osName, ALLOWED_OS_NAMES, 'Unknown'),
      this.safeEnumDimension(dimensions.browserName, ALLOWED_BROWSER_NAMES, 'Unknown'),
      this.safeBrowserMajor(dimensions.browserMajor),
      Math.max(1, this.nonNegativeInteger(count, 1)),
    ]);
  }

  platformOfSpace(id: string): string {
    return this.db.getServer(id)?.platform || (id.startsWith('qq:') ? 'qq' : id.startsWith('heychat:') ? 'heychat' : 'kook');
  }

  platformCoverage(platform: string) {
    const spaces = this.db.listSpaces(platform).filter(s => s.status === 'active');
    const counts = spaces.map(s => this.getLatestMemberCount(s.serverId)).filter(Boolean);
    const fresh = counts.filter(c => Date.now() - c.updatedAt < COVERAGE_STALE_AFTER_MS);
    const latest = platform === 'kook' ? this.db.getAnalyticsRow<any>('SELECT * FROM analytics_coverage_snapshots ORDER BY captured_at DESC LIMIT 1') : undefined;
    return {
      memberCount: !spaces.length ? 0 : counts.length ? counts.reduce((n,c) => n + c.memberCount, 0) : latest ? Number(latest.total_member_count) : spaces.length ? null : 0,
      capturedAt: counts.length ? Math.max(...counts.map(c => c.updatedAt)) : latest?.captured_at || null,
      serversTotal: spaces.length,
      serversSucceeded: fresh.length,
      isStale: fresh.length < spaces.length || (spaces.length > 0 && !counts.length),
      knownSpaces: counts.length,
    };
  }

  @Interval(60_000)
  recordOtherPlatformCoverage() {
    for (const platform of ['heychat','qq']) {
      const coverage = this.platformCoverage(platform);
      const now = Date.now();
      this.db.runAnalytics(`INSERT OR REPLACE INTO analytics_platform_coverage VALUES (?,?,?,?,?,?)`,
        [platform, Math.floor(now / HOUR_MS), now, coverage.memberCount, coverage.serversTotal, coverage.serversSucceeded]);
    }
  }

  // ===== KOOK server and coverage integration =====

  recordServerEvent(input: AnalyticsServerEventInput): boolean {
    const occurredAt = this.nonNegativeInteger(input.occurredAt, Date.now());
    const serverSnowflakeId = this.safeId(input.serverSnowflakeId);
    const serverName = this.resolveServerName(serverSnowflakeId, input.serverName);
    const eventType = this.safeCode(input.eventType, 'unknown');
    const reason = this.safeCode(input.reason, '');
    const eventKey = this.safeId(
      input.eventKey || `${serverSnowflakeId}:${eventType}:${occurredAt}`,
      200,
    );
    return this.db.runAnalytics(`
      INSERT OR IGNORE INTO analytics_server_events (
        event_key, server_snowflake_id, server_name, event_type, reason, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [eventKey, serverSnowflakeId, serverName, eventType, reason, occurredAt]) > 0;
  }

  finalizeServerDeletion(serverSnowflakeId: string, serverName: string): void {
    const endedAt = Date.now();
    for (const session of this.db.getSessionsByServer(serverSnowflakeId)) {
      if (session.status === 'ended') continue;
      this.recordShareEnded({
        ...session,
        status: 'ended',
        endedAt,
        durationMs: session.startedAt ? endedAt - session.startedAt : null,
      }, 'server_deleted', false);
    }
    this.recordServerEvent({
      eventKey: `server_deleted:${serverSnowflakeId}:${endedAt}`,
      serverSnowflakeId,
      serverName,
      eventType: 'server_deleted',
      occurredAt: endedAt,
    });
  }

  upsertServerMemberCount(
    serverSnowflakeId: string,
    memberCount: number,
    updatedAt = Date.now(),
  ): void {
    this.db.runAnalytics(`
      INSERT INTO analytics_server_member_counts (
        server_snowflake_id, member_count, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(server_snowflake_id) DO UPDATE SET
        member_count = excluded.member_count,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= analytics_server_member_counts.updated_at
    `, [
      this.safeId(serverSnowflakeId),
      this.nonNegativeInteger(memberCount),
      this.nonNegativeInteger(updatedAt, Date.now()),
    ]);
  }

  getLatestMemberCount(serverSnowflakeId: string) {
    const row = this.db.getAnalyticsRow<any>(`
      SELECT server_snowflake_id, member_count, updated_at
      FROM analytics_server_member_counts
      WHERE server_snowflake_id = ?
    `, [this.safeId(serverSnowflakeId)]);
    return row ? {
      serverSnowflakeId: row.server_snowflake_id,
      memberCount: Number(row.member_count),
      updatedAt: Number(row.updated_at),
    } : undefined;
  }

  getLatestMemberCounts() {
    return this.db.getAnalyticsRows<any>(`
      SELECT server_snowflake_id, member_count, updated_at
      FROM analytics_server_member_counts
      ORDER BY updated_at DESC
    `).map((row) => ({
      serverSnowflakeId: row.server_snowflake_id,
      memberCount: Number(row.member_count),
      updatedAt: Number(row.updated_at),
    }));
  }

  recordCoverageSnapshot(input: AnalyticsCoverageSnapshotInput): void {
    const capturedAt = this.nonNegativeInteger(input.capturedAt, Date.now());
    const snapshotKey = this.safeId(input.snapshotKey || String(capturedAt), 200);
    this.db.runAnalytics(`
      INSERT INTO analytics_coverage_snapshots (
        snapshot_key, captured_at, total_member_count,
        successful_server_count, failed_server_count
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_key) DO UPDATE SET
        captured_at = excluded.captured_at,
        total_member_count = excluded.total_member_count,
        successful_server_count = excluded.successful_server_count,
        failed_server_count = excluded.failed_server_count
    `, [
      snapshotKey,
      capturedAt,
      this.nonNegativeInteger(input.totalMemberCount),
      this.nonNegativeInteger(input.successfulServerCount),
      this.nonNegativeInteger(input.failedServerCount),
    ]);
  }

  upsertCoverageServer(
    serverSnowflakeId: string,
    _serverName: string,
    memberCount: number,
    capturedAt = Date.now(),
  ): void {
    this.upsertServerMemberCount(serverSnowflakeId, memberCount, capturedAt);
  }

  recordCoverageTotals(
    totalMemberCount: number,
    serversTotal: number,
    serversSucceeded: number,
    _serversStale = 0,
    capturedAt = Date.now(),
  ): void {
    const successfulServerCount = this.nonNegativeInteger(serversSucceeded);
    this.recordCoverageSnapshot({
      capturedAt,
      totalMemberCount,
      successfulServerCount,
      failedServerCount: Math.max(
        0,
        this.nonNegativeInteger(serversTotal) - successfulServerCount,
      ),
    });
  }

  // ===== Read APIs =====

  getRealtime() {
    const now = Date.now();
    this.prunePresence(now);
    const serverCounts = this.db.getAnalyticsRow<any>(`
      SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS bot_present,
        SUM(CASE WHEN bound = 1 THEN 1 ELSE 0 END) AS bound,
        SUM(CASE
          WHEN TRIM(agora_app_id) != '' AND TRIM(agora_app_certificate) != ''
          THEN 1 ELSE 0 END
        ) AS agora_configured,
        SUM(CASE
          WHEN status = 'active' AND bound = 1
            AND TRIM(agora_app_id) != '' AND TRIM(agora_app_certificate) != ''
          THEN 1 ELSE 0 END
        ) AS share_ready,
        SUM(CASE WHEN status = 'kicked' THEN 1 ELSE 0 END) AS removed
      FROM servers
    `) || {};
    const shareCounts = this.db.getAnalyticsRow<any>(`
      SELECT
        SUM(CASE WHEN first_started_at IS NOT NULL AND final_ended_at IS NULL
          THEN 1 ELSE 0 END) AS ongoing,
        SUM(CASE WHEN first_started_at IS NULL AND final_ended_at IS NULL
          THEN 1 ELSE 0 END) AS pending
      FROM analytics_share_records
    `);
    const coverage = this.db.getAnalyticsRow<any>(`
      SELECT * FROM analytics_coverage_snapshots
      ORDER BY captured_at DESC LIMIT 1
    `);

    return {
      collectedAt: now,
      recoveringRooms: this.db.getAnalyticsRow<any>("SELECT name FROM sqlite_master WHERE name='session_recovery'")
        ? Number(this.db.getAnalyticsRow<any>('SELECT COUNT(*) AS n FROM session_recovery WHERE until_at > ?', [now])?.n || 0) : 0,
      timezone: 'Asia/Hong_Kong',
      servers: {
        botPresent: Number(serverCounts.bot_present || 0),
        bound: Number(serverCounts.bound || 0),
        agoraConfigured: Number(serverCounts.agora_configured || 0),
        ready: Number(serverCounts.share_ready || 0),
        removed: Number(serverCounts.removed || 0),
      },
      sharing: {
        ongoing: Number(shareCounts?.ongoing || 0),
        pending: Number(shareCounts?.pending || 0),
        shareConnections: this.presence.get('share')!.size,
        viewerConnections: this.presence.get('view')!.size,
        adminSessions: this.presence.get('server_admin')!.size,
      },
      coverageByPlatform: Object.fromEntries(['kook','heychat','qq'].map(p => [p, this.platformCoverage(p)])),
      platformSpaces: Object.fromEntries(['kook','heychat','qq','panel'].map(p => { const all = this.db.listSpaces(p); return [p, { total: all.length, active: all.filter(s => s.status === 'active').length, removed: all.filter(s => s.status === 'kicked').length }]; })),
      coverage: coverage ? {
        memberCount: Number(coverage.total_member_count),
        capturedAt: Number(coverage.captured_at),
        isStale: Number(coverage.failed_server_count) > 0
          || now - Number(coverage.captured_at) > COVERAGE_STALE_AFTER_MS,
        serversTotal: Number(coverage.successful_server_count)
          + Number(coverage.failed_server_count),
        serversSucceeded: Number(coverage.successful_server_count),
      } : { memberCount: 0, capturedAt: null, isStale: true,
        serversTotal: 0, serversSucceeded: 0 },
    };
  }

  getOverview(input: AnalyticsRangeInput) {
    const window = this.resolveRange(input);
    const now = Date.now();
    const summary = this.db.getAnalyticsRow<any>(`
      SELECT
        SUM(CASE WHEN first_started_at IS NOT NULL THEN 1 ELSE 0 END) AS successful,
        SUM(CASE
          WHEN first_started_at IS NULL AND final_ended_at IS NOT NULL THEN 1 ELSE 0 END
        ) AS not_started,
        SUM(CASE WHEN abnormal_end = 1 THEN 1 ELSE 0 END) AS abnormal,
        SUM(CASE
          WHEN first_started_at IS NULL THEN 0
          WHEN final_ended_at IS NULL THEN MAX(duration_ms, ? - first_started_at)
          ELSE MAX(duration_ms, final_ended_at - first_started_at)
        END) AS duration_ms,
        SUM(viewer_joins) AS viewer_joins,
        SUM(viewer_duration_ms) AS viewer_duration_ms,
        SUM(standard_minutes) AS standard_minutes,
        MAX(viewer_duration_estimated) AS has_estimated_viewer_duration,
        MAX(standard_minutes_estimated) AS has_estimated_standard_minutes
      FROM analytics_share_records
      WHERE attributed_at >= ? AND attributed_at < ?
    `, [now, window.from, window.to]) || {};
    const successful = Number(summary.successful || 0);
    const notStarted = Number(summary.not_started || 0);
    const completedOutcomes = successful + notStarted;
    const reasons = this.db.getAnalyticsRows<any>(`
      SELECT CASE WHEN end_reason = '' THEN 'unknown' ELSE end_reason END AS reason,
             COUNT(*) AS count
      FROM analytics_share_records
      WHERE attributed_at >= ? AND attributed_at < ? AND final_ended_at IS NOT NULL
      GROUP BY CASE WHEN end_reason = '' THEN 'unknown' ELSE end_reason END
      ORDER BY count DESC, reason ASC
    `, [window.from, window.to]).map((row) => ({
      reason: row.reason,
      count: Number(row.count),
    }));
    const startFailureReasons = this.db.getAnalyticsRows<any>(`
      SELECT start_failure_reason AS reason, COUNT(*) AS count
      FROM analytics_share_records
      WHERE attributed_at >= ? AND attributed_at < ?
        AND start_failure_reason != ''
      GROUP BY start_failure_reason
      ORDER BY count DESC, reason ASC
    `, [window.from, window.to]).map((row) => ({
      reason: row.reason,
      count: Number(row.count),
    }));
    const bucketMs = window.preset === '24h' ? HOUR_MS : DAY_MS;
    const bucketOffset = bucketMs === DAY_MS ? BEIJING_OFFSET_MS : 0;
    const recordedSeries = this.db.getAnalyticsRows<any>(`
      SELECT CAST((attributed_at + ?) / ? AS INTEGER) * ? - ? AS timestamp,
        SUM(CASE WHEN first_started_at IS NOT NULL THEN 1 ELSE 0 END) AS successful_shares,
        SUM(CASE WHEN first_started_at IS NULL AND final_ended_at IS NOT NULL
          THEN 1 ELSE 0 END) AS unstarted_shares,
        SUM(duration_ms) AS share_duration_ms, SUM(viewer_joins) AS viewer_joins,
        SUM(viewer_duration_ms) AS viewer_duration_ms,
        SUM(standard_minutes) AS standard_minutes
      FROM analytics_share_records
      WHERE attributed_at >= ? AND attributed_at < ?
      GROUP BY CAST((attributed_at + ?) / ? AS INTEGER)
      ORDER BY timestamp ASC
    `, [bucketOffset, bucketMs, bucketMs, bucketOffset, window.from, window.to,
      bucketOffset, bucketMs]).map((row) => ({
      timestamp: Number(row.timestamp), successfulShares: Number(row.successful_shares || 0),
      unstartedShares: Number(row.unstarted_shares || 0),
      shareDurationMs: Number(row.share_duration_ms || 0),
      viewerJoins: Number(row.viewer_joins || 0),
      viewerDurationMs: Number(row.viewer_duration_ms || 0),
      standardMinutes: Number(row.standard_minutes || 0),
    }));
    // Include empty usage buckets; missing coverage measurements are never zero-filled.
    const seriesByTime = new Map(recordedSeries.map(point => [point.timestamp, point]));
    const firstAt = window.from || recordedSeries[0]?.timestamp || now;
    const firstBucket = Math.floor((firstAt + bucketOffset) / bucketMs) * bucketMs - bucketOffset;
    const series = [];
    for (let at = firstBucket; at < window.to; at += bucketMs) {
      series.push(seriesByTime.get(at) || { timestamp: at, successfulShares: 0,
        unstartedShares: 0, shareDurationMs: 0, viewerJoins: 0,
        viewerDurationMs: 0, standardMinutes: 0 });
    }
    const coverageSeries = this.db.getAnalyticsRows<any>(`
      SELECT captured_at, total_member_count, successful_server_count, failed_server_count
      FROM analytics_coverage_snapshots WHERE captured_at IN (
        SELECT MAX(captured_at) FROM analytics_coverage_snapshots
        WHERE captured_at >= ? AND captured_at < ?
        GROUP BY CAST((captured_at + ?) / ? AS INTEGER)
      )
      ORDER BY captured_at ASC
    `, [window.from, window.to, bucketOffset, bucketMs]).map((row) => ({
      timestamp: Number(row.captured_at),
      capturedAt: Number(row.captured_at), memberCount: Number(row.total_member_count),
      serversTotal: Number(row.successful_server_count) + Number(row.failed_server_count),
      serversSucceeded: Number(row.successful_server_count),
    }));

    const coverageSeriesByPlatform: Record<string, any[]> = { kook: coverageSeries };
    for (const platform of ['heychat','qq']) {
      coverageSeriesByPlatform[platform] = this.db.getAnalyticsRows<any>(`
        SELECT * FROM analytics_platform_coverage WHERE platform=? AND captured_at IN (
          SELECT MAX(captured_at) FROM analytics_platform_coverage WHERE platform=? AND captured_at>=? AND captured_at<?
          GROUP BY CAST((captured_at + ?) / ? AS INTEGER)) ORDER BY captured_at`,
        [platform, platform, window.from, window.to, bucketOffset, bucketMs]).map(row => ({ timestamp: row.captured_at, memberCount: row.member_count }));
    }
    return {
      coverageSeriesByPlatform,
      range: window,
      attribution: 'first_started_at; unstarted records use created_at',
      summary: {
        successfulShares: successful,
        unstartedShares: notStarted,
        startSuccessRate: completedOutcomes === 0
          ? 0
          : Math.round((successful / completedOutcomes) * 10_000) / 10_000,
        abnormalEnds: Number(summary.abnormal || 0),
        shareDurationMs: Number(summary.duration_ms || 0),
        viewerJoins: Number(summary.viewer_joins || 0),
        viewerDurationMs: Number(summary.viewer_duration_ms || 0),
        standardMinutes: Number(summary.standard_minutes || 0),
        hasEstimatedViewerDuration: !!summary.has_estimated_viewer_duration,
        hasEstimatedStandardMinutes: !!summary.has_estimated_standard_minutes,
      },
      series,
      coverageSeries,
      endReasons: reasons,
      startFailureReasons,
    };
  }

  getRecords(input: AnalyticsRecordsInput) {
    const window = this.resolveRange(input);
    const type = input.type || 'share';
    const page = Math.max(1, this.nonNegativeInteger(input.page, 1));
    const pageSize = Math.min(100, Math.max(1, this.nonNegativeInteger(input.pageSize, 50)));
    if (type === 'server') {
      return this.getServerStateRecords(input, window, page, pageSize);
    }
    if (type === 'server-event') {
      return this.getServerEventRecords(input, window, page, pageSize);
    }
    if (type === 'coverage') return this.getCoverageRecords(window, page, pageSize);
    return this.getShareRecords(input, window, page, pageSize);
  }

  getClientStats(input: AnalyticsRangeInput & { pageType?: AnalyticsPageType }) {
    const window = this.resolveRange(input);
    const effectiveFrom = Math.floor(window.from / HOUR_MS) * HOUR_MS;
    const where = ['bucket_start >= ?', 'bucket_start < ?'];
    const params: unknown[] = [effectiveFrom, window.to];
    if (input.pageType) {
      where.push('page_type = ?');
      params.push(this.normalizePageType(input.pageType));
    }
    const rows = this.db.getAnalyticsRows<any>(`
      SELECT page_type, device_type, os_name, browser_name, browser_major,
             SUM(count) AS count
      FROM analytics_client_stats
      WHERE ${where.join(' AND ')}
      GROUP BY page_type, device_type, os_name, browser_name, browser_major
      ORDER BY count DESC, page_type ASC
      LIMIT 1000
    `, params).map((row) => ({
      pageType: row.page_type,
      deviceType: row.device_type,
      osName: row.os_name,
      browserName: row.browser_name,
      browserMajor: row.browser_major,
      count: Number(row.count),
    }));
    return {
      range: window,
      granularity: 'hour',
      effectiveFrom,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      items: rows,
      truncated: rows.length === 1000,
    };
  }

  resolveRange(input: AnalyticsRangeInput = {}): AnalyticsRangeWindow {
    const preset = (input.range || '24h') as AnalyticsRange;
    const now = Date.now();
    let from: number;
    let to = now;
    if (preset === '24h') from = now - DAY_MS;
    else if (preset === '7d') from = now - 7 * DAY_MS;
    else if (preset === '30d') from = now - 30 * DAY_MS;
    else if (preset === 'month') {
      const beijingNow = new Date(now + BEIJING_OFFSET_MS);
      from = Date.UTC(
        beijingNow.getUTCFullYear(),
        beijingNow.getUTCMonth(),
        1,
      ) - BEIJING_OFFSET_MS;
    } else if (preset === 'all') from = 0;
    else if (preset === 'custom') {
      if (!input.from || !input.to) {
        throw new BadRequestException('custom 范围必须同时提供 from 和 to');
      }
      from = this.parseBoundary(input.from, false);
      to = this.parseBoundary(input.to, true);
    } else {
      throw new BadRequestException('不支持的统计时间范围');
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
      throw new BadRequestException('统计时间范围无效');
    }
    return {
      preset,
      from,
      to,
      timezone: 'Asia/Hong_Kong',
      bucket: preset === '24h' ? 'hour' : 'day',
    };
  }

  // ===== Record query helpers =====

  private getShareRecords(
    input: AnalyticsRecordsInput,
    window: AnalyticsRangeWindow,
    page: number,
    pageSize: number,
  ) {
    const where = ['attributed_at >= ?', 'attributed_at < ?'];
    const params: unknown[] = [window.from, window.to];
    this.addServerFilters(where, params, input);
    if (input.status === 'successful') where.push('first_started_at IS NOT NULL');
    else if (input.status === 'unstarted') {
      where.push('first_started_at IS NULL AND final_ended_at IS NOT NULL');
    } else if (input.status === 'ongoing') {
      where.push('first_started_at IS NOT NULL AND final_ended_at IS NULL');
    } else if (input.status === 'pending') {
      where.push('first_started_at IS NULL AND final_ended_at IS NULL');
    } else if (input.status === 'abnormal') {
      where.push('abnormal_end = 1 AND final_ended_at IS NOT NULL');
    } else if (input.status) {
      where.push('status = ?');
      params.push(this.safeCode(input.status));
    }
    if (input.endReason) { where.push('end_reason = ?'); params.push(this.safeCode(input.endReason)); }
    if (input.outcome === 'success') where.push('first_started_at IS NOT NULL');
    else if (input.outcome === 'not_started') {
      where.push('first_started_at IS NULL AND final_ended_at IS NOT NULL');
    } else if (input.outcome === 'pending') {
      where.push('first_started_at IS NULL AND final_ended_at IS NULL');
    }
    const whereSql = where.join(' AND ');
    const totalRow = this.db.getAnalyticsRow<any>(
      `SELECT COUNT(*) AS count FROM analytics_share_records WHERE ${whereSql}`,
      params,
    );
    const rows = this.db.getAnalyticsRows<ShareRow>(`
      SELECT * FROM analytics_share_records
      WHERE ${whereSql}
      ORDER BY attributed_at DESC, share_id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]);
    const now = Date.now();
    const items = rows.map((row) => this.mapShareRow(row, now));
    return this.pageResult('share', window, page, pageSize, Number(totalRow?.count || 0), items);
  }

  private getServerEventRecords(
    input: AnalyticsRecordsInput,
    window: AnalyticsRangeWindow,
    page: number,
    pageSize: number,
  ) {
    const where = ['occurred_at >= ?', 'occurred_at < ?'];
    const params: unknown[] = [window.from, window.to];
    this.addServerFilters(where, params, input);
    const requestedEvent = input.eventType || input.status;
    if (requestedEvent) {
      const aliases: Record<string, string> = {
        bot_present: 'bot_joined', removed: 'bot_removed', ready: 'share_ready',
      };
      where.push('event_type = ?');
      params.push(this.safeCode(aliases[requestedEvent] || requestedEvent));
    }
    const whereSql = where.join(' AND ');
    const total = this.db.getAnalyticsRow<any>(
      `SELECT COUNT(*) AS count FROM analytics_server_events WHERE ${whereSql}`,
      params,
    );
    const items = this.db.getAnalyticsRows<any>(`
      SELECT id, event_key, server_snowflake_id, server_name,
             event_type, reason, occurred_at
      FROM analytics_server_events
      WHERE ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]).map((row) => ({
      id: Number(row.id),
      eventKey: row.event_key,
      serverSnowflakeId: row.server_snowflake_id,
      serverName: row.server_name,
      platform: this.platformOfSpace(row.server_snowflake_id),
      eventType: row.event_type,
      reason: row.reason,
      occurredAt: Number(row.occurred_at),
    }));
    return this.pageResult('server-event', window, page, pageSize, Number(total?.count || 0), items);
  }

  private getServerStateRecords(
    input: AnalyticsRecordsInput,
    window: AnalyticsRangeWindow,
    page: number,
    pageSize: number,
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.platform) { where.push('platform = ?'); params.push(input.platform); }
    if (input.server) {
      const value = `%${this.safeText(input.server, '', 100)}%`;
      where.push('(server_id LIKE ? COLLATE NOCASE OR guild_name LIKE ? COLLATE NOCASE)');
      params.push(value, value);
    }
    if (input.serverSnowflakeId) {
      where.push('server_id = ?');
      params.push(this.safeId(input.serverSnowflakeId));
    }
    if (input.serverName) {
      where.push('guild_name LIKE ? COLLATE NOCASE');
      params.push(`%${this.safeText(input.serverName, '', 100)}%`);
    }
    if (input.status === 'bot_present') where.push("status = 'active'");
    else if (input.status === 'bound') where.push('bound = 1');
    else if (input.status === 'agora_configured') {
      where.push("TRIM(agora_app_id) != '' AND TRIM(agora_app_certificate) != ''");
    } else if (input.status === 'ready') {
      where.push("status = 'active' AND bound = 1 AND TRIM(agora_app_id) != '' AND TRIM(agora_app_certificate) != ''");
    } else if (input.status === 'removed') where.push("status = 'kicked'");
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.getAnalyticsRow<any>(
      `SELECT COUNT(*) AS count FROM servers ${whereSql}`,
      params,
    );
    const items = this.db.getAnalyticsRows<any>(`
      SELECT server_id, guild_name, status, bound, agora_app_id,
             agora_app_certificate, created_at, updated_at
      FROM servers ${whereSql}
      ORDER BY updated_at DESC, server_id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]).map((row) => {
      const agoraConfigured = !!String(row.agora_app_id || '').trim()
        && !!String(row.agora_app_certificate || '').trim();
      return {
        id: row.server_id,
        serverSnowflakeId: row.server_id,
        serverName: row.guild_name,
        platform: this.platformOfSpace(row.server_id),
        botPresent: row.status === 'active',
        bound: !!row.bound,
        agoraConfigured,
        ready: row.status === 'active' && !!row.bound && agoraConfigured,
        removed: row.status === 'kicked',
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
      };
    });
    return this.pageResult('server', window, page, pageSize, Number(total?.count || 0), items);
  }

  private getCoverageRecords(
    window: AnalyticsRangeWindow,
    page: number,
    pageSize: number,
  ) {
    const params = [window.from, window.to];
    const total = this.db.getAnalyticsRow<any>(`
      SELECT COUNT(*) AS count FROM analytics_coverage_snapshots
      WHERE captured_at >= ? AND captured_at < ?
    `, params);
    const items = this.db.getAnalyticsRows<any>(`
      SELECT snapshot_key, captured_at, total_member_count,
             successful_server_count, failed_server_count
      FROM analytics_coverage_snapshots
      WHERE captured_at >= ? AND captured_at < ?
      ORDER BY captured_at DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]).map((row) => ({
      snapshotKey: row.snapshot_key,
      capturedAt: Number(row.captured_at),
      totalMemberCount: Number(row.total_member_count),
      successfulServerCount: Number(row.successful_server_count),
      failedServerCount: Number(row.failed_server_count),
    }));
    return this.pageResult('coverage', window, page, pageSize, Number(total?.count || 0), items);
  }

  private addServerFilters(
    where: string[],
    params: unknown[],
    input: Pick<AnalyticsRecordsInput, 'server' | 'serverSnowflakeId' | 'serverName' | 'platform'>,
  ): void {
    if (input.platform) {
      where.push("COALESCE((SELECT platform FROM servers WHERE server_id=server_snowflake_id), CASE WHEN server_snowflake_id LIKE 'qq:%' THEN 'qq' WHEN server_snowflake_id LIKE 'heychat:%' THEN 'heychat' ELSE 'kook' END) = ?");
      params.push(input.platform);
    }
    if (input.server) {
      where.push('(server_snowflake_id LIKE ? COLLATE NOCASE OR server_name LIKE ? COLLATE NOCASE)');
      const value = `%${this.safeText(input.server, '', 100)}%`;
      params.push(value, value);
    }
    if (input.serverSnowflakeId) {
      where.push('server_snowflake_id = ?');
      params.push(this.safeId(input.serverSnowflakeId));
    }
    if (input.serverName) {
      where.push('server_name LIKE ? COLLATE NOCASE');
      params.push(`%${this.safeText(input.serverName, '', 100)}%`);
    }
  }

  private pageResult(
    type: string,
    range: AnalyticsRangeWindow,
    page: number,
    pageSize: number,
    total: number,
    items: unknown[],
  ) {
    return {
      type,
      range,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      items,
    };
  }

  private mapShareRow(row: ShareRow, now: number) {
    const durationMs = row.first_started_at == null
      ? 0
      : row.final_ended_at == null
        ? Math.max(Number(row.duration_ms), now - Number(row.first_started_at))
        : Math.max(
            Number(row.duration_ms),
            Number(row.final_ended_at) - Number(row.first_started_at),
          );
    const standardMinutes = row.final_ended_at == null
      ? this.calculateStandardMinutes(
          durationMs,
          Number(row.viewer_duration_ms),
          row.quality,
          !!row.low_latency,
        )
      : Number(row.standard_minutes);
    return {
      id: row.share_id,
      shareId: row.share_id,
      serverSnowflakeId: row.server_snowflake_id,
      serverName: row.server_name,
      platform: this.platformOfSpace(row.server_snowflake_id),
      createdAt: Number(row.created_at),
      attributedAt: Number(row.attributed_at),
      startedAt: row.first_started_at == null ? null : Number(row.first_started_at),
      endedAt: row.final_ended_at == null ? null : Number(row.final_ended_at),
      firstStartedAt: row.first_started_at == null ? null : Number(row.first_started_at),
      finalEndedAt: row.final_ended_at == null ? null : Number(row.final_ended_at),
      status: row.status,
      outcome: row.first_started_at != null
        ? 'success'
        : row.final_ended_at != null ? 'not_started' : 'pending',
      endReason: row.end_reason,
      startFailureReason: row.start_failure_reason,
      abnormalEnd: !!row.abnormal_end,
      peakViewers: Number(row.peak_viewers),
      durationMs,
      viewerJoins: Number(row.viewer_joins),
      viewerDurationMs: Number(row.viewer_duration_ms),
      viewerDurationEstimated: !!row.viewer_duration_estimated,
      standardMinutes,
      standardMinutesEstimated: !!row.standard_minutes_estimated,
      quality: row.quality,
      lowLatency: !!row.low_latency,
      updatedAt: Number(row.updated_at),
    };
  }

  // ===== Normalization and billing helpers =====

  private calculateStandardMinutes(
    durationMs: number,
    viewerDurationMs: number,
    quality: string,
    lowLatency: boolean,
  ): number {
    if (durationMs <= 0) return 0;
    const broadcasterStandardSec = (durationMs / 1000)
      * getAudioCoefficient(lowLatency, true);
    const qualityTier = getQualityInfo(quality).tier;
    const viewerStandardSec = (viewerDurationMs / 1000)
      * getVideoCoefficient(qualityTier, lowLatency);
    return Math.ceil((broadcasterStandardSec + viewerStandardSec) / 60);
  }

  private backfillMissingStandardMinutes(): void {
    const rows = this.db.getAnalyticsRows<ShareRow>(`
      SELECT * FROM analytics_share_records
      WHERE first_started_at IS NOT NULL
        AND duration_ms > 0
        AND standard_minutes <= 0
    `);
    const update = `
      UPDATE analytics_share_records
      SET standard_minutes = ?, standard_minutes_estimated = 1
      WHERE share_id = ? AND standard_minutes <= 0
    `;
    this.db.runAnalyticsTransaction(() => {
      for (const row of rows) {
        this.db.runAnalytics(update, [
          this.calculateStandardMinutes(
            Number(row.duration_ms),
            Number(row.viewer_duration_ms),
            row.quality,
            !!row.low_latency,
          ),
          row.share_id,
        ]);
      }
    });
  }

  private getServerSnapshot(session: ServerSession) {
    const serverSnowflakeId = this.safeId(session.serverId || session.guildId || 'unknown');
    return {
      serverSnowflakeId,
      serverName: this.resolveServerName(serverSnowflakeId),
    };
  }

  private resolveServerName(serverSnowflakeId: string, supplied?: string): string {
    const explicit = this.safeText(supplied, '');
    if (explicit) return explicit;
    const server = this.db.getServer(serverSnowflakeId);
    return this.safeText(server?.guildName, '未知服务器', 200);
  }

  private getSessionDurationMs(session: ServerSession): number {
    if (!session.startedAt) return 0;
    if (session.durationMs != null) return this.nonNegativeInteger(session.durationMs);
    return Math.max(0, (session.endedAt || Date.now()) - session.startedAt);
  }

  private inferAbnormalEnd(reason: string): boolean {
    return /(error|failure|failed|heartbeat|disconnect|crash|unexpected)/i.test(reason);
  }

  private prunePresence(now: number): void {
    for (const [pageType, entries] of this.presence) {
      const cutoff = now - this.presenceTtlMs[pageType];
      for (const [key, entry] of entries) {
        if (entry.lastSeenAt < cutoff) entries.delete(key);
      }
    }
  }

  private normalizePageType(pageType: AnalyticsPageTypeInput): AnalyticsPageType {
    if (pageType === 'admin') return 'server_admin';
    if (pageType === 'share' || pageType === 'view' || pageType === 'server_admin') {
      return pageType;
    }
    throw new BadRequestException('未知页面类型');
  }

  private presenceKey(value: string): string {
    const key = String(value || '').slice(0, 200);
    if (!key) throw new BadRequestException('connectionId 不能为空');
    return key;
  }

  private parseBoundary(value: string, dateOnlyEnd: boolean): number {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return trimmed.length === 10 ? numeric * 1000 : numeric;
    }
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const parsed = Date.parse(dateOnly ? `${trimmed}T00:00:00+08:00` : trimmed);
    if (!Number.isFinite(parsed)) throw new BadRequestException('from/to 时间格式无效');
    return dateOnly && dateOnlyEnd ? parsed + DAY_MS : parsed;
  }

  private safeText(value: unknown, fallback = 'unknown', maxLength = 200): string {
    const normalized = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
    return (normalized || fallback).slice(0, maxLength);
  }

  private safeId(value: unknown, maxLength = 128): string {
    return this.safeText(value, 'unknown', maxLength);
  }

  private safeCode(value: unknown, fallback = 'unknown'): string {
    const normalized = String(value ?? '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_');
    return (normalized || fallback).slice(0, 100);
  }

  private safeEnumDimension(
    value: unknown,
    allowed: ReadonlySet<string>,
    fallback: string,
  ): string {
    const normalized = this.safeText(value, fallback, 50);
    return allowed.has(normalized) ? normalized : fallback;
  }

  private safeBrowserMajor(value: unknown): string {
    const match = String(value ?? '').match(/^\d{1,4}$/);
    return match ? match[0] : 'unknown';
  }

  private nonNegativeInteger(value: unknown, fallback = 0): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
  }

  private nonNegativeNumber(value: unknown, fallback = 0): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
  }
}
