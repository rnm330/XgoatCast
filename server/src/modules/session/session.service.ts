import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import { DatabaseService, ServerSession } from '../database/database.service';
import { AgoraService } from '../agora/agora.service';
import { EventBusService } from '../events/events.service';
import { SessionStatus, ShareSession, SessionInfo, getQualityInfo, getAudioCoefficient, getVideoCoefficient, STANDARD_MINUTE_PRICE } from './session.types';

interface ViewerPresence {
  connections: number;
  /** 仅在会话 ACTIVE 时记录，用于排除等待和宽限期。 */
  billingStartedAt: number | null;
}

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);
  /** 内存中维护的 lastViewerAt，由 SSE 控制器在观众进出时更新。 */
  private lastViewerMap = new Map<string, number>(); // sessionId → timestamp
  /** 内存中维护的去重加入数，session 结束时持久化。 */
  private joinCountMap = new Map<string, number>(); // sessionId → count
  /** sessionId → viewerId → 连接引用计数和当前计费区间。 */
  private viewerPresenceMap = new Map<string, Map<string, ViewerPresence>>();
  /** 已结算到数据库的累计观众毫秒。 */
  private viewerDurationMsMap = new Map<string, number>();
  /** 当前进程中已经计入 totalViewerJoins 的 viewerId。 */
  private viewerIdsMap = new Map<string, Set<string>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly agora: AgoraService,
    private readonly bus: EventBusService,
  ) {}

  async onModuleInit() {
    this.logger.log('SessionService initialized (SQLite backend)');
  }

  /** Convert DB session to in-memory ShareSession format */
  private fromDb(row: ServerSession): ShareSession {
    return {
      id: row.id,
      token: row.token,
      channel: row.channel,
      sharerUserId: row.sharerUserId,
      sharerUsername: row.sharerUsername,
      guildId: row.guildId,
      targetChannelId: row.targetChannelId,
      status: row.status as SessionStatus,
      viewerCount: row.viewerCount,
      peakViewers: row.peakViewers,
      totalViewerJoins: row.totalViewerJoins,
      viewerDurationMs: row.viewerDurationMs,
      quality: row.quality,
      cardMessageId: row.cardMessageId || undefined,
      manualCreated: !!row.manualCreated,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      lastHeartbeat: row.lastHeartbeat,
      graceStartedAt: row.graceStartedAt,
      graceReason: row.graceReason as any,
      lastViewerAt: row.lastViewerAt,
      publisherClientId: row.publisherClientId || undefined,
      lowLatency: !!row.lowLatency,
    };
  }

  private toDb(session: ShareSession, serverId: string): ServerSession {
    return {
      id: session.id,
      token: session.token,
      channel: session.channel,
      serverId,
      sharerUserId: session.sharerUserId,
      sharerUsername: session.sharerUsername,
      guildId: session.guildId,
      targetChannelId: session.targetChannelId,
      status: session.status,
      viewerCount: session.viewerCount,
      peakViewers: session.peakViewers,
      totalViewerJoins: session.totalViewerJoins,
      viewerDurationMs: session.viewerDurationMs,
      quality: session.quality,
      cardMessageId: session.cardMessageId || null,
      manualCreated: session.manualCreated ? 1 : 0,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs,
      lastHeartbeat: session.lastHeartbeat,
      graceStartedAt: session.graceStartedAt,
      graceReason: session.graceReason || null,
      lastViewerAt: session.lastViewerAt,
      publisherClientId: session.publisherClientId || null,
      lowLatency: session.lowLatency ? 1 : 0,
    };
  }

  /** Get server config for a session's guild */
  private getServerSessionConfig(guildId: string) {
    const server = this.db.getServer(guildId);
    if (server) {
      return {
        idleTimeoutSec: server.idleTimeoutSec,
        heartbeatIntervalSec: server.heartbeatIntervalSec,
        noViewerTimeoutSec: server.noViewerTimeoutSec,
      };
    }
    // Fallback: hardcoded defaults (server should always exist)
    return { idleTimeoutSec: 60, heartbeatIntervalSec: 5, noViewerTimeoutSec: 180 };
  }

  createSession(params: {
    sharerUserId: string;
    sharerUsername: string;
    guildId: string;
    targetChannelId: string;
    manualCreated?: boolean;
    quality?: string;
    serverId?: string;
  }): ShareSession {
    const id = randomUUID();
    const shortId = id.replace(/-/g, '').slice(0, 12);
    const token = randomBytes(32).toString('hex');
    const now = Date.now();

    // Get server config for Agora channel name generation
    const serverConfig = params.serverId ? this.db.getServer(params.serverId) : null;
    const agoraAppId = serverConfig?.agoraAppId || '';

    const session: ShareSession = {
      id,
      token,
      channel: this.agora.generateChannelName(shortId),
      sharerUserId: params.sharerUserId,
      sharerUsername: params.sharerUsername,
      guildId: params.guildId,
      targetChannelId: params.targetChannelId,
      status: SessionStatus.PENDING,
      viewerCount: 0,
      peakViewers: 0,
      totalViewerJoins: 0,
      viewerDurationMs: 0,
      quality: params.quality || '1080p_2',
      manualCreated: params.manualCreated || false,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      lastHeartbeat: now,
      graceStartedAt: null,
      graceReason: null,
      lastViewerAt: null,
      lowLatency: false,
    };

    const serverId = params.serverId || params.guildId || '';
    this.db.createSession(this.toDb(session, serverId));
    return session;
  }

  getByToken(token: string): ShareSession | undefined {
    const row = this.db.getSessionByToken(token);
    if (!row) return undefined;
    return this.fromDb(row);
  }

  getById(id: string): ShareSession | undefined {
    const row = this.db.getSessionById(id);
    if (!row) return undefined;
    return this.fromDb(row);
  }

  /** 检查用户是否有活跃的共享会话（非 ENDED 状态） */
  hasActiveSession(sharerUserId: string): boolean {
    const sessions = this.db.getActiveSessionsByUser(sharerUserId);
    return sessions.length > 0;
  }

  listAll(): ShareSession[] {
    return this.db.getAllSessions().map((s) => this.fromDb(s));
  }

  listByServer(serverId: string): ShareSession[] {
    return this.db.getSessionsByServer(serverId).map((s) => this.fromDb(s));
  }

  startSharing(token: string, clientId?: string, lowLatency?: boolean): ShareSession | undefined {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) {
      this.logger.warn(`startSharing: session not found or ended, token=${token.substring(0, 8)}...`);
      return undefined;
    }

    // 需求1: 一个链接只有第一个点开的人能共享
    if (session.publisherClientId && clientId && session.publisherClientId !== clientId) {
      this.logger.warn(
        `startSharing: rejected, publisher locked to ${session.publisherClientId.substring(0, 8)}..., got ${clientId.substring(0, 8)}...`,
      );
      return undefined;
    }
    if (!session.publisherClientId && clientId) {
      session.publisherClientId = clientId;
    }
    if (lowLatency !== undefined) {
      session.lowLatency = lowLatency;
    }

    const wasGrace = session.status === SessionStatus.GRACE;
    session.status = SessionStatus.ACTIVE;
    session.lastHeartbeat = Date.now();
    session.graceStartedAt = null;
    session.graceReason = null;
    session.lastViewerAt = Date.now();
    if (!session.startedAt) {
      session.startedAt = Date.now();
    }
    this.resumeViewerBilling(session.id, session.lastHeartbeat);

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        status: session.status,
        lastHeartbeat: session.lastHeartbeat,
        graceStartedAt: null,
        graceReason: null,
        lastViewerAt: session.lastViewerAt,
        startedAt: session.startedAt,
        publisherClientId: session.publisherClientId || null,
        lowLatency: session.lowLatency ? 1 : 0,
      });
    }

    this.logger.log(
      `startSharing: session=${session.id}, wasGrace=${wasGrace}, cardMessageId=${session.cardMessageId || 'none'}, targetChannelId=${session.targetChannelId || 'empty'}, lowLatency=${session.lowLatency}`,
    );

    if (!wasGrace && !session.cardMessageId) {
      this.logger.log(`startSharing: emitting session.started event for ${session.id}`);
      this.bus.emitSessionStarted({
        sessionId: session.id,
        token: session.token,
        sharerUsername: session.sharerUsername,
        targetChannelId: session.targetChannelId,
        guildId: session.guildId,
      });
    } else {
      this.logger.log(`startSharing: skipping card push (wasGrace=${wasGrace}, cardMessageId exists=${!!session.cardMessageId})`);
    }

    // 通知 SSE 控制器推送最新状态给发布端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount: session.viewerCount,
    });

    return session;
  }

  heartbeat(token: string): boolean {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) return false;
    session.lastHeartbeat = Date.now();
    if (
      session.status === SessionStatus.GRACE &&
      session.graceReason === 'heartbeat'
    ) {
      session.status = SessionStatus.ACTIVE;
      session.graceStartedAt = null;
      session.graceReason = null;
      this.resumeViewerBilling(session.id, session.lastHeartbeat);
      this.logger.log('session ' + session.id + ' reconnected within grace');
    }

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        lastHeartbeat: session.lastHeartbeat,
        status: session.status,
        graceStartedAt: session.graceStartedAt,
        graceReason: session.graceReason || null,
      });
    }
    return true;
  }

  /**
   * 停止共享：进入「恢复宽限期」而非立即结束。
   */
  stopSharing(token: string): ShareSession | undefined {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) return undefined;
    const now = Date.now();
    this.pauseViewerBilling(session.id, now);
    session.status = SessionStatus.GRACE;
    session.graceReason = 'stopped';
    session.graceStartedAt = now;
    session.lastHeartbeat = now;

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        status: session.status,
        graceReason: session.graceReason,
        graceStartedAt: session.graceStartedAt,
        lastHeartbeat: session.lastHeartbeat,
      });
    }

    const cfg = this.getServerSessionConfig(session.guildId);
    this.logger.log(
      `stopSharing: session=${session.id} entered 'stopped' grace, idle timeout ${cfg.idleTimeoutSec}s`,
    );

    // 通知 SSE 控制器推送最新状态给发布端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount: session.viewerCount,
    });

    return session;
  }

  /** SSE 观众连接。相同 viewerId 的重连或并发连接只计一个观众。 */
  viewerConnected(sessionId: string, viewerId: string): void {
    const session = this.getById(sessionId);
    if (!session || session.status === SessionStatus.ENDED) return;
    const now = Date.now();
    let viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) {
      viewers = new Map();
      this.viewerPresenceMap.set(sessionId, viewers);
    }
    const existing = viewers.get(viewerId);
    let isNewViewer = false;
    if (existing) {
      existing.connections += 1;
    } else {
      viewers.set(viewerId, {
        connections: 1,
        billingStartedAt: session.status === SessionStatus.ACTIVE ? now : null,
      });
      isNewViewer = true;
    }
    this.syncViewerMetrics(session, viewers.size, isNewViewer ? viewerId : undefined);
  }

  /** SSE 观众断开；最后一条同 viewerId 连接断开时结算本次在线区间。 */
  viewerDisconnected(sessionId: string, viewerId: string): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    const presence = viewers?.get(viewerId);
    if (!viewers || !presence) return;
    presence.connections -= 1;
    if (presence.connections <= 0) {
      this.accrueViewerDuration(sessionId, presence, Date.now());
      viewers.delete(viewerId);
    }
    if (viewers.size === 0) this.viewerPresenceMap.delete(sessionId);
    const session = this.getById(sessionId);
    if (session && session.status !== SessionStatus.ENDED) {
      this.syncViewerMetrics(session, viewers.size);
    }
  }

  private syncViewerMetrics(session: ShareSession, viewerCount: number, joinedViewerId?: string): void {
    // 更新峰值
    if (viewerCount > session.peakViewers) {
      session.peakViewers = viewerCount;
    }

    // 持久化到 DB
    this.db.updateSession(session.id, {
      viewerCount,
      peakViewers: session.peakViewers,
    });

    // 更新 lastViewerMap（用于 watchdog 的 no_viewer_timeout 检测）
    if (viewerCount > 0) {
      this.lastViewerMap.delete(session.id);
    } else if (!this.lastViewerMap.has(session.id)) {
      this.lastViewerMap.set(session.id, Date.now());
    }

    // viewerId 去重后记录加入数（用于 endSession 时持久化）
    if (joinedViewerId) {
      let ids = this.viewerIdsMap.get(session.id);
      if (!ids) {
        ids = new Set();
        this.viewerIdsMap.set(session.id, ids);
      }
      if (!ids.has(joinedViewerId)) {
        ids.add(joinedViewerId);
        this.recordViewerJoin(session.id, session.totalViewerJoins);
      }
    }

    // 通过 EventBus 推送状态变更，SSE 控制器监听此事件推给所有客户端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount,
    });
  }

  private accrueViewerDuration(
    sessionId: string,
    presence: ViewerPresence,
    now: number,
  ): void {
    if (presence.billingStartedAt === null) return;
    const session = this.getById(sessionId);
    const current = this.viewerDurationMsMap.get(sessionId)
      ?? session?.viewerDurationMs
      ?? 0;
    const next = current + Math.max(0, now - presence.billingStartedAt);
    this.viewerDurationMsMap.set(sessionId, next);
    presence.billingStartedAt = null;
    this.db.updateSession(sessionId, { viewerDurationMs: next });
  }

  private pauseViewerBilling(sessionId: string, now = Date.now()): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) return;
    for (const presence of viewers.values()) {
      this.accrueViewerDuration(sessionId, presence, now);
    }
  }

  private resumeViewerBilling(sessionId: string, now = Date.now()): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) return;
    for (const presence of viewers.values()) {
      if (presence.billingStartedAt === null) presence.billingStartedAt = now;
    }
  }

  private getViewerDurationMs(session: ShareSession, now = Date.now()): number | null {
    const stored = this.viewerDurationMsMap.get(session.id) ?? session.viewerDurationMs;
    if (stored === null) return null;
    let total = stored;
    const viewers = this.viewerPresenceMap.get(session.id);
    if (viewers) {
      for (const presence of viewers.values()) {
        if (presence.billingStartedAt !== null) {
          total += Math.max(0, now - presence.billingStartedAt);
        }
      }
    }
    return total;
  }

  /** 定期落盘活跃观众时长，降低进程异常退出造成的计费误差。 */
  @Interval(10_000)
  checkpointViewerDurations(): void {
    const now = Date.now();
    for (const sessionId of this.viewerPresenceMap.keys()) {
      this.pauseViewerBilling(sessionId, now);
      const session = this.getById(sessionId);
      if (session?.status === SessionStatus.ACTIVE) {
        this.resumeViewerBilling(sessionId, now);
      }
    }
  }

  setCardMessageId(sessionId: string, messageId: string): void {
    this.db.updateSession(sessionId, { cardMessageId: messageId });
  }

  /** 记录去重加入（仅写内存，session 结束时持久化到 DB） */
  recordViewerJoin(sessionId: string, persistedCount = 0): void {
    const current = this.joinCountMap.get(sessionId) ?? persistedCount;
    this.joinCountMap.set(sessionId, current + 1);
  }

  updateQuality(sessionId: string, quality: string): void {
    this.db.updateSession(sessionId, { quality });
    this.logger.log(`session ${sessionId} quality set to ${quality}`);
  }

  endSession(sessionId: string, reason: string): void {
    const session = this.getById(sessionId);
    if (!session || session.status === SessionStatus.ENDED) return;

    const ageMs = Date.now() - session.createdAt;
    const endedAt = Date.now();
    const durationMs = session.startedAt ? endedAt - session.startedAt : null;
    this.pauseViewerBilling(sessionId, endedAt);
    const viewerDurationMs = this.getViewerDurationMs(session, endedAt);

    // 持久化峰值和累计加入数（从内存 Map 取，不再实时写 DB）
    const totalJoins = this.joinCountMap.get(sessionId) ?? session.totalViewerJoins;
    const peakViewers = session.peakViewers;

    this.db.updateSession(sessionId, {
      status: SessionStatus.ENDED,
      endedAt,
      durationMs,
      totalViewerJoins: totalJoins,
      peakViewers,
      viewerDurationMs,
    });

    // 清理内存 Map
    this.lastViewerMap.delete(sessionId);
    this.joinCountMap.delete(sessionId);
    this.viewerPresenceMap.delete(sessionId);
    this.viewerDurationMsMap.delete(sessionId);
    this.viewerIdsMap.delete(sessionId);

    this.bus.emitSessionEnded({
      sessionId: session.id,
      reason,
      targetChannelId: session.targetChannelId,
      cardMessageId: session.cardMessageId,
    });
    this.logger.warn(
      `session ${session.id} ENDED: reason=${reason}, age=${(ageMs / 1000).toFixed(1)}s, ` +
      `startedAt=${session.startedAt ? 'yes' : 'no'}, ` +
      `duration=${durationMs}ms, peakViewers=${session.peakViewers}`,
    );
  }

  /** 删除已结束的 session 记录 */
  deleteSession(sessionId: string): boolean {
    const ok = this.db.deleteSession(sessionId);
    if (ok) this.logger.log(`session ${sessionId} record deleted`);
    return ok;
  }

  toInfo(session: ShareSession): SessionInfo {
    // 计算实时时长
    let durationMs = session.durationMs;
    if (session.startedAt && session.status !== SessionStatus.ENDED) {
      durationMs = Date.now() - session.startedAt;
    } else if (session.startedAt && session.endedAt) {
      durationMs = session.endedAt - session.startedAt;
    }

    const qi = getQualityInfo(session.quality);
    const durationSec = durationMs ? durationMs / 1000 : 0;

    // 主播：不订阅自己的视频流，始终按音频计费（互动直播音频系数=1）
    const broadcasterAudioCoeff = getAudioCoefficient(session.lowLatency, true);
    const broadcasterStandardSec = durationSec * broadcasterAudioCoeff;

    // 观众：订阅视频流，按 lowLatency 模式选择互动直播或极速直播视频系数
    const viewerVideoCoeff = getVideoCoefficient(qi.tier, session.lowLatency);
    const viewerDurationMs = this.getViewerDurationMs(session);
    const legacyViewerEstimate = viewerDurationMs === null;
    const viewerDurationSec = legacyViewerEstimate
      ? session.peakViewers * durationSec
      : viewerDurationMs / 1000;
    const viewerStandardSec = viewerDurationSec * viewerVideoCoeff;

    // 标准时长（分钟），向上取整
    const standardMinutes = durationMs
      ? Math.ceil((broadcasterStandardSec + viewerStandardSec) / 60)
      : 0;

    // 预估费用（后付费单价 0.007 元/标准分钟）
    const estimatedCost = Math.round(standardMinutes * STANDARD_MINUTE_PRICE * 100) / 100;

    const durationMin = durationSec / 60;
    const viewerDurationMin = viewerDurationSec / 60;
    const modeLabel = session.lowLatency ? '互动直播' : '极速直播';
    const billingDetail = durationMs
      ? legacyViewerEstimate
        ? `[旧记录估算] ${durationMin.toFixed(1)}主播分×系数${broadcasterAudioCoeff} + ${session.peakViewers}峰值观众×${durationMin.toFixed(1)}分×${modeLabel}系数${viewerVideoCoeff} = ${standardMinutes} 标准分钟`
        : `${durationMin.toFixed(1)}主播分×系数${broadcasterAudioCoeff} + ${viewerDurationMin.toFixed(1)}累计观众分×${modeLabel}系数${viewerVideoCoeff} = ${standardMinutes} 标准分钟`
      : '-';

    const serverConfig = this.db.getServer(session.guildId);
    const globalCfg = this.db.getGlobalConfig();
    const publicDomain = globalCfg.publicDomain;

    let idleRemainingSec: number | undefined;
    const cfg = this.getServerSessionConfig(session.guildId);
    if (session.status === SessionStatus.PENDING) {
      const elapsed = (Date.now() - session.createdAt) / 1000;
      idleRemainingSec = Math.max(0, Math.ceil(cfg.idleTimeoutSec - elapsed));
    } else if (session.status === SessionStatus.GRACE && session.graceStartedAt) {
      const elapsed = (Date.now() - session.graceStartedAt) / 1000;
      idleRemainingSec = Math.max(0, Math.ceil(cfg.idleTimeoutSec - elapsed));
    }

    let noViewerRemainingSec: number | undefined;
    const memLastViewer = this.lastViewerMap.get(session.id);
    if (
      session.status !== SessionStatus.ENDED &&
      session.viewerCount === 0 &&
      memLastViewer
    ) {
      const elapsed = (Date.now() - memLastViewer) / 1000;
      noViewerRemainingSec = Math.max(0, Math.ceil(cfg.noViewerTimeoutSec - elapsed));
    }

    // 从内存 Map 取实时 totalViewerJoins（不再实时写 DB）
    const liveJoins = this.joinCountMap.get(session.id) ?? session.totalViewerJoins;

    return {
      id: session.id,
      channel: session.channel,
      sharerUsername: session.sharerUsername,
      status: session.status,
      viewerCount: session.viewerCount,
      peakViewers: session.peakViewers,
      totalViewerJoins: liveJoins,
      viewerDurationMs,
      quality: session.quality,
      shareLink: `${publicDomain.replace(/\/+$/, '')}/share?t=${session.token}`,
      viewLink: `${publicDomain.replace(/\/+$/, '')}/view?t=${session.token}`,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs,
      billingMinutes: standardMinutes,
      billingDetail,
      standardMinutes,
      estimatedCost,
      publisherClientId: session.publisherClientId,
      idleRemainingSec,
      noViewerRemainingSec,
      lowLatency: session.lowLatency,
      allowLowLatency: !!serverConfig?.allowLowLatency,
    };
  }

  /** Session 最大生命周期（24 小时），防止 watchdog 异常停止时 session 永不过期 */
  private readonly MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

  @Interval(5000)
  async watchdog() {
    const now = Date.now();
    const sessions = this.db.getAllSessions().filter((s) => s.status !== 'ended');

    for (const row of sessions) {
      const session = this.fromDb(row);
      const cfg = this.getServerSessionConfig(session.guildId);

      // 绝对过期：超过最大生命周期强制结束
      if (now - session.createdAt > this.MAX_SESSION_AGE_MS) {
        this.endSession(session.id, 'max_age');
        continue;
      }

      // 无人观看倒计时（从内存 Map 读 lastViewerAt，不再查 DB）
      if (
        session.status !== SessionStatus.ENDED &&
        session.viewerCount === 0 &&
        this.lastViewerMap.has(session.id)
      ) {
        const lastViewerAt = this.lastViewerMap.get(session.id)!;
        if (now - lastViewerAt > cfg.noViewerTimeoutSec * 1000) {
          this.endSession(session.id, 'no_viewer_timeout');
          continue;
        }
      }

      // PENDING 状态：等待开始共享
      if (session.status === SessionStatus.PENDING) {
        if (now - session.createdAt > cfg.idleTimeoutSec * 1000) {
          this.endSession(session.id, 'idle_timeout');
        }
        continue;
      }

      // ACTIVE 状态：心跳丢失 → 进入 GRACE
      if (session.status === SessionStatus.ACTIVE) {
        const elapsed = now - session.lastHeartbeat;
        if (elapsed > cfg.heartbeatIntervalSec * 1000 * 3) {
          this.pauseViewerBilling(session.id, now);
          this.db.updateSession(session.id, {
            status: SessionStatus.GRACE,
            graceReason: 'heartbeat',
            graceStartedAt: now,
          });
          this.logger.warn(
            'session ' + session.id + ' heartbeat lost, entering grace',
          );
          this.bus.emitSessionStateChanged({
            sessionId: session.id,
            status: SessionStatus.GRACE,
            viewerCount: session.viewerCount,
          });
        }
        continue;
      }

      // GRACE 状态：统一使用 idleTimeoutSec
      if (session.status === SessionStatus.GRACE && session.graceStartedAt) {
        if (now - session.graceStartedAt > cfg.idleTimeoutSec * 1000) {
          this.endSession(session.id, 'idle_timeout');
          continue;
        }
      }
    }
  }
}
