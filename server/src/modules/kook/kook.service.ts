import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { DatabaseService } from '../database/database.service';
import type { SessionEndedEvent, SessionStartedEvent } from '../events/events.service';
import type { PlatformSessionAdapter } from '../platform/platform-session.adapter';
import { PlatformRegistryService } from '../platform/platform-registry.service';
import { buildShareLinkCard, buildViewingCard, buildEndedShareCard, buildHelpCard, buildBindCard, buildAlreadyBoundCard, buildBindRequestCard } from './card-builder';
import { KookApiClient, KookApiError } from './kook-api.client';
import { KookMessageEvent, KookButtonClickEvent } from './kook-event.types';
import { AnalyticsService } from '../analytics/analytics.service';
import { sanitizeAllowedQualities } from '../session/session.types';

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

interface StaleGuildCandidateState {
  definitiveConfirmations: number;
  inconclusiveAttempts: number;
}

@Injectable()
export class KookService implements OnModuleInit, OnModuleDestroy, PlatformSessionAdapter {
  readonly platform = 'kook' as const;
  private readonly logger = new Logger(KookService.name);
  private bot: KookApiClient | null = null;
  /** 按用户共用 CD，按钮、文字指令和切换频道都不能绕过。 */
  private recentTriggers = new Map<string, number>();
  private readonly TRIGGER_COOLDOWN_MS = 10_000;
  private publishingViewingCards = new Set<string>();
  private coverageTimer: ReturnType<typeof setInterval> | null = null;
  private coverageRefreshInProgress = false;
  private readonly coverageRefreshMs = 6 * 60 * 60_000;
  private readonly coverageRequestGapMs = 250;
  private staleGuildConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly staleGuildCandidates = new Map<string, StaleGuildCandidateState>();
  private readonly staleGuildRequiredConfirmations = 2;
  private readonly staleGuildMaxInconclusiveAttempts = 3;
  private readonly staleGuildMinimumSnapshotRatio = 0.9;
  private readonly staleGuildConfirmationDelayMs = 30_000;

  constructor(
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly platformRegistry: PlatformRegistryService,
    private readonly analytics: AnalyticsService,
  ) {}

  async onModuleInit() {
    this.platformRegistry.register(this);
    await this.startApiClient();
    this.coverageTimer = setInterval(
      () => void this.refreshCoverage(),
      this.coverageRefreshMs,
    );
  }

  onModuleDestroy(): void {
    this.platformRegistry.unregister(this);
    if (this.coverageTimer) clearInterval(this.coverageTimer);
    this.coverageTimer = null;
    this.clearStaleGuildReconciliationState();
  }

  async startApiClient() {
    const globalCfg = this.db.getGlobalConfig();
    const token = globalCfg.kookBotToken;
    if (!token) {
      this.logger.warn('KOOK bot token not configured, set it in Super Admin panel');
      return;
    }
    try {
      this.bot = new KookApiClient(token);
      const me = await this.bot.getMe();
      if (me?.id) this.bot.setBotId(String(me.id));
      this.logger.log(`KOOK API client ready: ${me?.username || '(unknown)'} (id=${me?.id || 'unknown'})`);
      await this.syncGuilds();
      void this.refreshCoverage();
    } catch (err: any) {
      this.logger.error('KOOK API client init failed: ' + (err?.message || err));
    }
  }

  get isReady(): boolean {
    return !!this.bot;
  }

  /** Sync bot's current guilds with database */
  private async syncGuilds(scheduleConfirmation = true) {
    try {
      this.logger.log('[SYNC] Starting guild sync...');
      const guilds = await this.bot?.getGuildList() || [];
      this.logger.log(`[SYNC] Found ${guilds.length} guilds from KOOK API`);
      const guildIds = new Set<string>();
      
      let syncedCount = 0;
      let skippedCount = 0;
      
      for (const guild of guilds) {
        const guildId = String(guild?.id || '').trim(); // 雪花 ID
        if (!guildId || guildIds.has(guildId)) {
          throw new KookApiError('KOOK guild snapshot has missing or duplicate IDs', true);
        }
        guildIds.add(guildId);
        const existing = this.db.getSpace(this.platform, guildId);
        if (!existing || existing.status === 'kicked') {
          // 获取详细信息以获取 open_id 和 user_id
          let openId = '';
          let ownerId = '';
          try {
            const guildInfo = await this.bot?.getGuild(guildId);
            openId = guildInfo?.open_id || '';
            ownerId = guildInfo?.user_id || guild.owner_id || '';
            this.logger.log(`[SYNC] Guild info for ${guild.name} (${guildId}): open_id=${openId}, user_id=${ownerId}`);
          } catch (err) {
            this.logger.warn(`[SYNC] Failed to get guild info for ${guildId}: ${err}`);
          }
          this.logger.log(`[SYNC] Creating new server record: ${guild.name} (${guildId})`);
          const created = this.db.createSpace({
            platform: this.platform,
            externalId: guildId,
            spaceId: guildId,
            displayName: guild.name || '',
            ownerId,
            publicId: openId,
          });
          const occurredAt = Date.now();
          this.analytics.recordServerEvent({
            eventKey: `guild_sync_join:${guildId}:${occurredAt}`,
            serverSnowflakeId: guildId,
            serverName: created.guildName,
            eventType: 'bot_joined',
            occurredAt,
          });
          syncedCount++;
        } else {
          skippedCount++;
        }
      }
      await this.reconcileMissingGuilds(guildIds, scheduleConfirmation);
      this.logger.log(`[SYNC] Guild sync complete: ${syncedCount} new, ${skippedCount} existing, ${guilds.length} total`);
    } catch (err: any) {
      this.clearStaleGuildReconciliationState();
      this.logger.error('[SYNC] Failed to sync guilds: ' + (err?.message || err));
    }
  }

  /**
   * Reclaim stale active rows conservatively. A row is changed only after two
   * consecutive complete list snapshots omit it and guild/view independently
   * returns KOOK's definitive absent/deleted response on both passes.
   * Suspiciously small snapshots, transient/ambiguous errors and successful
   * detail lookups preserve the current row.
   */
  private async reconcileMissingGuilds(
    guildIds: ReadonlySet<string>,
    scheduleConfirmation: boolean,
  ): Promise<void> {
    const activeSpaces = this.db.listSpaces(this.platform)
      .filter((space) => space.status === 'active');
    const activeIds = new Set(activeSpaces.map((space) => space.externalId));

    for (const candidateId of this.staleGuildCandidates.keys()) {
      if (guildIds.has(candidateId) || !activeIds.has(candidateId)) {
        this.staleGuildCandidates.delete(candidateId);
      }
    }

    const missing = activeSpaces.filter((space) => !guildIds.has(space.externalId));
    if (missing.length === 0) {
      this.clearStaleGuildReconciliationState();
      return;
    }

    const knownPresent = activeSpaces.length - missing.length;
    const snapshotRatio = activeSpaces.length > 0
      ? knownPresent / activeSpaces.length
      : 1;
    if (snapshotRatio < this.staleGuildMinimumSnapshotRatio) {
      this.clearStaleGuildReconciliationState();
      this.logger.warn(
        `[SYNC] Stale reconciliation skipped: suspicious snapshot `
        + `${knownPresent}/${activeSpaces.length} known active guilds present`,
      );
      return;
    }

    for (const space of missing) {
      const state = this.staleGuildCandidates.get(space.externalId) || {
        definitiveConfirmations: 0,
        inconclusiveAttempts: 0,
      };
      if (state.inconclusiveAttempts >= this.staleGuildMaxInconclusiveAttempts) {
        continue;
      }

      const confirmation = await this.probeMissingGuild(space.externalId);
      if (confirmation === 'present') {
        this.staleGuildCandidates.delete(space.externalId);
        continue;
      }
      if (confirmation === 'unknown') {
        const inconclusiveAttempts = state.inconclusiveAttempts + 1;
        this.staleGuildCandidates.set(space.externalId, {
          definitiveConfirmations: 0,
          inconclusiveAttempts,
        });
        if (inconclusiveAttempts >= this.staleGuildMaxInconclusiveAttempts) {
          this.logger.warn(
            `[SYNC] Stale probe retry limit reached for ${space.externalId}; `
            + 'leaving the server active',
          );
        }
        continue;
      }

      const confirmations = state.definitiveConfirmations + 1;
      if (confirmations < this.staleGuildRequiredConfirmations) {
        this.staleGuildCandidates.set(space.externalId, {
          definitiveConfirmations: confirmations,
          inconclusiveAttempts: state.inconclusiveAttempts,
        });
        continue;
      }

      this.staleGuildCandidates.delete(space.externalId);
      const changed = this.db.markServerAbsentPreservingBinding(space.serverId);
      if (!changed) continue;

      const removedAt = Date.now();
      this.analytics.recordServerEvent({
        eventKey: `guild_sync_absent:${space.externalId}:${removedAt}`,
        serverSnowflakeId: space.serverId,
        serverName: space.guildName,
        eventType: 'bot_removed',
        reason: 'api_confirmed_absent',
        occurredAt: removedAt,
      });
      this.db.addServerEvent(
        space.serverId,
        'bot_kicked',
        '',
        '',
        'KOOK API 连续两次确认机器人已不在服务器；已保留绑定和声网配置',
      );
      this.logger.warn(
        `[SYNC] Marked stale guild absent after ${confirmations} confirmations: ${space.externalId}`,
      );
    }

    const pendingCandidateCount = this.countPendingStaleGuildCandidates();
    if (scheduleConfirmation && pendingCandidateCount > 0) {
      this.scheduleStaleGuildConfirmation(pendingCandidateCount);
    } else if (pendingCandidateCount === 0 && this.staleGuildConfirmationTimer) {
      clearTimeout(this.staleGuildConfirmationTimer);
      this.staleGuildConfirmationTimer = null;
    }
  }

  private async probeMissingGuild(
    guildId: string,
  ): Promise<'present' | 'missing' | 'unknown'> {
    if (!this.bot) return 'unknown';
    try {
      const detail = await this.bot.getGuild(guildId);
      return String(detail?.id || '') === guildId ? 'present' : 'unknown';
    } catch (error) {
      if (this.isDefinitiveMissingGuildError(error)) {
        return 'missing';
      }
      this.logger.warn(
        `[SYNC] Stale probe inconclusive for ${guildId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return 'unknown';
    }
  }

  private isDefinitiveMissingGuildError(error: unknown): boolean {
    if (!(error instanceof KookApiError) || error.retryable) return false;
    // KOOK currently returns HTTP 200/code 40000 for a guild the bot can no
    // longer access. Do not treat other non-retryable 4xx/business errors as
    // absence: they may represent permissions, invalid auth or API changes.
    if (error.status !== 200) return false;
    if (error.kookCode !== 40000 && error.kookCode !== 40400) return false;
    const message = (error.kookMessage || error.message).toLowerCase();
    return message.includes('server does not exist')
      || message.includes('server has been deleted')
      || message.includes('guild does not exist')
      || /服务器.*(?:不存在|已被删除)/.test(message);
  }

  private countPendingStaleGuildCandidates(): number {
    let count = 0;
    for (const state of this.staleGuildCandidates.values()) {
      if (state.inconclusiveAttempts < this.staleGuildMaxInconclusiveAttempts) count++;
    }
    return count;
  }

  private clearStaleGuildReconciliationState(): void {
    this.staleGuildCandidates.clear();
    if (this.staleGuildConfirmationTimer) clearTimeout(this.staleGuildConfirmationTimer);
    this.staleGuildConfirmationTimer = null;
  }

  private scheduleStaleGuildConfirmation(candidateCount: number): void {
    if (this.staleGuildConfirmationTimer) return;
    this.logger.warn(
      `[SYNC] ${candidateCount} stale candidate(s); `
      + `confirmation scheduled in ${this.staleGuildConfirmationDelayMs}ms`,
    );
    this.staleGuildConfirmationTimer = setTimeout(() => {
      this.staleGuildConfirmationTimer = null;
      void this.syncGuilds(true);
    }, this.staleGuildConfirmationDelayMs);
    this.staleGuildConfirmationTimer.unref?.();
  }

  /** Refresh aggregate coverage without retaining KOOK member records. */
  async refreshCoverage(): Promise<void> {
    if (!this.bot || this.coverageRefreshInProgress) return;
    this.coverageRefreshInProgress = true;
    try {
      const guilds = await this.bot.getGuildList();
      let totalMemberCount = 0;
      let successfulServerCount = 0;
      let failedServerCount = 0;

      for (const guild of guilds) {
        const guildId = String(guild?.id || '');
        if (!guildId) continue;
        try {
          const memberCount = await this.bot.getGuildMemberCount(guildId);
          this.analytics.upsertServerMemberCount(guildId, memberCount);
          totalMemberCount += memberCount;
          successfulServerCount += 1;
        } catch (error: any) {
          failedServerCount += 1;
          const cached = this.analytics.getLatestMemberCount(guildId);
          if (cached) totalMemberCount += cached.memberCount;
          this.logger.warn(
            `[COVERAGE] Failed guild ${guildId}: ${error?.message || error}`,
          );
          if (error instanceof KookApiError && error.status === 429) {
            await this.delay(Math.min(Math.max(error.retryAfterMs || 1_000, 250), 30_000));
          }
        }
        await this.delay(this.coverageRequestGapMs);
      }

      const capturedAt = Date.now();
      this.analytics.recordCoverageSnapshot({
        snapshotKey: String(
          Math.floor(capturedAt / this.coverageRefreshMs) * this.coverageRefreshMs,
        ),
        capturedAt,
        totalMemberCount,
        successfulServerCount,
        failedServerCount,
      });
      this.logger.log(
        `[COVERAGE] ${totalMemberCount} members, fresh ${successfulServerCount}/${guilds.length}`,
      );
    } catch (error: any) {
      // Preserve the last snapshot when the guild list itself is unavailable.
      this.logger.warn(`[COVERAGE] Refresh skipped: ${error?.message || error}`);
    } finally {
      this.coverageRefreshInProgress = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Bot joins a guild: create server record and send bind cards to inviter and owner. */
  async handleGuildJoin(guildId: string, guildName: string, inviterId = '') {
    this.logger.log(
      `[EVENT] Bot joining guild: guildId=${guildId}, guildName=${guildName || '(empty)'}, `
      + `inviterId=${inviterId || '(unknown)'}`,
    );
    
    // Wait a bit for the bot to fully join the guild
    this.logger.log(`[API] Waiting 2s before fetching guild info for ${guildId}...`);
    await this.delay(2000);
    
    // Get guild info to find open_id and owner
    let ownerId = '';
    let openId = '';
    
    // Retry getting guild info up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.logger.log(`[API] Fetching guild info for ${guildId} (attempt ${attempt}/3)...`);
        const guildInfo = await this.bot?.getGuild(guildId);
        this.logger.log(`[API] Guild info response: ${JSON.stringify(guildInfo || {})}`);
        // KOOK API fields:
        // - id: snowflake ID (不变，用于主键和 URL)
        // - open_id: public ID (可变，用于面板显示)
        // - user_id: server owner's user ID (用于发私信)
        // - name: server name
        ownerId = guildInfo?.user_id || '';
        openId = guildInfo?.open_id || '';
        if (!guildName && guildInfo?.name) {
          guildName = guildInfo.name;
        }
        this.logger.log(`[API] Guild info parsed: id=${guildId}, open_id=${openId}, user_id=${ownerId}, name=${guildName}`);
        if (ownerId) break;
        this.logger.warn(`[API] Attempt ${attempt}: No user_id in guild info, retrying...`);
      } catch (err: any) {
        this.logger.error(`[API] Attempt ${attempt}: Failed to get guild info: ${err?.message || err}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    // serverId = guildId (雪花 ID，不变，用于主键和 URL)
    // openId 存储用于面板显示
    this.logger.log(`[DB] Creating/reactivating server record: guildId=${guildId}, guildName=${guildName}, ownerId=${ownerId}, openId=${openId}`);
    const server = this.db.createSpace({
      platform: this.platform,
      externalId: guildId,
      spaceId: guildId,
      displayName: guildName,
      ownerId,
      publicId: openId,
    });
    const joinedAt = Date.now();
    this.analytics.recordServerEvent({
      eventKey: `guild_join:${guildId}:${joinedAt}`,
      serverSnowflakeId: guildId,
      serverName: server.guildName,
      eventType: 'bot_joined',
      occurredAt: joinedAt,
    });
    
    const normalizedInviterId = String(inviterId || '').trim();
    const botId = this.bot?.getBotId() || '';
    const recipientIds = [...new Set([normalizedInviterId, ownerId]
      .filter((userId) => userId && userId !== '1' && userId !== botId))];

    // 记录机器人加入事件；优先记录真实邀请人，旧事件无邀请人时保持原有服务器主信息。
    this.db.addServerEvent(
      guildId,
      'bot_joined',
      normalizedInviterId || ownerId,
      guildName,
      `机器人加入服务器`,
    );

    // KOOK temporary messages support one recipient per message, so send the
    // same binding card once to each unique recipient.
    if (recipientIds.length > 0 && this.bot) {
      try {
        // Get guild channels to find a text channel
        this.logger.log(`[API] Fetching channels for guild ${guildId}...`);
        const channels = await this.bot.getGuildChannels(guildId) || [];
        const textChannel = channels.find((ch: any) => ch.type === 1); // type=1 is text channel
        
        if (textChannel) {
          const globalCfg = this.db.getGlobalConfig();
          const bindToken = this.db.generateBindToken(guildId);
          const bindUrl = `${globalCfg.publicDomain}/kook/${guildId}?t=${bindToken}`;
          const card = buildBindCard({
            guildName,
            openId: openId || undefined,
            serverId: guildId,
            bindUrl,
          });
          const deliveries = await Promise.allSettled(recipientIds.map(async (recipientId) => {
            this.logger.log(
              `[CARD] Sending temp bind card to ${recipientId} in channel ${textChannel.id}...`,
            );
            await this.bot!.sendTempCardMessage(textChannel.id, card, recipientId);
            this.logger.log(
              `[CARD] Temp bind card sent successfully to ${recipientId} in channel ${textChannel.id}`,
            );
          }));
          deliveries.forEach((delivery, index) => {
            if (delivery.status === 'fulfilled') return;
            const reason = delivery.reason;
            this.logger.error(
              `[CARD] Failed to send bind card to ${recipientIds[index]}: ${reason?.message || reason}`,
            );
          });
        } else {
          this.logger.warn(`[CARD] No text channel found in guild ${guildId}, skipping bind card`);
        }
      } catch (err: any) {
        this.logger.error(`[CARD] Failed to prepare bind cards for guild ${guildId}: ${err?.message || err}`);
      }
    } else {
      this.logger.warn(`[CARD] No inviter or owner found for guild ${guildId}, skipping bind card`);
    }
  }

  /** Bot leaves a guild: mark server as kicked (don't delete) */
  async handleGuildLeave(guildId: string) {
    this.logger.log(`[EVENT] Bot leaving guild: guildId=${guildId}`);
    const snapshot = this.db.getSpace(this.platform, guildId);
    const removedAt = Date.now();
    this.analytics.recordServerEvent({
      eventKey: `guild_leave:${guildId}:${removedAt}`,
      serverSnowflakeId: guildId,
      serverName: snapshot?.guildName,
      eventType: 'bot_removed',
      occurredAt: removedAt,
    });
    
    // 记录机器人被踢出事件
    this.db.addServerEvent(guildId, 'bot_kicked', '', '', '机器人被踢出服务器');
    
    // 标记服务器为已踢出（不删除记录）
    this.db.kickServer(guildId);
  }

  /** Get server config for a guild (guildId is snowflake ID from events) */
  private getServerConfig(guildId: string) {
    const server = this.db.getSpace(this.platform, guildId);
    if (!server || !server.bound || server.status !== 'active') return null;
    return {
      spaceId: server.serverId,
      openId: server.openId,  // 公开 ID（用于面板显示）
      agora: {
        appId: server.agoraAppId,
        appCertificate: server.agoraAppCertificate,
        tokenExpireSec: server.agoraTokenExpireSec,
        allowedQualities: sanitizeAllowedQualities(safeParse(server.allowedQualities)),
      },
      session: {
        idleTimeoutSec: server.idleTimeoutSec,
        heartbeatIntervalSec: server.heartbeatIntervalSec,
        noViewerTimeoutSec: server.noViewerTimeoutSec,
      },
      triggerWords: server.triggerWords,
      publicDomain: this.db.getGlobalConfig().publicDomain,
    };
  }

  async handleIncomingMessage(event: KookMessageEvent) {
    const content = (event.content || '').trim();
    if (!content) return;

    // 忽略机器人自己发的消息，防止死循环（三重保险）
    const botId = this.bot?.getBotId();
    const authorId = event.author_id || event.extra?.author?.id || '';
    if (botId && authorId === botId) return;
    if (this.bot?.isOwnMessage(event.id)) return;
    // 卡片消息（content 是 JSON 数组）不可能是普通用户发的，直接跳过
    if (content.startsWith('[')) return;

    let guildId = event.guild_id || event.extra?.guild_id || '';

    // 如果 guild_id 为空，尝试通过频道 ID 查询（某些 KOOK 事件可能不包含 guild_id）
    if (!guildId) {
      const channelId = event.target_id || event.channel_id || event.extra?.channel_id || '';
      if (channelId) {
        try {
          const channelInfo = await this.bot?.getChannelInfo(channelId);
          guildId = channelInfo?.guild_id || '';
          if (guildId) {
            this.logger.debug(`Resolved guild_id=${guildId} from channel ${channelId}`);
          }
        } catch (err) {
          this.logger.warn(`Failed to get guild_id from channel ${channelId}: ${err}`);
        }
      }
    }

    // 综合帮助指令（绑定/管理/使用说明，仅 /xchelp 触发）
    if (content === '/xchelp' || content === 'xchelp') {
      await this.handleHelpCommand(event, guildId);
      return;
    }

    // Get server config for trigger words
    const serverConfig = this.getServerConfig(guildId);
    if (!serverConfig) {
      this.logger.debug(`Ignoring trigger for unbound or inactive server ${guildId || '(unknown)'}`);
      return;
    }
    const triggerWordsStr = serverConfig.triggerWords;
    const triggerWords = triggerWordsStr
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);

    // 检查是否包含任意触发词
    const matched = triggerWords.some((word) => content.includes(word));
    if (matched) {
      this.logger.debug(
        `KOOK message: target_id=${event.target_id}, ` +
        `guild_id=${guildId}, ` +
        `author_id=${authorId}, ` +
        `extra keys=${event.extra ? Object.keys(event.extra).join(',') : '(no extra)'}`,
      );

      const channelId =
        event.target_id || event.channel_id || event.extra?.channel_id || '';
      if (!this.acceptShareTrigger(authorId, channelId, event.receivedAt)) return;

      await this.handleShareCommand(event, guildId, serverConfig);
    }
  }

  private acceptShareTrigger(userId: string, channelId: string, receivedAt?: number): boolean {
    if (!userId || !channelId) return false;
    const now = Date.now();
    const arrival = Number.isFinite(receivedAt) && receivedAt > 0
      ? Math.min(receivedAt, now)
      : now;
    const previous = this.recentTriggers.get(userId);
    // A click received during CD stays rejected even when API delays mean it
    // is only handled after CD has expired. Also bound actual send frequency.
    if (previous !== undefined && (arrival < previous || now < previous)) {
      this.logger.debug(`share trigger cooldown: ${userId} in ${channelId}, ignoring queued/repeated request`);
      return false;
    }

    // Keep records needed by older queued events: cleanup follows inbox arrival
    // time rather than the wall clock while a backlog is being processed.
    if (this.recentTriggers.size > 100) {
      for (const [id, until] of this.recentTriggers) {
        if (until <= arrival) this.recentTriggers.delete(id);
      }
    }
    this.recentTriggers.set(userId, now + this.TRIGGER_COOLDOWN_MS);
    return true;
  }

  /** Handle /xchelp command: owner gets bind/manage card, others get help with share button */
  private async handleHelpCommand(event: KookMessageEvent, guildId: string) {
    if (!guildId) {
      this.logger.warn('[HELP] No guildId resolved for help command');
      return;
    }

    const authorId = event.author_id || event.extra?.author?.id || '';
    if (!authorId) return;

    // 获取服务器信息以校验是否为服务器主
    let ownerId = '';
    let guildInfo: any;
    try {
      guildInfo = await this.bot?.getGuild(guildId);
      ownerId = guildInfo?.user_id || '';
    } catch (err: any) {
      this.logger.error(`[HELP] Failed to get guild info for ${guildId}: ${err?.message || err}`);
      return;
    }

    // 非服务器主：发送使用说明卡片（临时卡片，含发起屏幕共享按钮）
    if (authorId !== ownerId) {
      const sc = this.getServerConfig(guildId);
      await this.sendHelpTemp(event.target_id, authorId, sc?.triggerWords, !!sc);
      this.logger.debug(`[HELP] Sent temp help card to non-owner ${authorId}`);
      return;
    }

    let server = this.db.getSpace(this.platform, guildId);
    if (!server) {
      server = this.db.createSpace({
        platform: this.platform,
        externalId: guildId,
        spaceId: guildId,
        displayName: guildInfo?.name || '',
        ownerId,
        publicId: guildInfo?.open_id || '',
      });
      this.logger.log(`[HELP] Recreated deleted server ${guildId}; binding is required`);
    }

    const triggerWords = server.triggerWords || '屏幕共享,共享屏幕';

    // 已绑定：发送已绑定提示卡片（含触发词说明和管理面板入口）
    if (server.bound) {
      const globalCfg = this.db.getGlobalConfig();
      const domain = globalCfg.publicDomain;
      const manageUrl = `${domain}/kook/${guildId}`;
      const card = buildAlreadyBoundCard({
        guildName: server.guildName,
        manageUrl,
        triggerWords,
      });
      try {
        await this.bot?.sendTempCardMessage(event.target_id, card, authorId);
        this.logger.log(`[HELP] Sent already-bound card to owner ${authorId} in guild ${guildId}`);
      } catch (err: any) {
        this.logger.error(`[HELP] Failed to send already-bound card: ${err?.message || err}`);
      }
      return;
    }

    // 未绑定：生成临时 token 并发送绑定卡片
    const bindToken = this.db.generateBindToken(guildId);
    const globalCfg = this.db.getGlobalConfig();
    const bindUrl = `${globalCfg.publicDomain}/kook/${guildId}?t=${bindToken}`;
    const card = buildBindRequestCard({
      guildName: server.guildName,
      openId: server.openId || undefined,
      serverId: guildId,
      bindUrl,
    });
    try {
      await this.bot?.sendTempCardMessage(event.target_id, card, authorId);
      this.logger.log(`[HELP] Sent bind request card to owner ${authorId} in guild ${guildId}`);
    } catch (err: any) {
      this.logger.error(`[HELP] Failed to send bind request card: ${err?.message || err}`);
    }
  }

  private async handleShareCommand(event: KookMessageEvent, guildId: string, serverConfig: any) {
    const authorId = event.author_id || event.extra?.author?.id || '';
    const authorName = event.extra?.author?.username || 'KOOK用户';
    const channelId =
      event.target_id || event.channel_id || event.extra?.channel_id || '';

    const session = this.sessionService.createSession({
      sharerUserId: authorId,
      sharerUsername: authorName,
      platform: this.platform,
      spaceId: serverConfig.spaceId,
      externalSpaceId: guildId,
      externalChannelId: channelId,
    });

    const publicDomain = serverConfig.publicDomain.replace(/\/+$/, '');
    const shareLink = `${publicDomain}/share?t=${session.token}`;

    // 仅发起人可见；公开观看卡片在发布端真正开始后发送。
    const card = buildShareLinkCard({
      sharerUsername: authorName,
      shareUrl: shareLink,
    });
    try {
      await this.bot?.sendTempCardMessage(channelId, card, authorId);
      this.logger.log(`temporary start card sent to ${authorId} in ${channelId}`);
    } catch (err: any) {
      this.logger.error('send temporary start card failed: ' + (err?.message || err));
      this.sessionService.cancelPendingSession(session.id);
      await this.sendTempNotice(
        channelId,
        authorId,
        `发起屏幕共享失败：${err?.message || '无法发送开始卡片，请稍后重试'}`,
      );
    }
  }

  /** 处理卡片按钮点击回调（如「重新发起共享」） */
  async handleButtonClick(event: KookButtonClickEvent) {
    this.logger.log(
      `button_click: value=${event.value}, user=${event.username}(${event.userId}), ` +
      `channel=${event.targetId}, guild=${event.guildId || '(none)'}`,
    );

    // Handle bind confirmation button
    if (event.value.startsWith('bind_')) {
      // The bind is done via web page, not button click
      return;
    }

    if (event.value !== 'reshare' && event.value !== 'start_share') return;

    if (!this.acceptShareTrigger(event.userId, event.targetId, event.receivedAt)) return;

    // 检查用户是否有活跃的共享会话
    if (this.sessionService.hasActiveSession(event.userId, this.platform)) {
      this.logger.warn(`button_click rejected: user ${event.userId} already has an active session`);
      await this.sendTempNotice(event.targetId, event.userId, '你已有一个未结束的屏幕共享，请先结束后再发起。');
      return;
    }

    const authorName = event.username || 'KOOK用户';
    
    // 如果 guildId 为空，尝试通过频道 ID 查询
    let guildId = event.guildId || '';
    if (!guildId && event.targetId) {
      try {
        const channelInfo = await this.bot?.getChannelInfo(event.targetId);
        guildId = channelInfo?.guild_id || '';
        if (guildId) {
          this.logger.log(`Resolved guild_id=${guildId} from channel ${event.targetId}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to get guild_id from channel ${event.targetId}: ${err}`);
      }
    }

    const serverConfig = this.getServerConfig(guildId);
    if (!serverConfig) {
      this.logger.warn(`button_click ignored for unbound or inactive server ${guildId || '(unknown)'}`);
      await this.sendTempNotice(event.targetId, event.userId, '该服务器尚未绑定或当前不可用，请让服务器主先发送 /xchelp 完成绑定。');
      return;
    }

    const session = this.sessionService.createSession({
      sharerUserId: event.userId,
      sharerUsername: authorName,
      platform: this.platform,
      spaceId: serverConfig.spaceId,
      externalSpaceId: guildId,
      externalChannelId: event.targetId,
    });

    const publicDomain = serverConfig.publicDomain.replace(/\/+$/, '');
    const shareLink = `${publicDomain}/share?t=${session.token}`;

    const card = buildShareLinkCard({
      sharerUsername: authorName,
      shareUrl: shareLink,
    });

    try {
      await this.bot?.sendTempCardMessage(event.targetId, card, event.userId);
      this.logger.log(`temporary button start card sent to ${event.userId} in ${event.targetId}`);
    } catch (err: any) {
      this.logger.error('temporary button start card failed: ' + (err?.message || err));
      this.sessionService.cancelPendingSession(session.id);
      await this.sendTempNotice(
        event.targetId,
        event.userId,
        `发起屏幕共享失败：${err?.message || '无法发送开始卡片，请稍后重试'}`,
      );
    }
  }

  async onSessionStarted(event: SessionStartedEvent): Promise<void> {
    this.logger.log(
      `onSessionStarted: sessionId=${event.sessionId}, externalChannelId=${event.externalChannelId || '(empty)'}, apiReady=${!!this.bot}`,
    );
    const session = this.sessionService.getById(event.sessionId);
    if (!session || session.platformMessageId || this.publishingViewingCards.has(event.sessionId)) return;
    const serverConfig = this.getServerConfig(event.externalSpaceId);
    if (!serverConfig || !event.externalChannelId || !this.bot) return;

    this.publishingViewingCards.add(event.sessionId);
    try {
      const current = this.sessionService.getById(event.sessionId);
      if (!current || current.platformMessageId || current.status !== 'active') return;
      const publicDomain = serverConfig.publicDomain.replace(/\/+$/, '');
      const card = buildViewingCard({
        sharerUsername: event.sharerUsername,
        viewUrl: `${publicDomain}/view?t=${event.token}`,
      });
      const result = await this.bot.sendCardMessage(event.externalChannelId, card);
      const msgId = result?.msg_id || result?.data?.msg_id;
      if (msgId) {
        this.sessionService.setPlatformMessageId(event.sessionId, msgId);
        const latest = this.sessionService.getById(event.sessionId);
        if (latest?.status === 'ended') {
          await this.onSessionEnded({
            ...event,
            platformMessageId: msgId,
            reason: 'ended_during_viewing_card_publish',
          });
        }
      }
      this.logger.log(`public viewing card sent for ${event.sessionId}, msgId=${msgId || 'none'}`);
    } catch (err: any) {
      this.logger.error(`send public viewing card failed for ${event.sessionId}: ${err?.message || err}`);
    } finally {
      this.publishingViewingCards.delete(event.sessionId);
    }
  }

  async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    this.logger.log(
      `onSessionEnded: sessionId=${event.sessionId}, reason=${event.reason}, ` +
      `platformMessageId=${event.platformMessageId || '(none)'}, externalChannelId=${event.externalChannelId || '(none)'}, ` +
      `apiReady=${!!this.bot}`,
    );

    if (!this.bot) {
      this.logger.warn(`onSessionEnded: KOOK API client unavailable, skip for ${event.sessionId}`);
      return;
    }

    const session = this.sessionService.getById(event.sessionId);
    
    // 计算标准时长和预估费用
    const info = session ? this.sessionService.toInfo(session) : null;
    const standardMinutes = info?.standardMinutes || 0;
    const estimatedCost = info?.estimatedCost || 0;

    // 只有真正开播后创建过公开观看卡片，才允许发布公开结束状态。
    if (event.platformMessageId) {
      try {
        const endedShareCard = buildEndedShareCard({
          sharerUsername: session?.sharerUsername || '匿名用户',
          totalViewerJoins: session?.totalViewerJoins || 0,
          durationMs: session?.durationMs || null,
          standardMinutes,
          estimatedCost,
        });
        await this.bot.updateMessage(event.platformMessageId, JSON.stringify(endedShareCard), 10);
        this.logger.log(`ended card updated: ${event.platformMessageId}`);
      } catch (err: any) {
        this.logger.error('update ended card failed: ' + (err?.message || err));
        // 更新失败时，发送新卡片作为降级方案
        await this.sendNewEndedCard(event.externalChannelId, session, standardMinutes, estimatedCost);
      }
    } else {
      this.logger.log(`session ${event.sessionId} ended without a public viewing card; no public ended card sent`);
    }
  }

  private async sendNewEndedCard(
    targetChannelId: string | undefined,
    session: any,
    standardMinutes: number,
    estimatedCost: number,
  ) {
    if (!targetChannelId) return;

    try {
      const endedCard = buildEndedShareCard({
        sharerUsername: session?.sharerUsername || '匿名用户',
        totalViewerJoins: session?.totalViewerJoins || 0,
        durationMs: session?.durationMs || null,
        standardMinutes,
        estimatedCost,
      });
      await this.bot?.sendCardMessage(targetChannelId, endedCard);
      this.logger.log(`new ended card sent to ${targetChannelId}`);
    } catch (err: any) {
      this.logger.error('send ended card failed: ' + (err?.message || err));
    }
  }

  private async sendHelpTemp(channelId: string, userId: string, triggerWords?: string, showShareButton = true) {
    const card = buildHelpCard({ triggerWords, showShareButton });
    try {
      await this.bot?.sendTempCardMessage(channelId, card, userId);
    } catch (err: any) {
      this.logger.error('send temp help card failed: ' + (err?.message || err));
    }
  }

  private async sendTempNotice(channelId: string, userId: string, message: string) {
    if (!channelId || !userId) return;
    try {
      await this.bot?.sendTempTextMessage(channelId, message, userId);
    } catch (err: any) {
      this.logger.error(`send temporary notice failed: ${err?.message || err}`);
    }
  }
}
