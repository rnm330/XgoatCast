import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';

// ===== Types =====

export interface GlobalConfig {
  kookBotToken: string;
  publicDomain: string;
}

export interface ServerRecord {
  serverId: string;       // guild_id 雪花 ID（不变，用于主键和 URL）
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
  allowLowLatency: number; // 0=不允许低延迟模式，1=允许共享者切换
  reboundAt: number;      // 重新绑定时间戳（被踢出后重新绑定时记录，用于过滤旧会话）
  bindToken: string;      // 绑定临时 token
  bindTokenExpires: number; // 绑定 token 过期时间戳
  serverSecret: string;   // 每服务器独立的 HMAC 签名密钥
  createdAt: number;
  updatedAt: number;
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
    this.migrate();
    this.logger.log(`SQLite database ready at ${dbPath}`);
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      this.logger.log('SQLite database closed');
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        server_id              TEXT PRIMARY KEY,  -- guild_id 雪花 ID（不变，用于主键和 URL）
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
    if (!columns.some(c => c.name === 'allow_low_latency')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN allow_low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added allow_low_latency column to servers table');
    }

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
    `);

    // Migrate sessions table: add low_latency column if missing
    const sessCols = this.db.prepare("PRAGMA table_info(sessions)").all() as any[];
    if (!sessCols.some(c => c.name === 'low_latency')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added low_latency column to sessions table');
    }

    // Seed default global config if empty
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM global_config').get() as any;
    if (row.cnt === 0) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)');
      ins.run('kookBotToken', process.env.KOOK_BOT_TOKEN || '');
      ins.run('publicDomain', 'http://localhost:3520');
      this.logger.log('Seeded default global config');
    }

    // Backfill empty kookBotToken from env (for existing databases)
    if (process.env.KOOK_BOT_TOKEN) {
      const current = this.db.prepare("SELECT value FROM global_config WHERE key = 'kookBotToken'").get() as any;
      if (!current || !current.value) {
        this.db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('kookBotToken', ?)").run(process.env.KOOK_BOT_TOKEN);
        this.logger.log('Backfilled kookBotToken from KOOK_BOT_TOKEN env');
      }
    }
  }

  // ===== Global Config =====

  getGlobalConfig(): GlobalConfig {
    const rows = this.db.prepare('SELECT key, value FROM global_config').all() as any[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);
    return {
      kookBotToken: map.get('kookBotToken') || '',
      publicDomain: map.get('publicDomain') || 'http://localhost:3520',
    };
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
      reboundAt: row.rebound_at ?? 0,
      bindToken: row.bind_token ?? '',
      bindTokenExpires: row.bind_token_expires ?? 0,
      serverSecret: row.server_secret ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 创建服务器记录
   * @param serverId guild_id 雪花 ID（主键，用于 URL）
   * @param guildName 服务器名称
   * @param ownerId 服务器主 user_id
   * @param ownerUsername 服务器主用户名
   * @param openId open_id 公开 ID（用于面板显示）
   */
  createServer(serverId: string, guildName: string, ownerId: string, ownerUsername: string, openId?: string): ServerRecord {
    const now = Date.now();
    const globalCfg = this.getGlobalConfig();
    
    // 检查是否是重新加入的服务器（之前被踢出）
    const existing = this.getServer(serverId);
    if (existing) {
      if (existing.status === 'kicked') {
        // 重新激活被踢出的服务器
        this.activateServer(serverId);
        // 更新服务器信息
        this.updateServer(serverId, {
          guildName: guildName || existing.guildName,
          ownerId: ownerId || existing.ownerId,
          ownerUsername: ownerUsername || existing.ownerUsername,
          openId: openId || existing.openId,
        });
        this.logger.log(`Reactivated kicked server ${serverId}`);
        return this.getServer(serverId)!;
      }
      // 已存在的活跃服务器，直接返回
      return existing;
    }
    
    const serverSecret = randomBytes(32).toString('hex');
    this.db.prepare(`
      INSERT INTO servers (server_id, open_id, guild_name, owner_id, owner_username, bound, status, public_domain, server_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
    `).run(serverId, openId || '', guildName, ownerId, ownerUsername, globalCfg.publicDomain, serverSecret, now, now);
    return this.getServer(serverId)!;
  }

  private readonly ALLOWED_SERVER_COLS = new Set([
    'owner_id', 'owner_username', 'guild_name', 'open_id',
    'password_hash', 'bound', 'status',
    'agora_app_id', 'agora_app_certificate', 'agora_token_expire_sec',
    'allowed_qualities', 'trigger_words',
    'idle_timeout_sec', 'heartbeat_interval_sec', 'no_viewer_timeout_sec',
    'public_domain', 'allow_low_latency',
    'rebound_at', 'bind_token', 'bind_token_expires',
    'server_secret',
    'updated_at',
  ]);

  updateServer(serverId: string, fields: Partial<ServerRecord>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'serverId') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_SERVER_COLS.has(col)) {
        this.logger.warn(`updateServer: rejected unknown column "${col}"`);
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(serverId);
    this.db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE server_id = ?`).run(...values);
  }

  /** 标记服务器为已踢出，重置绑定状态（不删除记录） */
  kickServer(serverId: string): void {
    this.db.prepare("UPDATE servers SET status = 'kicked', bound = 0, password_hash = '', updated_at = ? WHERE server_id = ?").run(Date.now(), serverId);
    this.logger.log(`Marked server ${serverId} as kicked, reset binding state`);
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
    this.db.prepare('DELETE FROM servers WHERE server_id = ?').run(serverId);
    this.db.prepare('DELETE FROM sessions WHERE server_id = ?').run(serverId);
    this.db.prepare('DELETE FROM server_events WHERE server_id = ?').run(serverId);
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

  getSessionsByServer(serverId: string): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getAllSessions(): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  createSession(session: ServerSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, token, channel, server_id, sharer_user_id, sharer_username,
        guild_id, target_channel_id, status, viewer_count, peak_viewers,
        total_viewer_joins, quality, card_message_id, manual_created,
        created_at, started_at, ended_at, duration_ms, last_heartbeat,
        grace_started_at, grace_reason, last_viewer_at, publisher_client_id,
        low_latency
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )
    `).run(
      session.id, session.token, session.channel, session.serverId,
      session.sharerUserId, session.sharerUsername,
      session.guildId, session.targetChannelId, session.status,
      session.viewerCount, session.peakViewers,
      session.totalViewerJoins, session.quality, session.cardMessageId,
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
    'total_viewer_joins', 'quality', 'card_message_id', 'manual_created',
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
}
