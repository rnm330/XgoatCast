import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomBytes, randomInt } from 'crypto';
import { getDefaultQualityBitrates, QualityBitrateConfig } from '../session/session.types';

// ===== Types =====

export interface GlobalConfig {
  kookBotToken: string;
  kookVerifyToken: string;
  kookEncryptKey: string;
  heychatBotId: string;
  heychatBotToken: string;
  publicDomain: string;
  triggerWordLabels: string[];
  qualityBitrates: QualityBitrateConfig;
  legacyAdminSunsetAt: number;
}

export interface KookWebhookEventRecord {
  receivedAt: number;
  eventKey: string;
  sn: number | null;
  eventType: string;
  payload: string;
  attempts: number;
}

export interface ServerRecord {
  serverId: string;       // 兼容字段：内部 spaceId，现有 KOOK 数据仍等于 guild_id
  platform: string;       // 'kook'，未来可扩展 'qq' | 'discord'
  externalId: string;     // 平台外部 ID；KOOK 为 guild_id 雪花 ID
  openId: string;         // open_id 公开 ID（用于面板显示）
  guildName: string;
  ownerId: string;
  ownerUsername: string;
  passwordHash: string;
  bound: number; // 0 or 1
  status: string; // 'active' | 'kicked'
  agoraAppId: string;
  agoraAppCertificate: string;
  agoraTokenExpireSec: number;
  allowedQualities: string; // JSON array
  triggerWords: string;
  idleTimeoutSec: number;
  heartbeatIntervalSec: number;
  noViewerTimeoutSec: number;
  publicDomain: string;
  allowQualityPreference: number; // 1=允许共享者选择清晰度或帧率优先（默认）
  allowLowLatency: number; // 0=不允许低延迟模式，1=允许共享者切换
  reboundAt: number;      // 重新绑定时间戳（被踢出后重新绑定时记录，用于过滤旧会话）
  bindToken: string;      // 绑定临时 token
  bindTokenExpires: number; // 绑定 token 过期时间戳
  serverSecret: string;   // 每服务器独立的 HMAC 签名密钥
  createdAt: number;
  updatedAt: number;
}

export interface CreateSpaceInput {
  platform: string;
  externalId: string;
  /** Existing KOOK spaces keep guild_id as their internal ID for compatibility. */
  spaceId?: string;
  displayName: string;
  ownerId: string;
  ownerUsername?: string;
  publicId?: string;
}

export type HeychatBindingIntentState = 'active' | 'authorized' | 'revoked' | 'expired';
export type HeychatBindingClaimState = 'pending' | 'authorized' | 'revoked' | 'expired';

export interface HeychatBindingIntentRecord {
  intentId: string;
  spaceId: string;
  roomId: string;
  ownerId: string;
  state: HeychatBindingIntentState;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface HeychatBindingClaimRecord {
  claimId: string;
  intentId: string;
  roomId: string;
  code: string;
  state: HeychatBindingClaimState;
  expiresAt: number;
  authorizedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type NoticeKind = 'banner' | 'modal';
export type NoticeModalPolicy = 'dismissible' | 'acknowledgement_required';
export type NoticeContentFormat = 'text' | 'html';
export type NoticeTargetPage = 'server_admin' | 'share' | 'view';

export interface NoticeRecord {
  id: string;
  kind: NoticeKind;
  modalPolicy: NoticeModalPolicy | null;
  title: string;
  contentFormat: NoticeContentFormat;
  content: string;
  imageUrl: string;
  enabled: number;
  sortOrder: number;
  repeatAfterSec: number | null;
  revision: number;
  targets: NoticeTargetPage[];
  createdAt: number;
  updatedAt: number;
}

export interface NoticeWriteInput {
  kind: NoticeKind;
  modalPolicy?: NoticeModalPolicy | null;
  title?: string;
  contentFormat: NoticeContentFormat;
  content: string;
  imageUrl?: string;
  enabled: boolean;
  sortOrder: number;
  repeatAfterSec?: number | null;
  targets: NoticeTargetPage[];
}

export interface ServerEvent {
  id: number;
  serverId: string;
  eventType: string; // 'bot_joined' | 'bot_kicked' | 'bot_left'
  operatorId: string;
  operatorName: string;
  detail: string;
  createdAt: number;
}

export interface ServerSession {
  id: string;
  token: string;
  channel: string;
  serverId: string;
  sharerUserId: string;
  sharerUsername: string;
  guildId: string;
  targetChannelId: string;
  status: string;
  viewerCount: number;
  peakViewers: number;
  totalViewerJoins: number;
  /** 所有观众在 ACTIVE 状态下的累计在线毫秒；null 表示旧记录没有该数据 */
  viewerDurationMs: number | null;
  quality: string;
  cardMessageId: string | null;
  manualCreated: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  lastHeartbeat: number;
  graceStartedAt: number | null;
  graceReason: string | null;
  lastViewerAt: number | null;
  publisherClientId: string | null;
  lowLatency: number; // 0=极速直播(默认)，1=低延迟模式(rtc)
}

const HEYCHAT_BIND_INTENT_TTL_MS = 10 * 60 * 1000;
const HEYCHAT_BIND_CLAIM_TTL_MS = 10 * 60 * 1000;
const HEYCHAT_BIND_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const HEYCHAT_BIND_CODE_LENGTH = 8;

// ===== Service =====

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly db: Database.Database;

  constructor() {
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = join(dataDir, 'xgoatcast.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.logger.log(`SQLite database ready at ${dbPath}`);
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      this.logger.log('SQLite database closed');
    }
  }

  /** Integration repositories share transactions with space/session writes. */
  get integrationDatabase(): Database.Database {
    return this.db;
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS panel_accounts (
        id TEXT PRIMARY KEY COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        space_id TEXT NOT NULL UNIQUE REFERENCES servers(server_id) ON DELETE CASCADE,
        access_hash TEXT NOT NULL DEFAULT '',
        access_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS panel_rooms (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        panel_id TEXT NOT NULL REFERENCES panel_accounts(id) ON DELETE CASCADE,
        view_token TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_panel_rooms_panel ON panel_rooms(panel_id, session_id);
      CREATE TABLE IF NOT EXISTS panel_email_codes (
        email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(email, purpose)
      );
      CREATE INDEX IF NOT EXISTS idx_panel_email_expiry ON panel_email_codes(expires_at);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_card_jobs (
        job_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_attempt_at INTEGER,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT NOT NULL DEFAULT ''
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        server_id              TEXT PRIMARY KEY,  -- guild_id 雪花 ID（不变，用于主键和 URL）
        platform               TEXT NOT NULL DEFAULT 'kook',
        external_id            TEXT NOT NULL DEFAULT '',
        open_id                TEXT NOT NULL DEFAULT '',  -- open_id 公开 ID（用于面板显示）
        guild_name             TEXT NOT NULL DEFAULT '',
        owner_id               TEXT NOT NULL DEFAULT '',
        owner_username         TEXT NOT NULL DEFAULT '',
        password_hash          TEXT NOT NULL DEFAULT '',
        bound                  INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'kicked'
        agora_app_id           TEXT NOT NULL DEFAULT '',
        agora_app_certificate  TEXT NOT NULL DEFAULT '',
        agora_token_expire_sec INTEGER NOT NULL DEFAULT 3600,
        allowed_qualities      TEXT NOT NULL DEFAULT '["480p_2","720p30","1080p_2","1080p60","1440p30","1440p60","4k30"]',
        trigger_words          TEXT NOT NULL DEFAULT '屏幕共享,共享屏幕',
        idle_timeout_sec       INTEGER NOT NULL DEFAULT 60,
        heartbeat_interval_sec INTEGER NOT NULL DEFAULT 5,
        no_viewer_timeout_sec  INTEGER NOT NULL DEFAULT 180,
        public_domain          TEXT NOT NULL DEFAULT '',
        created_at             INTEGER NOT NULL DEFAULT 0,
        updated_at             INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS server_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id     TEXT NOT NULL,
        event_type    TEXT NOT NULL,  -- 'bot_joined' | 'bot_kicked' | 'bot_left'
        operator_id   TEXT NOT NULL DEFAULT '',
        operator_name TEXT NOT NULL DEFAULT '',
        detail        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id);

      -- Migration: add open_id column if missing
      PRAGMA table_info(servers);
    `);

    // Check and add open_id column if it doesn't exist
    const columns = this.db.prepare("PRAGMA table_info(servers)").all() as any[];
    if (!columns.some(c => c.name === 'open_id')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN open_id TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added open_id column to servers table');
    }
    if (!columns.some(c => c.name === 'status')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      this.logger.log('Added status column to servers table');
    }
    if (!columns.some(c => c.name === 'allow_quality_preference')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN allow_quality_preference INTEGER NOT NULL DEFAULT 1`);
    }
    if (!columns.some(c => c.name === 'allow_low_latency')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN allow_low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added allow_low_latency column to servers table');
    }
    if (!columns.some(c => c.name === 'platform')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN platform TEXT NOT NULL DEFAULT 'kook'`);
      this.logger.log('Added platform column to servers table');
    }
    if (!columns.some(c => c.name === 'external_id')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN external_id TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added external_id column to servers table');
    }
    this.db.exec(`
      UPDATE servers
      SET platform = 'kook'
      WHERE platform IS NULL OR platform = '';

      UPDATE servers
      SET external_id = server_id
      WHERE external_id IS NULL OR external_id = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_platform_external_id
      ON servers(platform, external_id);
    `);

    // Migrate servers table: add rebound_at column if missing
    const serverCols = this.db.prepare("PRAGMA table_info(servers)").all() as any[];
    if (!serverCols.some(c => c.name === 'rebound_at')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN rebound_at INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added rebound_at column to servers table');
    }
    if (!serverCols.some(c => c.name === 'bind_token')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN bind_token TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added bind_token column to servers table');
    }
    if (!serverCols.some(c => c.name === 'bind_token_expires')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN bind_token_expires INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added bind_token_expires column to servers table');
    }
    if (!serverCols.some(c => c.name === 'server_secret')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN server_secret TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added server_secret column to servers table');

      // Auto-generate secrets for existing servers (retrofit legacy shared-secret setup)
      const existing = this.db.prepare("SELECT server_id, server_secret FROM servers WHERE server_secret = ''").all() as any[];
      for (const row of existing) {
        const secret = randomBytes(32).toString('hex');
        this.db.prepare("UPDATE servers SET server_secret = ? WHERE server_id = ?").run(secret, row.server_id);
        this.logger.log(`Generated server_secret for existing server ${row.server_id}`);
      }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS sessions (
        id                  TEXT PRIMARY KEY,
        token               TEXT NOT NULL UNIQUE,
        channel             TEXT NOT NULL,
        server_id           TEXT NOT NULL DEFAULT '',
        sharer_user_id      TEXT NOT NULL,
        sharer_username     TEXT NOT NULL,
        guild_id            TEXT NOT NULL DEFAULT '',
        target_channel_id   TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'pending',
        viewer_count        INTEGER NOT NULL DEFAULT 0,
        peak_viewers        INTEGER NOT NULL DEFAULT 0,
        total_viewer_joins  INTEGER NOT NULL DEFAULT 0,
        viewer_duration_ms  INTEGER NOT NULL DEFAULT 0,
        quality             TEXT NOT NULL DEFAULT '1080p_2',
        card_message_id     TEXT,
        manual_created      INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL DEFAULT 0,
        started_at          INTEGER,
        ended_at            INTEGER,
        duration_ms         INTEGER,
        last_heartbeat      INTEGER NOT NULL DEFAULT 0,
        grace_started_at    INTEGER,
        grace_reason        TEXT,
        last_viewer_at      INTEGER,
        publisher_client_id TEXT,
        low_latency         INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_server_id ON sessions(server_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_space_status_created ON sessions(server_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_space_created ON sessions(server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_panel_live_sessions ON sessions(server_id, created_at DESC, id DESC) WHERE status IN ('active', 'grace');

      CREATE TABLE IF NOT EXISTS notices (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        modal_policy      TEXT,
        title             TEXT NOT NULL DEFAULT '',
        content_format    TEXT NOT NULL DEFAULT 'text',
        content           TEXT NOT NULL DEFAULT '',
        image_url         TEXT NOT NULL DEFAULT '',
        enabled           INTEGER NOT NULL DEFAULT 1,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        repeat_after_sec  INTEGER,
        revision          INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS notice_targets (
        notice_id TEXT NOT NULL,
        page      TEXT NOT NULL,
        PRIMARY KEY (notice_id, page),
        FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_notices_enabled_order
      ON notices(enabled, sort_order);

      CREATE INDEX IF NOT EXISTS idx_notice_targets_page
      ON notice_targets(page);

      CREATE TABLE IF NOT EXISTS kook_webhook_events (
        event_key       TEXT PRIMARY KEY,
        event_id        TEXT NOT NULL DEFAULT '',
        sn              INTEGER,
        event_type      TEXT NOT NULL DEFAULT '',
        payload         TEXT NOT NULL,
        payload_hash    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        locked_at       INTEGER,
        last_error_code TEXT NOT NULL DEFAULT '',
        received_at     INTEGER NOT NULL,
        processed_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_claim
      ON kook_webhook_events(status, next_attempt_at, received_at);

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_sn
      ON kook_webhook_events(sn, received_at);

      CREATE TABLE IF NOT EXISTS kook_webhook_effects (
        effect_key   TEXT PRIMARY KEY,
        event_key    TEXT NOT NULL UNIQUE,
        status       TEXT NOT NULL DEFAULT 'processing',
        result       TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        FOREIGN KEY (event_key) REFERENCES kook_webhook_events(event_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_effect_status
      ON kook_webhook_effects(status, updated_at);

      CREATE TABLE IF NOT EXISTS heychat_binding_intents (
        intent_id   TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        room_id     TEXT NOT NULL,
        owner_id    TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'active',
        expires_at  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (space_id) REFERENCES servers(server_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_heychat_binding_intents_room_state
      ON heychat_binding_intents(room_id, state, expires_at);

      CREATE TABLE IF NOT EXISTS heychat_binding_claims (
        claim_id       TEXT PRIMARY KEY,
        intent_id      TEXT NOT NULL,
        room_id        TEXT NOT NULL,
        secret_hash    TEXT NOT NULL,
        code           TEXT NOT NULL,
        state          TEXT NOT NULL DEFAULT 'pending',
        expires_at     INTEGER NOT NULL,
        authorized_at  INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE (room_id, code),
        FOREIGN KEY (intent_id) REFERENCES heychat_binding_intents(intent_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_heychat_binding_claims_intent_state
      ON heychat_binding_claims(intent_id, state, expires_at);
    `);

    // Migrate sessions table: add low_latency column if missing
    const sessCols = this.db.prepare("PRAGMA table_info(sessions)").all() as any[];
    if (!sessCols.some(c => c.name === 'low_latency')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added low_latency column to sessions table');
    }
    if (!sessCols.some(c => c.name === 'viewer_duration_ms')) {
      // 旧记录保留 NULL，计费展示时继续使用旧的峰值人数估算。
      this.db.exec(`ALTER TABLE sessions ADD COLUMN viewer_duration_ms INTEGER`);
      this.logger.log('Added viewer_duration_ms column to sessions table');
    }

    // Anonymous analytics storage. These tables intentionally contain no user,
    // channel, token, IP address, client identifier, or raw user-agent fields.
    const needsAnalyticsLegacyBackfill = !this.db.prepare(
      "SELECT 1 FROM global_config WHERE key = 'analyticsLegacyBackfillV1'",
    ).get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_share_records (
        share_id                    TEXT PRIMARY KEY,
        server_snowflake_id         TEXT NOT NULL,
        server_name                 TEXT NOT NULL,
        created_at                  INTEGER NOT NULL,
        attributed_at               INTEGER NOT NULL,
        first_started_at            INTEGER,
        final_ended_at              INTEGER,
        status                      TEXT NOT NULL DEFAULT 'pending',
        end_reason                  TEXT NOT NULL DEFAULT '',
        abnormal_end                INTEGER NOT NULL DEFAULT 0,
        start_failure_reason        TEXT NOT NULL DEFAULT '',
        peak_viewers                INTEGER NOT NULL DEFAULT 0,
        duration_ms                 INTEGER NOT NULL DEFAULT 0,
        viewer_joins                INTEGER NOT NULL DEFAULT 0,
        viewer_duration_ms          INTEGER NOT NULL DEFAULT 0,
        viewer_duration_estimated   INTEGER NOT NULL DEFAULT 0,
        standard_minutes            REAL NOT NULL DEFAULT 0,
        standard_minutes_estimated  INTEGER NOT NULL DEFAULT 1,
        quality                     TEXT NOT NULL DEFAULT '1080p_2',
        low_latency                 INTEGER NOT NULL DEFAULT 0,
        updated_at                  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_share_attributed
      ON analytics_share_records(attributed_at DESC, share_id DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_share_status
      ON analytics_share_records(status, attributed_at DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_share_server_time
      ON analytics_share_records(server_snowflake_id, attributed_at DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_share_name_time
      ON analytics_share_records(server_name COLLATE NOCASE, attributed_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_server_events (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key            TEXT NOT NULL UNIQUE,
        server_snowflake_id  TEXT NOT NULL,
        server_name          TEXT NOT NULL,
        event_type           TEXT NOT NULL,
        reason               TEXT NOT NULL DEFAULT '',
        occurred_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_server_events_time
      ON analytics_server_events(occurred_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_server_events_server_time
      ON analytics_server_events(server_snowflake_id, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_server_events_name_time
      ON analytics_server_events(server_name COLLATE NOCASE, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS idx_analytics_server_events_type_time
      ON analytics_server_events(event_type, occurred_at DESC);

      -- Backfill the legacy server lifecycle log without carrying operator
      -- identity or free-form details into anonymous analytics storage. Newer
      -- releases briefly wrote both tables, so suppress an equivalent event
      -- recorded for the same server within one second.
      INSERT OR IGNORE INTO analytics_server_events (
        event_key, server_snowflake_id, server_name,
        event_type, reason, occurred_at
      )
      SELECT
        'legacy_server_event:' || legacy.id,
        legacy.server_id,
        COALESCE(NULLIF(server.guild_name, ''), '未知服务器'),
        CASE legacy.event_type
          WHEN 'bot_kicked' THEN 'bot_removed'
          WHEN 'bot_left' THEN 'bot_removed'
          ELSE legacy.event_type
        END,
        '',
        legacy.created_at
      FROM server_events legacy
      LEFT JOIN servers server ON server.server_id = legacy.server_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM analytics_server_events current
        WHERE current.server_snowflake_id = legacy.server_id
          AND current.event_key NOT LIKE 'legacy_server_event:%'
          AND current.event_type = CASE legacy.event_type
            WHEN 'bot_kicked' THEN 'bot_removed'
            WHEN 'bot_left' THEN 'bot_removed'
            ELSE legacy.event_type
          END
          AND ABS(current.occurred_at - legacy.created_at) <= 1000
      );

      CREATE TABLE IF NOT EXISTS analytics_coverage_snapshots (
        snapshot_key             TEXT PRIMARY KEY,
        captured_at              INTEGER NOT NULL,
        total_member_count       INTEGER NOT NULL,
        successful_server_count  INTEGER NOT NULL,
        failed_server_count      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_coverage_time
      ON analytics_coverage_snapshots(captured_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_server_member_counts (
        server_snowflake_id  TEXT PRIMARY KEY,
        member_count         INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_member_counts_updated
      ON analytics_server_member_counts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_client_stats (
        bucket_start   INTEGER NOT NULL,
        page_type      TEXT NOT NULL,
        device_type    TEXT NOT NULL,
        os_name        TEXT NOT NULL,
        browser_name   TEXT NOT NULL,
        browser_major  TEXT NOT NULL,
        count          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (
          bucket_start, page_type, device_type, os_name,
          browser_name, browser_major
        )
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_analytics_client_stats_page_time
      ON analytics_client_stats(page_type, bucket_start DESC);

      -- One-time, idempotent anonymized backfill from legacy sessions. Only the
      -- server snapshot and aggregate usage fields cross into analytics storage.
      INSERT OR IGNORE INTO analytics_share_records (
        share_id, server_snowflake_id, server_name, created_at, attributed_at,
        first_started_at, final_ended_at, status, end_reason, abnormal_end,
        duration_ms, viewer_joins, viewer_duration_ms,
        viewer_duration_estimated, standard_minutes,
        standard_minutes_estimated, quality, low_latency, updated_at
      )
      SELECT
        s.id,
        COALESCE(NULLIF(s.server_id, ''), NULLIF(s.guild_id, ''), ''),
        COALESCE(NULLIF(v.guild_name, ''), '未知服务器'),
        s.created_at,
        COALESCE(s.started_at, s.created_at),
        s.started_at,
        s.ended_at,
        CASE
          WHEN s.ended_at IS NOT NULL THEN 'ended'
          WHEN s.started_at IS NOT NULL THEN 'ongoing'
          ELSE 'pending'
        END,
        CASE WHEN s.ended_at IS NOT NULL THEN 'legacy_unknown' ELSE '' END,
        0,
        COALESCE(s.duration_ms, 0),
        COALESCE(s.total_viewer_joins, 0),
        CASE
          WHEN s.viewer_duration_ms IS NULL
            THEN COALESCE(s.peak_viewers, 0) * COALESCE(s.duration_ms, 0)
          ELSE s.viewer_duration_ms
        END,
        CASE WHEN s.viewer_duration_ms IS NULL THEN 1 ELSE 0 END,
        0,
        1,
        COALESCE(NULLIF(s.quality, ''), '1080p_2'),
        COALESCE(s.low_latency, 0),
        COALESCE(s.ended_at, s.last_heartbeat, s.created_at)
      FROM sessions s
      LEFT JOIN servers v
        ON v.server_id = COALESCE(NULLIF(s.server_id, ''), NULLIF(s.guild_id, ''))
      WHERE NOT EXISTS (
        SELECT 1 FROM global_config WHERE key = 'analyticsLegacyBackfillV1'
      );
    `);
    const analyticsShareCols = this.db.prepare(
      'PRAGMA table_info(analytics_share_records)',
    ).all() as any[];
    if (!analyticsShareCols.some((column) => column.name === 'start_failure_reason')) {
      this.db.exec("ALTER TABLE analytics_share_records ADD COLUMN start_failure_reason TEXT NOT NULL DEFAULT ''");
    }
    const addedPeakViewers = !analyticsShareCols.some((column) => column.name === 'peak_viewers');
    if (addedPeakViewers) {
      this.db.exec('ALTER TABLE analytics_share_records ADD COLUMN peak_viewers INTEGER NOT NULL DEFAULT 0');
    }
    if (needsAnalyticsLegacyBackfill) {
      this.db.exec(`
        UPDATE analytics_share_records
        SET peak_viewers = COALESCE((
          SELECT peak_viewers FROM sessions WHERE sessions.id = analytics_share_records.share_id
        ), peak_viewers)
        WHERE peak_viewers = 0;
      `);
    }

    // Seed default global config if empty
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM global_config').get() as any;
    if (row.cnt === 0) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)');
      ins.run('kookBotToken', process.env.KOOK_BOT_TOKEN || '');
      ins.run('publicDomain', 'http://localhost:3520');
      ins.run('triggerWordLabels', JSON.stringify(['屏幕共享', '共享屏幕']));
      this.logger.log('Seeded default global config');
    }
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookVerifyToken', '')",
    ).run();
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookEncryptKey', '')",
    ).run();
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('heychatBotToken', '')",
    ).run();
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('heychatBotId', '')",
    ).run();
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('analyticsLegacyBackfillV1', 'complete')",
    ).run();

    // Preserve every existing per-server trigger word when introducing the
    // global label library.
    const labelRow = this.db.prepare("SELECT value FROM global_config WHERE key = 'triggerWordLabels'").get() as any;
    if (!labelRow) {
      const labels = new Set(['屏幕共享', '共享屏幕']);
      const existing = this.db.prepare('SELECT trigger_words FROM servers').all() as any[];
      for (const row of existing) {
        for (const word of this.parseTriggerWords(row.trigger_words)) labels.add(word);
      }
      this.setGlobalConfig('triggerWordLabels', JSON.stringify([...labels]));
      this.logger.log('Created global trigger word label library from existing server settings');
    }

    // Backfill empty kookBotToken from env (for existing databases)
    if (process.env.KOOK_BOT_TOKEN) {
      const current = this.db.prepare("SELECT value FROM global_config WHERE key = 'kookBotToken'").get() as any;
      if (!current || !current.value) {
        this.db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('kookBotToken', ?)").run(process.env.KOOK_BOT_TOKEN);
        this.logger.log('Backfilled kookBotToken from KOOK_BOT_TOKEN env');
      }
    }

    if (process.env.HEYCHAT_BOT_TOKEN) {
      const current = this.db.prepare("SELECT value FROM global_config WHERE key = 'heychatBotToken'").get() as any;
      if (!current || !current.value) {
        this.db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('heychatBotToken', ?)").run(process.env.HEYCHAT_BOT_TOKEN);
        this.logger.log('Backfilled heychatBotToken from HEYCHAT_BOT_TOKEN env');
      }
    }
    if (process.env.HEYCHAT_BOT_ID) {
      const current = this.db.prepare("SELECT value FROM global_config WHERE key = 'heychatBotId'").get() as any;
      if (!current || !current.value) {
        this.db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('heychatBotId', ?)").run(process.env.HEYCHAT_BOT_ID);
        this.logger.log('Backfilled heychatBotId from HEYCHAT_BOT_ID env');
      }
    }

    const sunset = this.db.prepare("SELECT value FROM global_config WHERE key = 'legacyAdminSunsetAt'").get() as any;
    if (!sunset) {
      const configured = Date.parse(process.env.LEGACY_ADMIN_SUNSET_AT || '');
      const sunsetAt = Number.isFinite(configured)
        ? configured
        : Date.now() + 30 * 24 * 60 * 60 * 1000;
      this.setGlobalConfig('legacyAdminSunsetAt', String(sunsetAt));
      this.logger.log(`Created legacy admin sunset time ${new Date(sunsetAt).toISOString()}`);
    }

    const defaultNoticeId = 'view-adaptive-bitrate';
    const defaultNotice = this.db.prepare('SELECT id FROM notices WHERE id = ?').get(defaultNoticeId);
    if (!defaultNotice) {
      const now = Date.now();
      const insertDefaultNotice = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO notices (
            id, kind, modal_policy, title, content_format, content, image_url,
            enabled, sort_order, repeat_after_sec, revision, created_at, updated_at
          ) VALUES (?, 'banner', NULL, '', 'text', ?, '', 1, 0, ?, 1, ?, ?)
        `).run(
          defaultNoticeId,
          '首次接入时系统将根据网络情况动态调整码率，稍加等待视频会逐步增加清晰度和流畅度。',
          7 * 24 * 60 * 60,
          now,
          now,
        );
        this.db.prepare('INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)').run(defaultNoticeId, 'view');
      });
      insertDefaultNotice();
      this.logger.log('Seeded default adaptive bitrate notice');
    }
    this.db.pragma('optimize');
  }

  // ===== Global Config =====

  getGlobalConfig(): GlobalConfig {
    const rows = this.db.prepare('SELECT key, value FROM global_config').all() as any[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);
    return {
      kookBotToken: map.get('kookBotToken') || '',
      kookVerifyToken: map.get('kookVerifyToken') || '',
      kookEncryptKey: map.get('kookEncryptKey') || '',
      heychatBotId: map.get('heychatBotId') || '',
      heychatBotToken: map.get('heychatBotToken') || '',
      publicDomain: map.get('publicDomain') || 'http://localhost:3520',
      triggerWordLabels: this.parseTriggerWordLabels(map.get('triggerWordLabels')),
      qualityBitrates: this.parseQualityBitrates(map.get('qualityBitrates')),
      legacyAdminSunsetAt: Number(map.get('legacyAdminSunsetAt')) || 0,
    };
  }

  private parseTriggerWords(value?: string): string[] {
    return [...new Set((value || '').split(',').map(word => word.trim()).filter(Boolean))];
  }

  private parseTriggerWordLabels(value?: string): string[] {
    if (!value) return ['屏幕共享', '共享屏幕'];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const labels = [...new Set(parsed.map(String).map(word => word.trim()).filter(Boolean))];
        if (labels.length > 0) return labels;
      }
    } catch {
      // Fall through to legacy comma-separated values.
    }
    const legacy = this.parseTriggerWords(value);
    return legacy.length > 0 ? legacy : ['屏幕共享', '共享屏幕'];
  }

  setTriggerWordLabels(labels: string[]): void {
    const normalized = [...new Set(labels.map(word => word.trim()).filter(Boolean))];
    const allowed = new Set(normalized);
    const servers = this.db.prepare('SELECT server_id, trigger_words FROM servers').all() as any[];
    const update = this.db.prepare('UPDATE servers SET trigger_words = ?, updated_at = ? WHERE server_id = ?');
    const apply = this.db.transaction(() => {
      this.setGlobalConfig('triggerWordLabels', JSON.stringify(normalized));
      for (const server of servers) {
        let enabled = this.parseTriggerWords(server.trigger_words).filter(word => allowed.has(word));
        if (enabled.length === 0 && normalized.length > 0) enabled = [normalized[0]];
        update.run(enabled.join(','), Date.now(), server.server_id);
      }
    });
    apply();
  }

  private parseQualityBitrates(value?: string): QualityBitrateConfig {
    if (!value) return getDefaultQualityBitrates();
    try {
      return JSON.parse(value);
    } catch {
      this.logger.warn('Invalid qualityBitrates global config; using defaults');
      return getDefaultQualityBitrates();
    }
  }

  setGlobalConfig(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO global_config (key, value) VALUES (?, ?)').run(key, value);
  }

  // ===== Servers =====

  getServer(serverId: string): ServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM servers WHERE server_id = ?').get(serverId) as any;
    if (!row) return undefined;
    return this.mapServerRow(row);
  }

  listServers(): ServerRecord[] {
    const rows = this.db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all() as any[];
    return rows.map(row => this.mapServerRow(row));
  }

  getSpace(platform: string, externalId: string): ServerRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM servers WHERE platform = ? AND external_id = ?',
    ).get(platform, externalId) as any;
    if (!row) return undefined;
    return this.mapServerRow(row);
  }

  listSpaces(platform?: string): ServerRecord[] {
    const rows = platform
      ? this.db.prepare('SELECT * FROM servers WHERE platform = ? ORDER BY created_at DESC').all(platform) as any[]
      : this.db.prepare('SELECT * FROM servers ORDER BY platform, created_at DESC').all() as any[];
    return rows.map(row => this.mapServerRow(row));
  }

  /** 将数据库行（下划线字段名）映射为 ServerSession（驼峰字段名） */
  private mapSessionRow(row: any): ServerSession {
    return {
      id: row.id,
      token: row.token,
      channel: row.channel,
      serverId: row.server_id,
      sharerUserId: row.sharer_user_id,
      sharerUsername: row.sharer_username,
      guildId: row.guild_id,
      targetChannelId: row.target_channel_id,
      status: row.status,
      viewerCount: row.viewer_count,
      peakViewers: row.peak_viewers,
      totalViewerJoins: row.total_viewer_joins,
      viewerDurationMs: row.viewer_duration_ms ?? null,
      quality: row.quality,
      cardMessageId: row.card_message_id,
      manualCreated: row.manual_created,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      lastHeartbeat: row.last_heartbeat,
      graceStartedAt: row.grace_started_at,
      graceReason: row.grace_reason,
      lastViewerAt: row.last_viewer_at,
      publisherClientId: row.publisher_client_id,
      lowLatency: row.low_latency ?? 0,
    };
  }

  /** 将数据库行（下划线字段名）映射为 ServerRecord（驼峰字段名） */
  private mapServerRow(row: any): ServerRecord {
    return {
      serverId: row.server_id,
      platform: row.platform || 'kook',
      externalId: row.external_id || row.server_id,
      openId: row.open_id,
      guildName: row.guild_name,
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      passwordHash: row.password_hash,
      bound: row.bound,
      status: row.status || 'active',
      agoraAppId: row.agora_app_id,
      agoraAppCertificate: row.agora_app_certificate,
      agoraTokenExpireSec: row.agora_token_expire_sec,
      allowedQualities: row.allowed_qualities,
      triggerWords: row.trigger_words,
      idleTimeoutSec: row.idle_timeout_sec,
      heartbeatIntervalSec: row.heartbeat_interval_sec,
      noViewerTimeoutSec: row.no_viewer_timeout_sec,
      publicDomain: row.public_domain,
      allowLowLatency: row.allow_low_latency ?? 0,
      allowQualityPreference: row.allow_quality_preference ?? 1,
      reboundAt: row.rebound_at ?? 0,
      bindToken: row.bind_token ?? '',
      bindTokenExpires: row.bind_token_expires ?? 0,
      serverSecret: row.server_secret ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Create or reactivate a platform-owned space without leaking platform semantics. */
  createSpace(input: CreateSpaceInput): ServerRecord {
    const now = Date.now();
    const globalCfg = this.getGlobalConfig();

    const platform = input.platform.trim().toLowerCase();
    const externalId = input.externalId.trim();
    if (!platform || !externalId) {
      throw new Error('createSpace requires platform and externalId');
    }

    const existing = this.getSpace(platform, externalId);
    if (existing) {
      if (existing.status === 'kicked') {
        if (platform === 'heychat') {
          // A Heychat rejoin starts a new administrative epoch. Even if the
          // room owner did not change, never reactivate credentials preserved
          // by a prior non-authoritative absence reconciliation.
          const reactivate = this.db.transaction(() => {
            this.db.prepare(`
              UPDATE servers
              SET status = 'active', guild_name = ?, owner_id = ?,
                  owner_username = ?, open_id = ?, bound = 0,
                  password_hash = '', bind_token = '', bind_token_expires = 0,
                  server_secret = ?, updated_at = ?
              WHERE server_id = ?
            `).run(
              input.displayName || existing.guildName,
              input.ownerId || existing.ownerId,
              input.ownerUsername || existing.ownerUsername,
              input.publicId || existing.openId,
              randomBytes(32).toString('hex'),
              now,
              existing.serverId,
            );
            this.db.prepare(
              'DELETE FROM heychat_binding_intents WHERE space_id = ?',
            ).run(existing.serverId);
          });
          reactivate();
          this.logger.log(`Reactivated ${platform} space ${externalId} with a fresh admin epoch`);
          return this.getServer(existing.serverId)!;
        }
        this.activateServer(existing.serverId);
        this.updateServer(existing.serverId, {
          guildName: input.displayName || existing.guildName,
          ownerId: input.ownerId || existing.ownerId,
          ownerUsername: input.ownerUsername || existing.ownerUsername,
          openId: input.publicId || existing.openId,
        });
        this.logger.log(`Reactivated ${platform} space ${externalId}`);
        return this.getServer(existing.serverId)!;
      }
      return existing;
    }

    const spaceId = input.spaceId || `${platform}:${externalId}`;
    const collision = this.getServer(spaceId);
    if (collision) {
      throw new Error(`Internal space ID collision: ${spaceId}`);
    }

    const serverSecret = randomBytes(32).toString('hex');
    this.db.prepare(`
      INSERT INTO servers (
        server_id, platform, external_id, open_id, guild_name, owner_id,
        owner_username, bound, status, public_domain, trigger_words,
        server_secret, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?)
    `).run(
      spaceId,
      platform,
      externalId,
      input.publicId || '',
      input.displayName,
      input.ownerId,
      input.ownerUsername || '',
      globalCfg.publicDomain,
      globalCfg.triggerWordLabels.join(','),
      serverSecret,
      now,
      now,
    );
    return this.getServer(spaceId)!;
  }

  /** @deprecated KOOK compatibility wrapper. New integrations must use createSpace. */
  createServer(serverId: string, guildName: string, ownerId: string, ownerUsername: string, openId?: string): ServerRecord {
    return this.createSpace({
      platform: 'kook',
      externalId: serverId,
      spaceId: serverId,
      displayName: guildName,
      ownerId,
      ownerUsername,
      publicId: openId,
    });
  }

  private readonly ALLOWED_SERVER_COLS = new Set([
    'owner_id', 'owner_username', 'guild_name', 'open_id',
    'password_hash', 'bound', 'status',
    'agora_app_id', 'agora_app_certificate', 'agora_token_expire_sec',
    'allowed_qualities', 'trigger_words',
    'idle_timeout_sec', 'heartbeat_interval_sec', 'no_viewer_timeout_sec',
    'public_domain', 'allow_low_latency', 'allow_quality_preference',
    'rebound_at', 'bind_token', 'bind_token_expires',
    'server_secret',
    'updated_at',
  ]);

  updateServer(serverId: string, fields: Partial<ServerRecord>): void {
    const columns = new Map<string, unknown>();
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'serverId') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_SERVER_COLS.has(col)) {
        this.logger.warn(`updateServer: rejected unknown column "${col}"`);
        continue;
      }
      columns.set(col, val);
    }
    if (columns.size === 0) return;

    const current = this.getServer(serverId);
    const nextOwnerId = columns.has('owner_id') ? String(columns.get('owner_id') || '') : null;
    const heychatOwnerChanged = !!current
      && current.platform === 'heychat'
      && nextOwnerId !== null
      && nextOwnerId !== current.ownerId;
    if (heychatOwnerChanged) {
      // An ownership epoch change invalidates every prior browser/admin
      // capability. Reset binding as well as rotating the JWT signing key so
      // the previous owner's password cannot mint a fresh token.
      columns.set('bound', 0);
      columns.set('password_hash', '');
      columns.set('bind_token', '');
      columns.set('bind_token_expires', 0);
      columns.set('server_secret', randomBytes(32).toString('hex'));
    }

    const sets = [...columns.keys()].map((column) => `${column} = ?`);
    const values = [...columns.values()];
    sets.push('updated_at = ?');
    values.push(Date.now(), serverId);
    const update = this.db.transaction(() => {
      this.db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE server_id = ?`).run(...values);
      if (heychatOwnerChanged) {
        this.db.prepare('DELETE FROM heychat_binding_intents WHERE space_id = ?').run(serverId);
      }
    });
    update();
  }

  /** 标记服务器为已踢出，重置绑定状态（不删除记录） */
  kickServer(serverId: string): void {
    const current = this.getServer(serverId);
    if (current?.platform !== 'heychat') {
      // Preserve the established KOOK credential lifecycle. Heychat's device
      // claims and ownership epochs must not alter KOOK rejoin semantics.
      this.db.prepare(`
        UPDATE servers
        SET status = 'kicked', bound = 0, password_hash = '', updated_at = ?
        WHERE server_id = ?
      `).run(Date.now(), serverId);
      this.logger.log(`Marked server ${serverId} as kicked, reset binding state`);
      return;
    }

    const revoke = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE servers
        SET status = 'kicked', bound = 0, password_hash = '',
            bind_token = '', bind_token_expires = 0, server_secret = ?, updated_at = ?
        WHERE server_id = ?
      `).run(randomBytes(32).toString('hex'), Date.now(), serverId);
      this.db.prepare('DELETE FROM heychat_binding_intents WHERE space_id = ?').run(serverId);
    });
    revoke();
    this.logger.log(`Marked server ${serverId} as kicked, reset binding state`);
  }

  /**
   * API reconciliation only knows that the bot is no longer present. Preserve
   * binding/password/Agora settings so a later rejoin can reactivate the space
   * without destroying administrator-owned configuration.
   */
  markServerAbsentPreservingBinding(serverId: string): boolean {
    const result = this.db.prepare(`
      UPDATE servers
      SET status = 'kicked', updated_at = ?
      WHERE server_id = ? AND status = 'active'
    `).run(Date.now(), serverId);
    if (result.changes > 0) {
      this.logger.log(`Marked server ${serverId} as absent, preserved binding state`);
    }
    return result.changes > 0;
  }

  /** 恢复服务器为活跃状态（机器人重新加入） */
  activateServer(serverId: string): void {
    this.db.prepare("UPDATE servers SET status = 'active', updated_at = ? WHERE server_id = ?").run(Date.now(), serverId);
    this.logger.log(`Reactivated server ${serverId}`);
  }

  /** 生成绑定临时 token（10 分钟有效） */
  generateBindToken(serverId: string): string {
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 10 * 60 * 1000; // 10 分钟
    this.db.prepare("UPDATE servers SET bind_token = ?, bind_token_expires = ?, updated_at = ? WHERE server_id = ?")
      .run(token, expires, Date.now(), serverId);
    this.logger.log(`Generated bind token for server ${serverId}, expires at ${new Date(expires).toISOString()}`);
    return token;
  }

  /** 校验绑定 token 是否有效 */
  validateBindToken(serverId: string, token: string): boolean {
    const server = this.getServer(serverId);
    if (!server) return false;
    if (!server.bindToken || server.bindToken !== token) return false;
    if (server.bindTokenExpires < Date.now()) return false;
    return true;
  }

  /** 清空绑定 token（绑定成功后调用） */
  clearBindToken(serverId: string): void {
    this.db.prepare("UPDATE servers SET bind_token = '', bind_token_expires = 0, updated_at = ? WHERE server_id = ?")
      .run(Date.now(), serverId);
  }

  /**
   * Start a browser-device binding flow for one active, unbound Heychat room.
   * The returned intent ID is deliberately only a locator; possession never
   * authorizes binding. A browser must create and later consume its own claim.
   */
  createHeychatBindingIntent(
    roomId: string,
    ttlMs = HEYCHAT_BIND_INTENT_TTL_MS,
  ): HeychatBindingIntentRecord | undefined {
    const space = this.getSpace('heychat', roomId);
    if (!space || space.status !== 'active' || !!space.bound || !space.ownerId) return undefined;
    const now = Date.now();
    const expiresAt = now + this.clampBindingTtl(ttlMs, HEYCHAT_BIND_INTENT_TTL_MS);
    const intentId = randomBytes(24).toString('base64url');
    const create = this.db.transaction(() => {
      // Device binding supersedes the retired Heychat URL-token flow. Clear
      // any token left by an older process before exposing the new intent.
      this.db.prepare(`
        UPDATE servers
        SET bind_token = '', bind_token_expires = 0, updated_at = ?
        WHERE server_id = ? AND platform = 'heychat'
      `).run(now, space.serverId);
      this.db.prepare(`
        UPDATE heychat_binding_claims
        SET state = 'revoked', updated_at = ?
        WHERE room_id = ? AND state IN ('pending', 'authorized')
      `).run(now, roomId);
      this.db.prepare(`
        UPDATE heychat_binding_intents
        SET state = 'revoked', updated_at = ?
        WHERE room_id = ? AND state IN ('active', 'authorized')
      `).run(now, roomId);
      this.db.prepare(`
        INSERT INTO heychat_binding_intents (
          intent_id, space_id, room_id, owner_id, state,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(intentId, space.serverId, roomId, space.ownerId, expiresAt, now, now);
    });
    create();
    return this.getHeychatBindingIntent(roomId, intentId);
  }

  getHeychatBindingIntent(
    roomId: string,
    intentId: string,
  ): HeychatBindingIntentRecord | undefined {
    const row = this.db.prepare(`
      SELECT i.*
      FROM heychat_binding_intents i
      INNER JOIN servers s ON s.server_id = i.space_id
      WHERE i.intent_id = ? AND i.room_id = ? AND s.platform = 'heychat'
    `).get(intentId, roomId) as any;
    if (!row) return undefined;
    return this.mapHeychatBindingIntent(row);
  }

  /** Create one browser claim. secretHash must be SHA-256 hex; raw secrets never enter SQLite. */
  createHeychatBindingClaim(
    roomId: string,
    intentId: string,
    secretHash: string,
    ttlMs = HEYCHAT_BIND_CLAIM_TTL_MS,
  ): HeychatBindingClaimRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(secretHash)) return undefined;
    const now = Date.now();
    const intent = this.getHeychatBindingIntent(roomId, intentId);
    const space = this.getSpace('heychat', roomId);
    if (
      !intent || intent.state !== 'active' || intent.expiresAt <= now
      || !space || space.serverId !== intent.spaceId
      || space.status !== 'active' || !!space.bound
      || space.ownerId !== intent.ownerId
    ) return undefined;

    const claimId = randomBytes(24).toString('base64url');
    const expiresAt = Math.min(
      intent.expiresAt,
      now + this.clampBindingTtl(ttlMs, HEYCHAT_BIND_CLAIM_TTL_MS),
    );
    const create = this.db.transaction((): HeychatBindingClaimRecord | undefined => {
      const current = this.db.prepare(`
        SELECT i.intent_id
        FROM heychat_binding_intents i
        INNER JOIN servers s ON s.server_id = i.space_id
        WHERE i.intent_id = ? AND i.room_id = ? AND i.owner_id = s.owner_id
          AND i.state = 'active' AND i.expires_at > ?
          AND s.platform = 'heychat' AND s.status = 'active' AND s.bound = 0
      `).get(intentId, roomId, now);
      if (!current) return undefined;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = this.generateHeychatBindingCode();
        try {
          this.db.prepare(`
            INSERT INTO heychat_binding_claims (
              claim_id, intent_id, room_id, secret_hash, code, state,
              expires_at, authorized_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
          `).run(claimId, intentId, roomId, secretHash, code, expiresAt, now, now);
          return this.getHeychatBindingClaim(roomId, intentId, claimId, secretHash);
        } catch (error: any) {
          if (!String(error?.message || error).includes('UNIQUE constraint failed')) throw error;
        }
      }
      throw new Error('Unable to allocate a unique Heychat binding code');
    });
    return create();
  }

  getHeychatBindingClaim(
    roomId: string,
    intentId: string,
    claimId: string,
    secretHash: string,
  ): HeychatBindingClaimRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(secretHash)) return undefined;
    const row = this.db.prepare(`
      SELECT c.*
      FROM heychat_binding_claims c
      INNER JOIN heychat_binding_intents i ON i.intent_id = c.intent_id
      WHERE c.claim_id = ? AND c.intent_id = ? AND c.room_id = ?
        AND c.secret_hash = ? AND i.room_id = c.room_id
    `).get(claimId, intentId, roomId, secretHash) as any;
    if (!row) return undefined;
    return this.mapHeychatBindingClaim(row);
  }

  /** Called by the trusted Heychat /xchelp command path when it includes a code. */
  authorizeHeychatBindingClaim(
    roomId: string,
    code: string,
    confirmerUserId: string,
  ): HeychatBindingClaimRecord | undefined {
    const normalizedCode = code.trim().toUpperCase();
    if (!new RegExp(`^[${HEYCHAT_BIND_CODE_ALPHABET}]{${HEYCHAT_BIND_CODE_LENGTH}}$`).test(normalizedCode)) {
      return undefined;
    }
    const now = Date.now();
    const authorize = this.db.transaction((): HeychatBindingClaimRecord | undefined => {
      const row = this.db.prepare(`
        SELECT c.*, i.space_id, i.owner_id
        FROM heychat_binding_claims c
        INNER JOIN heychat_binding_intents i ON i.intent_id = c.intent_id
        INNER JOIN servers s ON s.server_id = i.space_id
        WHERE c.room_id = ? AND c.code = ? AND c.state = 'pending'
          AND c.expires_at > ? AND i.state = 'active' AND i.expires_at > ?
          AND i.owner_id = ? AND s.owner_id = ?
          AND s.platform = 'heychat' AND s.external_id = ?
          AND s.status = 'active' AND s.bound = 0
      `).get(
        roomId,
        normalizedCode,
        now,
        now,
        confirmerUserId,
        confirmerUserId,
        roomId,
      ) as any;
      if (!row) return undefined;

      this.db.prepare(`
        UPDATE heychat_binding_claims
        SET state = 'revoked', updated_at = ?
        WHERE intent_id = ? AND claim_id != ? AND state IN ('pending', 'authorized')
      `).run(now, row.intent_id, row.claim_id);
      const selected = this.db.prepare(`
        UPDATE heychat_binding_claims
        SET state = 'authorized', authorized_at = ?, updated_at = ?
        WHERE claim_id = ? AND state = 'pending'
      `).run(now, now, row.claim_id);
      if (selected.changes !== 1) return undefined;
      this.db.prepare(`
        UPDATE heychat_binding_intents
        SET state = 'authorized', updated_at = ?
        WHERE intent_id = ? AND state = 'active'
      `).run(now, row.intent_id);

      return this.getHeychatBindingClaimById(row.claim_id);
    });
    return authorize();
  }

  /**
   * Atomically consume one authorized browser claim and bind the room. Success
   * removes every intent/claim for the space and starts a fresh admin-key epoch.
   */
  consumeHeychatBindingClaim(
    roomId: string,
    intentId: string,
    claimId: string,
    secretHash: string,
    passwordHash: string,
  ): ServerRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(secretHash) || !passwordHash) return undefined;
    const now = Date.now();
    const consume = this.db.transaction((): string | undefined => {
      const row = this.db.prepare(`
        SELECT i.space_id
        FROM heychat_binding_claims c
        INNER JOIN heychat_binding_intents i ON i.intent_id = c.intent_id
        INNER JOIN servers s ON s.server_id = i.space_id
        WHERE c.claim_id = ? AND c.intent_id = ? AND c.room_id = ?
          AND c.secret_hash = ? AND c.state = 'authorized' AND c.expires_at > ?
          AND i.state = 'authorized' AND i.expires_at > ?
          AND s.platform = 'heychat' AND s.external_id = ?
          AND s.status = 'active' AND s.bound = 0 AND s.owner_id = i.owner_id
      `).get(claimId, intentId, roomId, secretHash, now, now, roomId) as any;
      if (!row) return undefined;

      const bound = this.db.prepare(`
        UPDATE servers
        SET password_hash = ?, bound = 1, rebound_at = ?,
            bind_token = '', bind_token_expires = 0,
            server_secret = ?, updated_at = ?
        WHERE server_id = ? AND platform = 'heychat'
          AND external_id = ? AND status = 'active' AND bound = 0
      `).run(
        passwordHash,
        now,
        randomBytes(32).toString('hex'),
        now,
        row.space_id,
        roomId,
      );
      if (bound.changes !== 1) return undefined;
      this.db.prepare('DELETE FROM heychat_binding_intents WHERE space_id = ?').run(row.space_id);
      return String(row.space_id);
    });
    const spaceId = consume();
    return spaceId ? this.getServer(spaceId) : undefined;
  }

  private getHeychatBindingClaimById(claimId: string): HeychatBindingClaimRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM heychat_binding_claims WHERE claim_id = ?',
    ).get(claimId) as any;
    return row ? this.mapHeychatBindingClaim(row) : undefined;
  }

  private mapHeychatBindingIntent(row: any): HeychatBindingIntentRecord {
    const state = row.expires_at <= Date.now() && row.state !== 'revoked'
      ? 'expired'
      : row.state;
    return {
      intentId: String(row.intent_id),
      spaceId: String(row.space_id),
      roomId: String(row.room_id),
      ownerId: String(row.owner_id),
      state,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapHeychatBindingClaim(row: any): HeychatBindingClaimRecord {
    const state = row.expires_at <= Date.now() && row.state !== 'revoked'
      ? 'expired'
      : row.state;
    return {
      claimId: String(row.claim_id),
      intentId: String(row.intent_id),
      roomId: String(row.room_id),
      code: String(row.code),
      state,
      expiresAt: Number(row.expires_at),
      authorizedAt: row.authorized_at == null ? null : Number(row.authorized_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private generateHeychatBindingCode(): string {
    let code = '';
    for (let index = 0; index < HEYCHAT_BIND_CODE_LENGTH; index += 1) {
      code += HEYCHAT_BIND_CODE_ALPHABET[randomInt(HEYCHAT_BIND_CODE_ALPHABET.length)];
    }
    return code;
  }

  private clampBindingTtl(value: number, maximum: number): number {
    if (!Number.isFinite(value) || value <= 0) return maximum;
    return Math.max(30_000, Math.min(Math.floor(value), maximum));
  }

  /** 获取指定服务器本次绑定后的会话列表（reboundAt > 0 时过滤旧会话） */
  getSessionsByServerFiltered(serverId: string, reboundAt: number): ServerSession[] {
    if (reboundAt <= 0) {
      return this.getSessionsByServer(serverId);
    }
    const rows = this.db.prepare('SELECT * FROM sessions WHERE server_id = ? AND created_at >= ? ORDER BY created_at DESC')
      .all(serverId, reboundAt) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  /** 彻底删除服务器及其会话（仅超级管理员手动操作） */
  deleteServer(serverId: string): void {
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE server_id = ?').run(serverId);
      this.db.prepare('DELETE FROM server_events WHERE server_id = ?').run(serverId);
      this.db.prepare('DELETE FROM servers WHERE server_id = ?').run(serverId);
    });
    remove();
    this.logger.log(`Deleted server ${serverId} and its sessions/events`);
  }

  // ===== Server Events =====

  /** 记录服务器事件 */
  addServerEvent(serverId: string, eventType: string, operatorId?: string, operatorName?: string, detail?: string): void {
    this.db.prepare(`
      INSERT INTO server_events (server_id, event_type, operator_id, operator_name, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(serverId, eventType, operatorId || '', operatorName || '', detail || '', Date.now());
  }

  /** 获取服务器事件列表 */
  getServerEvents(serverId: string): ServerEvent[] {
    const rows = this.db.prepare('SELECT * FROM server_events WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[];
    return rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      eventType: row.event_type,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }

  // ===== Sessions =====

  getSessionById(id: string): ServerSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.mapSessionRow(row);
  }

  getSessionByToken(token: string): ServerSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any;
    if (!row) return undefined;
    return this.mapSessionRow(row);
  }

  getActiveSessionsByUser(sharerUserId: string): ServerSession[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE sharer_user_id = ? AND status != 'ended'"
    ).all(sharerUserId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getActiveSessionsByPlatformUser(platform: string, sharerUserId: string): ServerSession[] {
    const rows = this.db.prepare(`
      SELECT s.*
      FROM sessions s
      INNER JOIN servers v ON v.server_id = s.server_id
      WHERE v.platform = ? AND s.sharer_user_id = ? AND s.status != 'ended'
    `).all(platform, sharerUserId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getSessionsByServer(serverId: string): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getAllSessions(): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getUnfinishedSessions(): ServerSession[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE status != 'ended' ORDER BY created_at DESC",
    ).all() as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  createSession(session: ServerSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, token, channel, server_id, sharer_user_id, sharer_username,
        guild_id, target_channel_id, status, viewer_count, peak_viewers,
        total_viewer_joins, viewer_duration_ms, quality, card_message_id, manual_created,
        created_at, started_at, ended_at, duration_ms, last_heartbeat,
        grace_started_at, grace_reason, last_viewer_at, publisher_client_id,
        low_latency
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )
    `).run(
      session.id, session.token, session.channel, session.serverId,
      session.sharerUserId, session.sharerUsername,
      session.guildId, session.targetChannelId, session.status,
      session.viewerCount, session.peakViewers,
      session.totalViewerJoins, session.viewerDurationMs, session.quality, session.cardMessageId,
      session.manualCreated,
      session.createdAt, session.startedAt, session.endedAt,
      session.durationMs, session.lastHeartbeat,
      session.graceStartedAt, session.graceReason,
      session.lastViewerAt, session.publisherClientId,
      session.lowLatency ?? 0,
    );
  }

  private readonly ALLOWED_SESSION_COLS = new Set([
    'token', 'channel', 'server_id', 'sharer_user_id', 'sharer_username',
    'guild_id', 'target_channel_id', 'status', 'viewer_count', 'peak_viewers',
    'total_viewer_joins', 'viewer_duration_ms', 'quality', 'card_message_id', 'manual_created',
    'created_at', 'started_at', 'ended_at', 'duration_ms', 'last_heartbeat',
    'grace_started_at', 'grace_reason', 'last_viewer_at', 'publisher_client_id',
    'low_latency',
  ]);

  updateSession(id: string, fields: Partial<ServerSession>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_SESSION_COLS.has(col)) {
        this.logger.warn(`updateSession: rejected unknown column "${col}"`);
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ? AND status = 'ended'").run(id);
    return result.changes > 0;
  }

  deletePendingSession(id: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM sessions WHERE id = ? AND status = 'pending' AND card_message_id IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  // ===== KOOK Webhook Inbox =====

  enqueueKookWebhookEvent(input: {
    eventKey: string;
    eventId: string;
    sn: number | null;
    eventType: string;
    payload: string;
    payloadHash: string;
  }): { inserted: boolean; eventKey: string; conflict: boolean } {
    const enqueue = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT payload_hash FROM kook_webhook_events WHERE event_key = ?',
      ).get(input.eventKey) as any;
      if (existing?.payload_hash === input.payloadHash) {
        return { inserted: false, eventKey: input.eventKey, conflict: false };
      }

      let eventKey = input.eventKey;
      let conflict = false;
      if (existing) {
        conflict = true;
        eventKey = `${input.eventKey}:${input.payloadHash.slice(0, 16)}`;
        const conflictExisting = this.db.prepare(
          'SELECT payload_hash FROM kook_webhook_events WHERE event_key = ?',
        ).get(eventKey) as any;
        if (conflictExisting?.payload_hash === input.payloadHash) {
          return { inserted: false, eventKey, conflict: true };
        }
      }

      const now = Date.now();
      this.db.prepare(`
        INSERT INTO kook_webhook_events (
          event_key, event_id, sn, event_type, payload, payload_hash,
          status, attempts, next_attempt_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        eventKey,
        input.eventId,
        input.sn,
        input.eventType,
        input.payload,
        input.payloadHash,
        now,
        now,
      );
      return { inserted: true, eventKey, conflict };
    });
    return enqueue();
  }

  recoverStaleKookWebhookEvents(staleBefore: number): number {
    return this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'pending', locked_at = NULL, next_attempt_at = ?
      WHERE status = 'processing' AND locked_at < ?
    `).run(Date.now(), staleBefore).changes;
  }

  claimKookWebhookEvent(): KookWebhookEventRecord | undefined {
    const claim = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`
        SELECT event_key, sn, event_type, payload, attempts, received_at
        FROM kook_webhook_events
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY received_at ASC
        LIMIT 1
      `).get(now) as any;
      if (!row) return undefined;
      const updated = this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'processing', attempts = attempts + 1, locked_at = ?
        WHERE event_key = ? AND status = 'pending'
      `).run(now, row.event_key);
      if (updated.changes !== 1) return undefined;
      return {
        eventKey: row.event_key,
        sn: row.sn == null ? null : Number(row.sn),
        eventType: row.event_type || '',
        payload: row.payload,
        attempts: Number(row.attempts) + 1,
        receivedAt: Number(row.received_at),
      } as KookWebhookEventRecord;
    });
    return claim();
  }

  completeKookWebhookEvent(eventKey: string, status: 'done' | 'ignored'): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
      WHERE event_key = ?
    `).run(status, Date.now(), eventKey);
  }

  beginKookWebhookBusinessEffect(eventKey: string): 'execute' | 'done' | 'ignored' | 'uncertain' {
    const begin = this.db.transaction(() => {
      const effectKey = `business:${eventKey}`;
      const existing = this.db.prepare(`
        SELECT status, result
        FROM kook_webhook_effects
        WHERE effect_key = ?
      `).get(effectKey) as any;
      const now = Date.now();

      if (!existing) {
        this.db.prepare(`
          INSERT INTO kook_webhook_effects (
            effect_key, event_key, status, result, created_at, updated_at
          ) VALUES (?, ?, 'processing', '', ?, ?)
        `).run(effectKey, eventKey, now, now);
        return 'execute' as const;
      }

      if (existing.status === 'done' || existing.status === 'ignored') {
        this.db.prepare(`
          UPDATE kook_webhook_events
          SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
          WHERE event_key = ?
        `).run(existing.status, now, eventKey);
        return existing.status as 'done' | 'ignored';
      }

      // An existing "processing" effect means the previous process stopped after
      // business execution began. Its external side effects may already exist, so
      // retrying would risk duplicate sessions or KOOK cards.
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = 'uncertain', result = 'crash_window', updated_at = ?
        WHERE effect_key = ?
      `).run(now, effectKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'uncertain', processed_at = ?, locked_at = NULL,
            last_error_code = 'business_effect_uncertain'
        WHERE event_key = ?
      `).run(now, eventKey);
      return 'uncertain' as const;
    });
    return begin();
  }

  completeKookWebhookBusinessEffect(eventKey: string, status: 'done' | 'ignored'): void {
    const complete = this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = ?, result = ?, updated_at = ?
        WHERE event_key = ? AND status = 'processing'
      `).run(status, status, now, eventKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
        WHERE event_key = ?
      `).run(status, now, eventKey);
    });
    complete();
  }

  markKookWebhookBusinessEffectUncertain(eventKey: string, errorCode: string): void {
    const mark = this.db.transaction(() => {
      const now = Date.now();
      const safeCode = errorCode.slice(0, 100);
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = 'uncertain', result = ?, updated_at = ?
        WHERE event_key = ?
      `).run(safeCode, now, eventKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'uncertain', processed_at = ?, locked_at = NULL, last_error_code = ?
        WHERE event_key = ?
      `).run(now, safeCode, eventKey);
    });
    mark();
  }

  retryKookWebhookEvent(eventKey: string, nextAttemptAt: number, errorCode: string): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'pending', next_attempt_at = ?, locked_at = NULL, last_error_code = ?
      WHERE event_key = ?
    `).run(nextAttemptAt, errorCode.slice(0, 100), eventKey);
  }

  deadKookWebhookEvent(eventKey: string, errorCode: string): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'dead', processed_at = ?, locked_at = NULL, last_error_code = ?
      WHERE event_key = ?
    `).run(Date.now(), errorCode.slice(0, 100), eventKey);
  }

  getKookWebhookStatus(): {
    pending: number;
    processing: number;
    done: number;
    ignored: number;
    dead: number;
    uncertain: number;
    oldestPendingAt: number | null;
  } {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM kook_webhook_events
      GROUP BY status
    `).all() as any[];
    const map = new Map(counts.map((row) => [String(row.status), Number(row.count)]));
    const oldest = this.db.prepare(`
      SELECT MIN(received_at) AS received_at
      FROM kook_webhook_events
      WHERE status IN ('pending', 'processing')
    `).get() as any;
    return {
      pending: map.get('pending') || 0,
      processing: map.get('processing') || 0,
      done: map.get('done') || 0,
      ignored: map.get('ignored') || 0,
      dead: map.get('dead') || 0,
      uncertain: map.get('uncertain') || 0,
      oldestPendingAt: oldest?.received_at == null ? null : Number(oldest.received_at),
    };
  }

  // ===== Anonymous analytics repository primitives =====

  /** Execute a fixed analytics mutation. SQL is authored only by AnalyticsService. */
  enqueueCardJob(key: string, payload: string): void {
    this.db.prepare('INSERT OR IGNORE INTO platform_card_jobs (job_key, payload) VALUES (?, ?)').run(key, payload);
  }

  getDueCardJobs(now = Date.now()): Array<{ job_key: string; payload: string; attempts: number; first_attempt_at: number | null }> {
    return this.db.prepare("SELECT * FROM platform_card_jobs WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20").all(now) as any;
  }

  beginCardJob(key: string, now: number): void {
    this.db.prepare('UPDATE platform_card_jobs SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), next_attempt_at = ? WHERE job_key = ?').run(now, now + 5_000, key);
  }

  retryCardJob(key: string, nextAt: number, error: string, state = 'pending'): void {
    this.db.prepare('UPDATE platform_card_jobs SET next_attempt_at = ?, last_error = ?, state = ? WHERE job_key = ?').run(nextAt, error.slice(0, 500), state, key);
  }

  getCardJobSummary(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM platform_card_jobs GROUP BY state').all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map(row => [row.state, row.count]));
  }

  completeCardJob(key: string): void {
    this.db.prepare('DELETE FROM platform_card_jobs WHERE job_key = ?').run(key);
  }

  runAnalytics(sql: string, params: readonly unknown[] = []): number {
    return this.db.prepare(sql).run(...params).changes;
  }

  /** Read one row using a fixed analytics query authored by AnalyticsService. */
  getAnalyticsRow<T = any>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Read rows using a fixed analytics query authored by AnalyticsService. */
  getAnalyticsRows<T = any>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  runAnalyticsTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  optimizeAnalytics(): void {
    this.db.pragma('optimize');
  }

  cleanupKookWebhookEvents(doneBefore: number, deadBefore: number): number {
    return this.db.prepare(`
      DELETE FROM kook_webhook_events
      WHERE (status IN ('done', 'ignored') AND processed_at < ?)
         OR (status IN ('dead', 'uncertain') AND processed_at < ?)
    `).run(doneBefore, deadBefore).changes;
  }

  // ===== Notices =====

  private mapNoticeRow(row: any, targets: NoticeTargetPage[]): NoticeRecord {
    return {
      id: row.id,
      kind: row.kind,
      modalPolicy: row.modal_policy || null,
      title: row.title || '',
      contentFormat: row.content_format,
      content: row.content || '',
      imageUrl: row.image_url || '',
      enabled: row.enabled,
      sortOrder: row.sort_order,
      repeatAfterSec: row.repeat_after_sec ?? null,
      revision: row.revision,
      targets,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getNoticeTargets(ids: string[]): Map<string, NoticeTargetPage[]> {
    const result = new Map<string, NoticeTargetPage[]>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT notice_id, page FROM notice_targets WHERE notice_id IN (${placeholders})`,
    ).all(...ids) as any[];
    for (const row of rows) {
      const pages = result.get(row.notice_id) || [];
      pages.push(row.page as NoticeTargetPage);
      result.set(row.notice_id, pages);
    }
    return result;
  }

  listNotices(page?: NoticeTargetPage, includeDisabled = false): NoticeRecord[] {
    const where: string[] = [];
    const values: any[] = [];
    if (!includeDisabled) where.push('n.enabled = 1');
    if (page) {
      where.push('EXISTS (SELECT 1 FROM notice_targets nt WHERE nt.notice_id = n.id AND nt.page = ?)');
      values.push(page);
    }
    const sql = `
      SELECT n.*
      FROM notices n
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY n.sort_order ASC, n.created_at ASC
    `;
    const rows = this.db.prepare(sql).all(...values) as any[];
    const targets = this.getNoticeTargets(rows.map(row => row.id));
    return rows.map(row => this.mapNoticeRow(row, targets.get(row.id) || []));
  }

  getNotice(id: string): NoticeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notices WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    const targets = this.getNoticeTargets([id]).get(id) || [];
    return this.mapNoticeRow(row, targets);
  }

  createNotice(id: string, input: NoticeWriteInput): NoticeRecord {
    const now = Date.now();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO notices (
          id, kind, modal_policy, title, content_format, content, image_url,
          enabled, sort_order, repeat_after_sec, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        input.kind,
        input.kind === 'modal' ? input.modalPolicy : null,
        input.title || '',
        input.contentFormat,
        input.content,
        input.imageUrl || '',
        input.enabled ? 1 : 0,
        input.sortOrder,
        input.repeatAfterSec ?? null,
        now,
        now,
      );
      const insertTarget = this.db.prepare(
        'INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)',
      );
      for (const page of input.targets) insertTarget.run(id, page);
    });
    create();
    return this.getNotice(id)!;
  }

  updateNotice(id: string, input: NoticeWriteInput, bumpRevision: boolean): NoticeRecord | undefined {
    if (!this.getNotice(id)) return undefined;
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE notices SET
          kind = ?,
          modal_policy = ?,
          title = ?,
          content_format = ?,
          content = ?,
          image_url = ?,
          enabled = ?,
          sort_order = ?,
          repeat_after_sec = ?,
          revision = revision + ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        input.kind,
        input.kind === 'modal' ? input.modalPolicy : null,
        input.title || '',
        input.contentFormat,
        input.content,
        input.imageUrl || '',
        input.enabled ? 1 : 0,
        input.sortOrder,
        input.repeatAfterSec ?? null,
        bumpRevision ? 1 : 0,
        Date.now(),
        id,
      );
      this.db.prepare('DELETE FROM notice_targets WHERE notice_id = ?').run(id);
      const insertTarget = this.db.prepare(
        'INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)',
      );
      for (const page of input.targets) insertTarget.run(id, page);
    });
    update();
    return this.getNotice(id);
  }

  deleteNotice(id: string): boolean {
    return this.db.prepare('DELETE FROM notices WHERE id = ?').run(id).changes > 0;
  }

  reorderNotices(ids: string[]): void {
    const update = this.db.prepare(
      'UPDATE notices SET sort_order = ?, updated_at = ? WHERE id = ?',
    );
    const reorder = this.db.transaction(() => {
      ids.forEach((id, index) => update.run(index, Date.now(), id));
    });
    reorder();
  }

  republishNotice(id: string): NoticeRecord | undefined {
    const result = this.db.prepare(
      'UPDATE notices SET revision = revision + 1, updated_at = ? WHERE id = ?',
    ).run(Date.now(), id);
    return result.changes > 0 ? this.getNotice(id) : undefined;
  }
}
