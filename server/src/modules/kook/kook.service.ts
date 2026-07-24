import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { DatabaseService } from '../database/database.service';
import { EventBusService } from '../events/events.service';
import { buildShareLinkCard, buildViewingCard, buildEndedShareCard, buildHelpCard, buildBindCard, buildAlreadyBoundCard, buildBindRequestCard } from './card-builder';
import { KookClient, KookMessageEvent, KookButtonClickEvent } from './kook-client';

@Injectable()
export class KookService implements OnModuleInit {
  private readonly logger = new Logger(KookService.name);
  private bot: KookClient | null = null;
  /** 已处理的消息 ID 去重（LRU 式，防止 WebSocket 重连后重放导致重复处理） */
  private processedMessageIds = new Set<string>();
  private readonly MAX_PROCESSED_IDS = 500;
  /** 用户+频道维度的触发频率限制，防止快速连发导致重复创建 session */
  private recentTriggers = new Map<string, number>();
  private readonly TRIGGER_COOLDOWN_MS = 10000; // 10 秒冷却
  private publishingViewingCards = new Set<string>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly bus: EventBusService,
  ) {}

  async onModuleInit() {
    this.bus.onSessionStarted((event) => this.handleSessionStarted(event));
    this.bus.onSessionEnded((event) => this.handleSessionEnded(event));
    await this.startBot();
  }

  async startBot() {
    const globalCfg = this.db.getGlobalConfig();
    const token = globalCfg.kookBotToken;
    if (!token) {
      this.logger.warn('KOOK bot token not configured, set it in Super Admin panel');
      return;
    }
    try {
      this.bot = new KookClient(token);

      this.bot.on('ready', async (user: any) => {
        this.logger.log('KOOK bot ready: ' + (user?.username || '(unknown)') + ' (id=' + (user?.id || 'null') + ')');
        // If bot info not in HELLO, fetch from API
        if (!user?.id) {
          try {
            const me = await this.bot?.getMe();
            if (me?.id) {
              this.logger.log(`KOOK bot info fetched from API: ${me.username} (id=${me.id})`);
              // Update botId in KookClient
              (this.bot as any).botId = me.id;
            }
          } catch (err) {
            this.logger.warn('Failed to fetch bot info from API: ' + err);
          }
        }
        // Sync existing guilds - 即使没有 bot 信息也要执行
        await this.syncGuilds();
      });
      this.bot.on('error', (err: any) => {
        this.logger.error('KOOK bot error: ' + (err?.message || err));
      });
      this.bot.on('close', (code: number) => {
        this.logger.warn(`KOOK bot connection closed (code: ${code})`);
      });
      this.bot.on('message', async (event: KookMessageEvent) => {
        await this.handleMessage(event);
      });
      this.bot.on('button_click', async (event: KookButtonClickEvent) => {
        await this.handleButtonClick(event);
      });
      this.bot.on('guild_join', async (event: { guildId: string; guildName: string }) => {
        await this.handleGuildJoin(event.guildId, event.guildName);
      });
      this.bot.on('guild_leave', async (event: { guildId: string }) => {
        await this.handleGuildLeave(event.guildId);
      });

      this.logger.log('KOOK bot starting...');
      await this.bot.start();
    } catch (err: any) {
      this.logger.error('KOOK bot init failed: ' + (err?.message || err));
    }
  }

  get isRunning(): boolean {
    return this.bot?.isRunning() ?? false;
  }

  /** Sync bot's current guilds with database */
  private async syncGuilds() {
    try {
      this.logger.log('[SYNC] Starting guild sync...');
      const guilds = await this.bot?.getGuildList() || [];
      this.logger.log(`[SYNC] Found ${guilds.length} guilds from KOOK API`);
      
      let syncedCount = 0;
      let skippedCount = 0;
      
      for (const guild of guilds) {
        const guildId = guild.id;  // 雪花 ID
        const existing = this.db.getServer(guildId);
        if (!existing) {
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
          this.db.createServer(guildId, guild.name || '', ownerId, '', openId);
          syncedCount++;
        } else {
          skippedCount++;
        }
      }
      this.logger.log(`[SYNC] Guild sync complete: ${syncedCount} new, ${skippedCount} existing, ${guilds.length} total`);
    } catch (err: any) {
      this.logger.error('[SYNC] Failed to sync guilds: ' + (err?.message || err));
    }
  }

  /** Bot joins a guild: create server record and send bind card to owner */
  private async handleGuildJoin(guildId: string, guildName: string) {
    this.logger.log(`[EVENT] Bot joining guild: guildId=${guildId}, guildName=${guildName || '(empty)'}`);
    
    // Wait a bit for the bot to fully join the guild
    this.logger.log(`[API] Waiting 2s before fetching guild info for ${guildId}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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
    const server = this.db.createServer(guildId, guildName, ownerId, '', openId);
    
    // 记录机器人加入事件
    this.db.addServerEvent(guildId, 'bot_joined', ownerId, guildName, `机器人加入服务器`);

    // Send bind card to guild owner as temp message in a text channel
    if (ownerId) {
      try {
        // Get guild channels to find a text channel
        this.logger.log(`[API] Fetching channels for guild ${guildId}...`);
        const channels = await this.bot?.getGuildChannels(guildId) || [];
        const textChannel = channels.find((ch: any) => ch.type === 1); // type=1 is text channel
        
        if (textChannel) {
          const globalCfg = this.db.getGlobalConfig();
          const bindToken = this.db.generateBindToken(guildId);
          const bindUrl = `${globalCfg.publicDomain}/${guildId}?t=${bindToken}`;
          this.logger.log(`[CARD] Sending temp bind card to owner ${ownerId} in channel ${textChannel.id}...`);
          const card = buildBindCard({
            guildName,
            openId: openId || undefined,
            serverId: guildId,
            bindUrl,
          });
          // Send as a temporary message visible only to the owner
          await this.bot?.sendTempCardMessage(textChannel.id, card, ownerId);
          this.logger.log(`[CARD] Temp bind card sent successfully to owner ${ownerId} in channel ${textChannel.id}`);
        } else {
          this.logger.warn(`[CARD] No text channel found in guild ${guildId}, skipping bind card`);
        }
      } catch (err: any) {
        this.logger.error(`[CARD] Failed to send bind card to owner ${ownerId}: ${err?.message || err}`);
      }
    } else {
      this.logger.warn(`[CARD] No owner found for guild ${guildId}, skipping bind card`);
    }
  }

  /** Bot leaves a guild: mark server as kicked (don't delete) */
  private async handleGuildLeave(guildId: string) {
    this.logger.log(`[EVENT] Bot leaving guild: guildId=${guildId}`);
    
    // 记录机器人被踢出事件
    this.db.addServerEvent(guildId, 'bot_kicked', '', '', '机器人被踢出服务器');
    
    // 标记服务器为已踢出（不删除记录）
    this.db.kickServer(guildId);
  }

  /** Get server config for a guild (guildId is snowflake ID from events) */
  private getServerConfig(guildId: string) {
    const server = this.db.getServer(guildId);
    if (!server || !server.bound || server.status !== 'active') return null;
    return {
      openId: server.openId,  // 公开 ID（用于面板显示）
      agora: {
        appId: server.agoraAppId,
        appCertificate: server.agoraAppCertificate,
        tokenExpireSec: server.agoraTokenExpireSec,
        allowedQualities: JSON.parse(server.allowedQualities),
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

  private async handleMessage(event: KookMessageEvent) {
    const content = (event.content || '').trim();
    if (!content) return;

    // 消息 ID 去重：防止 WebSocket 重连后消息重放导致重复处理
    if (event.id) {
      if (this.processedMessageIds.has(event.id)) {
        this.logger.warn(`duplicate message ignored: ${event.id}`);
        return;
      }
      this.processedMessageIds.add(event.id);
      // 清理旧 ID，防止内存无限增长
      if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
        const firstId = this.processedMessageIds.values().next().value;
        if (firstId) this.processedMessageIds.delete(firstId);
      }
    }

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

      // 用户+频道维度频率限制，防止快速连发重复创建 session
      const channelId =
        event.target_id || event.channel_id || event.extra?.channel_id || '';
      const cooldownKey = `${authorId}:${channelId}`;
      const lastTrigger = this.recentTriggers.get(cooldownKey);
      if (lastTrigger && Date.now() - lastTrigger < this.TRIGGER_COOLDOWN_MS) {
        this.logger.warn(
          `trigger cooldown: ${authorId} in ${channelId}, ignoring (within ${this.TRIGGER_COOLDOWN_MS}ms)`,
        );
        return;
      }
      this.recentTriggers.set(cooldownKey, Date.now());
      // 清理过期的冷却记录
      if (this.recentTriggers.size > 100) {
        const now = Date.now();
        for (const [k, v] of this.recentTriggers) {
          if (now - v > this.TRIGGER_COOLDOWN_MS * 2) {
            this.recentTriggers.delete(k);
          }
        }
      }

      await this.handleShareCommand(event, guildId, serverConfig);
    }
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

    let server = this.db.getServer(guildId);
    if (!server) {
      server = this.db.createServer(
        guildId,
        guildInfo?.name || '',
        ownerId,
        '',
        guildInfo?.open_id || '',
      );
      this.logger.log(`[HELP] Recreated deleted server ${guildId}; binding is required`);
    }

    const triggerWords = server.triggerWords || '屏幕共享,共享屏幕';

    // 已绑定：发送已绑定提示卡片（含触发词说明和管理面板入口）
    if (server.bound) {
      const globalCfg = this.db.getGlobalConfig();
      const domain = globalCfg.publicDomain;
      const manageUrl = `${domain}/${guildId}`;
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
    const bindUrl = `${globalCfg.publicDomain}/${guildId}?t=${bindToken}`;
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
      guildId,
      targetChannelId: channelId,
      serverId: guildId,  // 使用雪花 ID
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
      this.sessionService.deleteSession(session.id);
      await this.sendTempNotice(
        channelId,
        authorId,
        `发起屏幕共享失败：${err?.message || '无法发送开始卡片，请稍后重试'}`,
      );
    }
  }

  /** 处理卡片按钮点击回调（如「重新发起共享」） */
  private async handleButtonClick(event: KookButtonClickEvent) {
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

    // 检查用户是否有活跃的共享会话
    if (this.sessionService.hasActiveSession(event.userId)) {
      this.logger.warn(`button_click rejected: user ${event.userId} already has an active session`);
      await this.sendTempNotice(event.targetId, event.userId, '你已有一个未结束的屏幕共享，请先结束后再发起。');
      return;
    }

    // 频率限制，防止快速连点重复创建 session
    const cooldownKey = `${event.userId}:${event.targetId}`;
    const lastTrigger = this.recentTriggers.get(cooldownKey);
    if (lastTrigger && Date.now() - lastTrigger < this.TRIGGER_COOLDOWN_MS) {
      this.logger.warn(`button_click cooldown: ${event.userId} in ${event.targetId}`);
      await this.sendTempNotice(event.targetId, event.userId, '操作过于频繁，请稍后再试。');
      return;
    }
    this.recentTriggers.set(cooldownKey, Date.now());

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
      guildId,
      targetChannelId: event.targetId,
      serverId: guildId,  // 使用雪花 ID
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
      this.sessionService.deleteSession(session.id);
      await this.sendTempNotice(
        event.targetId,
        event.userId,
        `发起屏幕共享失败：${err?.message || '无法发送开始卡片，请稍后重试'}`,
      );
    }
  }

  private async handleSessionStarted(event: {
    sessionId: string;
    token: string;
    sharerUsername: string;
    targetChannelId: string;
    guildId: string;
  }) {
    this.logger.log(
      `handleSessionStarted: sessionId=${event.sessionId}, targetChannelId=${event.targetChannelId || '(empty)'}, bot=${!!this.bot}, isRunning=${this.bot?.isRunning()}`,
    );
    const session = this.sessionService.getById(event.sessionId);
    if (!session || session.cardMessageId || this.publishingViewingCards.has(event.sessionId)) return;
    const serverConfig = this.getServerConfig(event.guildId);
    if (!serverConfig || !event.targetChannelId || !this.bot?.isRunning()) return;

    this.publishingViewingCards.add(event.sessionId);
    try {
      const current = this.sessionService.getById(event.sessionId);
      if (!current || current.cardMessageId || current.status !== 'active') return;
      const publicDomain = serverConfig.publicDomain.replace(/\/+$/, '');
      const card = buildViewingCard({
        sharerUsername: event.sharerUsername,
        viewUrl: `${publicDomain}/view?t=${event.token}`,
      });
      const result = await this.bot.sendCardMessage(event.targetChannelId, card);
      const msgId = result?.msg_id || result?.data?.msg_id;
      if (msgId) {
        this.sessionService.setCardMessageId(event.sessionId, msgId);
        const latest = this.sessionService.getById(event.sessionId);
        if (latest?.status === 'ended') {
          await this.handleSessionEnded({
            sessionId: event.sessionId,
            targetChannelId: event.targetChannelId,
            cardMessageId: msgId,
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

  private async handleSessionEnded(event: {
    sessionId: string;
    targetChannelId?: string;
    cardMessageId?: string;
    reason: string;
  }) {
    this.logger.log(
      `handleSessionEnded: sessionId=${event.sessionId}, reason=${event.reason}, ` +
      `cardMessageId=${event.cardMessageId || '(none)'}, targetChannelId=${event.targetChannelId || '(none)'}, ` +
      `botRunning=${this.bot?.isRunning() ?? false}`,
    );

    if (!this.bot || !this.bot.isRunning()) {
      this.logger.warn(
        `handleSessionEnded: bot not running, skip for ${event.sessionId}`,
      );
      return;
    }

    const session = this.sessionService.getById(event.sessionId);
    
    // 计算标准时长和预估费用
    const info = session ? this.sessionService.toInfo(session) : null;
    const standardMinutes = info?.standardMinutes || 0;
    const estimatedCost = info?.estimatedCost || 0;

    // 只有真正开播后创建过公开观看卡片，才允许发布公开结束状态。
    if (event.cardMessageId) {
      try {
        const endedShareCard = buildEndedShareCard({
          sharerUsername: session?.sharerUsername || '匿名用户',
          totalViewerJoins: session?.totalViewerJoins || 0,
          durationMs: session?.durationMs || null,
          standardMinutes,
          estimatedCost,
        });
        await this.bot.updateMessage(event.cardMessageId, JSON.stringify(endedShareCard), 10);
        this.logger.log(`ended card updated: ${event.cardMessageId}`);
      } catch (err: any) {
        this.logger.error('update ended card failed: ' + (err?.message || err));
        // 更新失败时，发送新卡片作为降级方案
        await this.sendNewEndedCard(event.targetChannelId, session, standardMinutes, estimatedCost);
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
