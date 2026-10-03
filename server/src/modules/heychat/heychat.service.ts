import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { HeychatApiError } from './heychat-api.client';
import { AnalyticsService } from '../analytics/analytics.service';
import { DatabaseService, ServerRecord } from '../database/database.service';
import type { SessionEndedEvent, SessionStartedEvent } from '../events/events.service';
import { PlatformRegistryService } from '../platform/platform-registry.service';
import type { PlatformSessionAdapter } from '../platform/platform-session.adapter';
import { SessionService } from '../session/session.service';
import { HeychatApiService } from './heychat-api.service';
import {
  buildHeychatBindingCard,
  buildHeychatEndedCard,
  buildHeychatShareStartCard,
  buildHeychatViewingCard,
} from './heychat-card-builder';
import type {
  HeychatCardButtonEventData,
  HeychatCommandEventData,
  HeychatJoinedRoom,
  HeychatRoomMembershipEventData,
  HeychatTextMessageEventData,
} from './heychat.types';

@Injectable()
export class HeychatService implements OnModuleInit, OnModuleDestroy, PlatformSessionAdapter {
  readonly platform = 'heychat' as const;
  private readonly logger = new Logger(HeychatService.name);
  private processingCards = false;
  private stopping = false;
  private readonly recentTriggers = new Map<string, number>();
  private readonly triggerCooldownMs = 10_000;
  private readonly bindingEntranceCooldownMs = 30_000;
  private readonly lastBindingEntranceAt = new Map<string, number>();
  private readonly authorizedClaims = new Map<string, number>();
  private readonly authorizedClaimDedupMs = 20_000;
  private readonly handledMessageIds = new Map<string, number>();
  private readonly handledMessageWindowMs = 2 * 60_000;
  private roomSyncPromise: Promise<{ ok: boolean; rooms: number; error?: string }> | null = null;
  private roomSyncClient: object | null = null;
  private readonly pendingRoomRemovals = new Map<string, number>();
  private readonly normalRemovalConfirmations = 2;
  private readonly massRemovalRatio = 0.5;
  private lastSyncAt: number | null = null;
  private lastSyncError = '';

  constructor(
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly platformRegistry: PlatformRegistryService,
    private readonly analytics: AnalyticsService,
    private readonly api: HeychatApiService,
  ) {}

  private coverageBusy = false;
  private coverageCursor = 0;
  @Interval(5_000)
  async collectMemberCoverage() {
    if (this.coverageBusy || this.stopping || !this.api.client) return;
    const spaces = this.db.listSpaces('heychat').filter(s => s.status === 'active');
    if (!spaces.length) return;
    const space = spaces[this.coverageCursor++ % spaces.length];
    this.coverageBusy = true;
    try {
      const detail = await this.api.client.getRoom(space.externalId);
      if (detail.memberCount !== undefined) this.analytics.upsertServerMemberCount(space.serverId, detail.memberCount);
    } catch { /* Preserve the last known measurement; freshness is shown separately. */ }
    finally { this.coverageBusy = false; }
  }

  async onModuleInit(): Promise<void> {
    this.platformRegistry.register(this);
    if (this.api.isReady) await this.syncRooms();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.platformRegistry.unregister(this);
  }

  get isReady(): boolean {
    return this.api.isReady;
  }

  async syncRooms(strict = false): Promise<{ ok: boolean; rooms: number; error?: string }> {
    if (!this.api.client) return { ok: false, rooms: 0, error: 'heychat_not_configured' };
    if (this.roomSyncPromise) return this.roomSyncPromise;
    this.roomSyncPromise = this.performRoomSync(strict).finally(() => {
      this.roomSyncPromise = null;
    });
    return this.roomSyncPromise;
  }

  async handleCommand(event: HeychatCommandEventData): Promise<boolean> {
    // Heychat delivers one user command as both a type=50 command event and a
    // type=5 text event with the same msg_id. Handle the first, skip the twin.
    if (this.wasRecentlyHandled(event.msg_id)) return false;
    const handled = await this.processCommand(event);
    if (handled) this.markHandled(event.msg_id);
    return handled;
  }

  private async processCommand(event: HeychatCommandEventData): Promise<boolean> {
    if (!this.isOwnBot(event.bot_id) || !this.isFresh(event.send_time)) return false;
    const roomId = String(event.room_base_info?.room_id || '');
    const channelId = String(event.channel_base_info?.channel_id || '');
    const userId = String(event.sender_info?.user_id || '');
    const username = String(
      event.sender_info?.room_nickname || event.sender_info?.nickname || '小黑盒用户',
    );
    const command = this.normalizeCommand(event.command_info?.name || '');
    if (!roomId || !channelId || !userId || !command) return false;

    let space = this.db.getSpace(this.platform, roomId);
    if (!space) space = await this.discoverRoom(roomId, event.room_base_info?.room_name || '');
    if (!space) return false;

    if (command === 'xchelp' || command === 'help') {
      if (command === 'xchelp') {
        // One command owns the complete management flow: without a code it
        // opens/reissues the public entrance; with the browser code it
        // authorizes that browser claim for the room owner.
        const code = this.extractCommandOption(event, ['code', '验证码', 'challenge']);
        if (code) {
          const dedupKey = `${roomId}:${code}:${userId}`;
          const authorized = this.db.authorizeHeychatBindingClaim(roomId, code, userId);
          if (authorized) this.authorizedClaims.set(dedupKey, Date.now());
          const success = !!authorized
            || (this.authorizedClaims.get(dedupKey) || 0) > Date.now() - this.authorizedClaimDedupMs;
          await this.sendChannelNotice(
            roomId,
            channelId,
            success
              ? '✅ 设备已授权。请回到刚才打开绑定页面的浏览器设置管理密码；其他浏览器不会获得权限。'
              : '❌ 验证码无效、已过期，或你不是本房间房主。请从绑定页面重新获取验证码。',
          );
          return true;
        }
      }
      await this.sendHelp(space, userId, roomId, channelId);
      return true;
    }

    const triggerWords = space.triggerWords
      .split(',')
      .map((word) => this.normalizeCommand(word))
      .filter(Boolean);
    const isShareCommand = triggerWords.includes(command)
      || ['xc', '屏幕共享', '共享屏幕', '屏幕分享'].includes(command);
    if (!isShareCommand) return false;

    if (!space.bound || space.status !== 'active') {
      await this.sendChannelNotice(roomId, channelId, '该房间尚未绑定 Xgoat.Cast，请房主使用 `/xchelp` 获取绑定入口。');
      return true;
    }
    await this.createShareSession(space, channelId, userId, username);
    return true;
  }

  /**
   * Type 5 is the plain-message compatibility path. It is still emitted by
   * Heychat for unregistered/legacy command input, so accept only our exact
   * management/share commands or an 8-character binding code.
   */
  async handleTextMessage(event: HeychatTextMessageEventData): Promise<boolean> {
    if (event.bot_id !== undefined && !this.isOwnBot(event.bot_id)) return false;
    const raw = event as HeychatTextMessageEventData & Record<string, any>;
    const roomInfo = event.room_base_info || raw.room_info || raw.guild_info
      || (raw.room_id ? { room_id: String(raw.room_id), room_name: String(raw.room_name || '') } : undefined);
    const channelInfo = event.channel_base_info || raw.channel_info
      || (raw.channel_id
        ? { channel_id: String(raw.channel_id), channel_name: String(raw.channel_name || ''), channel_type: raw.channel_type }
        : undefined);
    const nestedUser = raw.user_info;
    const senderInfo = event.sender_info || raw.author_info
      || (nestedUser?.user_id !== undefined ? { user_id: nestedUser.user_id, nickname: nestedUser.nickname } : undefined)
      || (nestedUser?.user_base_info?.user_id !== undefined ? nestedUser.user_base_info : undefined)
      || (raw.user_id !== undefined && raw.user_id !== null && raw.user_id !== ''
        ? { user_id: raw.user_id, nickname: String(raw.nickname || '') }
        : undefined);
    const normalizedEvent = {
      ...event,
      room_base_info: roomInfo,
      channel_base_info: channelInfo,
      sender_info: senderInfo,
      msg_id: event.msg_id || raw.message_id || raw.id || `type5-${Date.now()}`,
      send_time: event.send_time || raw.msg_timestamp || raw.timestamp || Date.now(),
    } as HeychatTextMessageEventData;
    const text = [event.text, event.content, event.message, event.msg, raw.content_text]
      .map((value) => String(value || '').trim())
      .find(Boolean) || '';
    if (!text) return false;
    const match = text.match(/^\/?([^\s]+)(?:\s+(.+))?$/u);
    const bindingCode = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/i;
    const command = match ? this.normalizeCommand(match[1]) : '';
    const argument = String(match?.[2] || '').trim().toUpperCase();
    const bareCode = bindingCode.test(text);
    const textCode = this.extractCodeFromText(text);
    const configuredWords = roomInfo?.room_id
      ? this.db.getSpace(this.platform, String(roomInfo.room_id))?.triggerWords.split(',').map(word => this.normalizeCommand(word)) || []
      : [];
    if (!bareCode && !textCode && !['xchelp', 'help', 'xc', '屏幕共享', '共享屏幕', '屏幕分享', ...configuredWords].includes(command)) {
      return false;
    }
    // A bare 8-character code is the code itself; a command-prefixed text
    // ("/xchelp CODE" or the client-joined "/xchelpCODE") carries it as the
    // trailing token. Either way the xchelp flow authorizes the browser claim
    // instead of re-issuing the entrance.
    const commandName = bareCode || textCode ? 'xchelp' : command;
    const codeValue = argument || (bareCode ? text : '') || textCode;
    const options = codeValue ? [{ name: 'code', type: 1, value: codeValue }] : [];
    return this.handleCommand({
      bot_id: normalizedEvent.bot_id ?? this.api.botId ?? undefined,
      room_base_info: normalizedEvent.room_base_info,
      channel_base_info: normalizedEvent.channel_base_info,
      sender_info: normalizedEvent.sender_info,
      msg_id: normalizedEvent.msg_id,
      send_time: normalizedEvent.send_time,
      command_info: { name: commandName, options },
    });
  }

  async handleCardButton(event: HeychatCardButtonEventData): Promise<boolean> {
    if (event.event !== 'server' || !this.isFresh(event.send_time)) return false;
    if (event.value !== 'reshare' && event.value !== 'start_share') return false;
    const roomId = String(event.room_base_info?.room_id || '');
    const channelId = String(event.channel_base_info?.channel_id || '');
    const userId = String(event.sender_info?.user_id || '');
    const username = String(
      event.sender_info?.room_nickname || event.sender_info?.nickname || '小黑盒用户',
    );
    const space = this.db.getSpace(this.platform, roomId);
    if (!space || !space.bound || space.status !== 'active' || !channelId || !userId) {
      if (roomId && channelId) await this.sendChannelNotice(roomId, channelId, '该房间尚未绑定或当前不可用。');
      return true;
    }
    if (!event.msg_id) return false;
    if (event.value === 'reshare') {
      const session = this.sessionService.listByServer(space.serverId)
        .find((candidate) => candidate.platformMessageId === String(event.msg_id));
      if (!session || session.status !== 'ended') return false;
    }
    await this.createShareSession(space, channelId, userId, username);
    return true;
  }

  async handleRoomMembership(event: HeychatRoomMembershipEventData): Promise<boolean> {
    const userId = String(event.user_info?.user_id || '');
    if (!event.user_info?.bot || !this.api.botId || userId !== this.api.botId) return false;
    const roomId = String(event.room_base_info?.room_id || '');
    if (!roomId) return false;
    if (Number(event.state) === 1) {
      await this.discoverRoom(roomId, event.room_base_info?.room_name || '', true);
      return true;
    }
    if (Number(event.state) === 0) {
      const space = this.db.getSpace(this.platform, roomId);
      if (!space || space.status === 'kicked') return true;
      this.recordRoomEvent(space, 'bot_removed', 'bot_kicked', '机器人退出小黑盒房间');
      this.db.kickServer(space.serverId);
      return true;
    }
    return false;
  }

  async onSessionStarted(event: SessionStartedEvent): Promise<void> {
    this.db.enqueueCardJob(`heychat:start:${event.sessionId}`, JSON.stringify({
      kind: 'start', event, ackId: randomBytes(16).toString('hex'),
    }));
    await this.processCardJobs();
  }

  async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    if (!event.platformMessageId) return;
    this.db.enqueueCardJob(`heychat:end:${event.sessionId}`, JSON.stringify({ kind: 'end', event }));
    await this.processCardJobs();
  }

  /** Jobs survive restarts. Only one worker may send a given card at a time. */
  @Interval(5_000)
  async processCardJobs(): Promise<void> {
    if (this.processingCards || this.stopping || !this.api.client) return;
    this.processingCards = true;
    try {
      for (const job of this.db.getDueCardJobs()) {
        if (this.stopping || !this.api.client) break;
        const { kind, event, ackId } = JSON.parse(job.payload) as {
          kind: 'start' | 'end'; event: SessionEndedEvent; ackId?: string;
        };
        const session = this.sessionService.getById(event.sessionId);
        const space = this.db.getSpace(this.platform, event.externalSpaceId);
        if (!session || !space || !space.bound || space.status !== 'active'
          || !event.externalChannelId) {
          this.db.completeCardJob(job.job_key);
          continue;
        }
        const now = Date.now();
        if (kind === 'start' && session.platformMessageId) {
          if (session.status === 'ended') {
            await this.onSessionEnded({ ...event, platformMessageId: session.platformMessageId });
          }
          this.db.completeCardJob(job.job_key);
          continue;
        }
        if (kind === 'start' && session.status === 'ended') {
          this.db.completeCardJob(job.job_key);
          continue;
        }
        // Heychat documents only a short ack deduplication window. Never
        // blindly resend an uncertain create after that window (including restart).
        const deadline = (job.first_attempt_at ?? now) + 45_000;
        if (kind === 'start' && now >= deadline) {
          this.db.retryCardJob(job.job_key, now, 'Create outcome unknown; deduplication window expired', 'uncertain');
          this.logger.error(`Heychat card needs reconciliation: ${job.job_key}`);
          continue;
        }
        this.db.beginCardJob(job.job_key, now);
        try {
          if (kind === 'start') {
            const publicDomain = this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '');
            const messageId = await this.api.client.sendChannelCard(
              event.externalSpaceId, event.externalChannelId,
              buildHeychatViewingCard({ sharerUsername: session.sharerUsername,
                viewUrl: `${publicDomain}/view?t=${session.token}` }),
              { ackId: ackId!, deadline },
            );
            this.sessionService.setPlatformMessageId(event.sessionId, messageId);
            const latest = this.sessionService.getById(event.sessionId);
            if (latest?.status === 'ended') {
              await this.onSessionEnded({ ...event, platformMessageId: messageId });
            }
          } else {
            const messageId = session.platformMessageId || event.platformMessageId;
            if (!messageId) {
              this.db.completeCardJob(job.job_key);
              continue;
            }
            const info = this.sessionService.toInfo(session);
            await this.api.client.updateChannelCard(
              event.externalSpaceId, event.externalChannelId, messageId,
              buildHeychatEndedCard({ sharerUsername: session.sharerUsername,
                totalViewerJoins: session.totalViewerJoins || 0,
                durationMs: session.durationMs, standardMinutes: info.standardMinutes,
                estimatedCost: info.estimatedCost }),
            );
          }
          this.db.completeCardJob(job.job_key);
        } catch (error: any) {
          const permanent = error instanceof HeychatApiError && !error.retryable;
          const state = permanent ? 'failed' : 'pending';
          const delay = Math.max(error?.retryAfterMs || 0,
            Math.min(300_000, 5_000 * 2 ** Math.min(job.attempts, 6)));
          this.db.retryCardJob(job.job_key, Date.now() + delay, String(error?.message || error), state);
          this.logger.warn(`Heychat card ${job.job_key}: ${state}: ${error?.message || error}`);
        }
      }
    } finally {
      this.processingCards = false;
    }
  }

  private async performRoomSync(strict = false): Promise<{ ok: boolean; rooms: number; error?: string }> {
    const client = this.api.requireClient();
    if (client !== this.roomSyncClient) {
      this.roomSyncClient = client;
      this.pendingRoomRemovals.clear();
    }
    try {
      const rooms = await client.listJoinedRooms();
      if (!Array.isArray(rooms)) {
        throw new Error('Heychat joined-room response is not a verified array');
      }
      const normalizedRooms = rooms.map((room) => {
        const roomId = String(room?.room_id || '').trim();
        if (!roomId) throw new Error('Heychat joined-room response contains an invalid room');
        return { room, roomId };
      });
      const joined = new Set<string>();
      for (const { room, roomId } of normalizedRooms) {
        joined.add(roomId);
        await this.upsertRoom(room, true);
      }
      this.reconcileMissingRooms(joined);
      this.lastSyncAt = Date.now();
      this.lastSyncError = '';
      this.logger.log(`Heychat room sync complete: ${joined.size} room(s)`);
      return { ok: true, rooms: joined.size };
    } catch (error: any) {
      // Only consecutive, verified snapshots may confirm a removal. A failed or
      // malformed response breaks that chain instead of contributing to it.
      this.pendingRoomRemovals.clear();
      this.lastSyncAt = Date.now();
      this.lastSyncError = String(error?.message || error);
      this.logger.warn(`Heychat room sync failed: ${error?.message || error}`);
      if (strict) throw error;
      return { ok: false, rooms: 0, error: this.lastSyncError };
    }
  }

  get syncStatus(): { lastSyncAt: number | null; lastSyncError: string } {
    return { lastSyncAt: this.lastSyncAt, lastSyncError: this.lastSyncError };
  }

  private reconcileMissingRooms(joined: Set<string>): void {
    const activeSpaces = this.db.listSpaces(this.platform)
      .filter((space) => space.status !== 'kicked');
    const activeIds = new Set(activeSpaces.map((space) => space.externalId));
    const missing = activeSpaces.filter((space) => !joined.has(space.externalId));
    const suspicious = activeSpaces.length > 0 && (
      joined.size === 0
      || missing.length > 1
      || missing.length / activeSpaces.length >= this.massRemovalRatio
    );

    for (const externalId of this.pendingRoomRemovals.keys()) {
      if (joined.has(externalId) || !activeIds.has(externalId)) {
        this.pendingRoomRemovals.delete(externalId);
      }
    }

    if (suspicious) {
      // A list endpoint is not authoritative enough to erase multiple room
      // bindings. Explicit state=0 membership events remain the destructive
      // removal path; suspicious polling snapshots are observation-only.
      this.pendingRoomRemovals.clear();
      this.logger.warn(
        `Heychat suspicious room snapshot ignored for removals: active=${activeSpaces.length}, `
        + `joined=${joined.size}, missing=${missing.length}`,
      );
      return;
    }

    let confirmed = 0;
    for (const space of missing) {
      const observations = (this.pendingRoomRemovals.get(space.externalId) || 0) + 1;
      if (observations < this.normalRemovalConfirmations) {
        this.pendingRoomRemovals.set(space.externalId, observations);
        continue;
      }

      this.pendingRoomRemovals.delete(space.externalId);
      const changed = this.db.markServerAbsentPreservingBinding(space.serverId);
      if (!changed) continue;
      this.recordRoomEvent(space, 'bot_removed', 'bot_kicked', '房间同步连续确认机器人已退出');
      confirmed += 1;
    }

    if (missing.length > confirmed) {
      this.logger.warn(
        `Heychat room removals awaiting confirmation: missing=${missing.length}, `
        + `confirmed=${confirmed}, suspicious=${suspicious}`,
      );
    }
  }

  private async discoverRoom(
    roomId: string,
    fallbackName: string,
    sendInitialBind = false,
  ): Promise<ServerRecord | undefined> {
    if (!this.api.client) return undefined;
    try {
      const detail = await this.api.client.getRoom(roomId);
      if (!String(detail.ownerId || '').trim()) {
        throw new Error('Heychat room detail is missing a verified owner');
      }
      return this.upsertRoom({
        room_id: roomId,
        room_name: detail.roomName || fallbackName,
        create_by: detail.ownerId,
        public_id: detail.publicId,
      }, sendInitialBind, detail.textChannels.find((channel) => !!channel.channel_id)?.channel_id);
    } catch (error: any) {
      this.logger.warn(`Heychat room discovery failed: room=${roomId}: ${error?.message || error}`);
      return undefined;
    }
  }

  private async upsertRoom(
    room: HeychatJoinedRoom,
    sendInitialBind: boolean,
    initialChannelId?: string,
  ): Promise<ServerRecord> {
    const roomId = String(room.room_id);
    const previous = this.db.getSpace(this.platform, roomId);
    const shouldNotify = !previous || previous.status === 'kicked';
    const incomingOwnerId = String(room.create_by || '').trim();
    const recoveredUnboundOwner = !!previous
      && !previous.bound
      && !String(previous.ownerId || '').trim()
      && !!incomingOwnerId;
    let space = this.db.createSpace({
      platform: this.platform,
      externalId: roomId,
      displayName: String(room.room_name || ''),
      ownerId: incomingOwnerId,
      publicId: String(room.public_id || ''),
    });
    this.db.updateServer(space.serverId, {
      guildName: String(room.room_name || space.guildName),
      ownerId: incomingOwnerId || space.ownerId,
      openId: String(room.public_id || space.openId),
    });
    space = this.db.getServer(space.serverId)!;

    if (shouldNotify) {
      this.recordRoomEvent(space, 'bot_joined', 'bot_joined', '机器人加入小黑盒房间');
    }
    if (
      (shouldNotify || recoveredUnboundOwner)
      && sendInitialBind
      && incomingOwnerId
      && space.ownerId === incomingOwnerId
    ) {
      void this.publishBindingEntrance(space, initialChannelId).catch((error: any) => {
        this.logger.warn(`Heychat initial binding message failed: ${error?.message || error}`);
      });
    }
    return space;
  }

  private async sendHelp(
    space: ServerRecord,
    userId: string,
    roomId: string,
    channelId: string,
  ): Promise<void> {
    const publicDomain = this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '');
    if (userId === space.ownerId) {
      if (space.bound) {
        await this.sendChannelNotice(
          roomId,
          channelId,
          `🐑 **Xgoat.Cast 已绑定**\n\n[打开房间管理面板](${publicDomain}/spaces/heychat/${encodeURIComponent(space.externalId)})`,
        );
      } else {
        try {
          await this.publishBindingEntrance(space, channelId);
        } catch (error: any) {
          this.logger.warn(`Heychat binding entrance publish failed: ${error?.message || error}`);
          try {
            await this.sendChannelNotice(roomId, channelId, '绑定入口暂时发送失败，请稍后重试。');
          } catch {
            // The channel itself may be unavailable; keep command handling non-fatal.
          }
        }
      }
      return;
    }
    const firstTrigger = space.triggerWords.split(',').map((word) => word.trim()).find(Boolean) || '屏幕共享';
    await this.sendChannelNotice(
      roomId,
      channelId,
      `🐑 **Xgoat.Cast 使用说明**\n\n在文字频道使用 \`/${firstTrigger}\` 发起屏幕共享；房主可使用 \`/xchelp\` 获取绑定入口。`,
    );
  }

  private async publishBindingEntrance(space: ServerRecord, preferredChannelId?: string): Promise<void> {
    const client = this.api.client;
    if (!client || space.bound || space.status !== 'active') return;
    // Heychat delivers one user command as several events with different
    // sequences; a cooldown keeps the duplicate pushes from publishing a
    // second binding entrance (and revoking the first intent).
    const now = Date.now();
    if (now - (this.lastBindingEntranceAt.get(space.externalId) || 0) < this.bindingEntranceCooldownMs) return;
    this.lastBindingEntranceAt.set(space.externalId, now);
    let channelId = preferredChannelId || '';
    if (!channelId) {
      const detail = await client.getRoom(space.externalId);
      channelId = detail.textChannels.find((channel) => !!channel.channel_id)?.channel_id || '';
    }
    if (!channelId) throw new Error('Heychat room has no text channel for binding entrance');
    const intent = this.db.createHeychatBindingIntent(space.externalId);
    if (!intent) return;
    const publicDomain = this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '');
    const bindUrl = `${publicDomain}/spaces/heychat/${encodeURIComponent(space.externalId)}?bind=${encodeURIComponent(intent.intentId)}`;
    await client.sendChannelCard(
      space.externalId,
      channelId,
      buildHeychatBindingCard({ roomName: space.guildName || space.externalId, bindUrl }),
    );
  }

  private async createShareSession(
    space: ServerRecord,
    channelId: string,
    userId: string,
    username: string,
  ): Promise<void> {
    if (!this.api.client) return;
    if (this.sessionService.hasActiveSession(userId, this.platform)) {
      await this.sendChannelNotice(space.externalId, channelId, '你已有一个未结束的屏幕共享，请先结束后再发起。');
      return;
    }
    const cooldownKey = `${userId}:${channelId}`;
    const previous = this.recentTriggers.get(cooldownKey) || 0;
    if (Date.now() - previous < this.triggerCooldownMs) {
      await this.sendChannelNotice(space.externalId, channelId, '操作过于频繁，请稍后再试。');
      return;
    }
    this.recentTriggers.set(cooldownKey, Date.now());

    const session = this.sessionService.createSession({
      platform: this.platform,
      spaceId: space.serverId,
      externalSpaceId: space.externalId,
      externalChannelId: channelId,
      sharerUserId: userId,
      sharerUsername: username,
    });
    const publicDomain = this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '');
    try {
      await this.api.client.sendChannelCard(
        space.externalId,
        channelId,
        buildHeychatShareStartCard({
          sharerUsername: username,
          shareUrl: `${publicDomain}/share?t=${session.token}`,
        }),
      );
    } catch (error: any) {
      this.sessionService.cancelPendingSession(session.id, 'heychat_channel_message_failed');
      this.logger.error(`Heychat channel start card failed: ${error?.message || error}`);
    }
  }

  private async sendChannelNotice(roomId: string, channelId: string, message: string): Promise<void> {
    if (!roomId || !channelId || !this.api.client) return;
    try {
      await this.api.client.sendChannelMarkdown(roomId, channelId, message);
    } catch (error: any) {
      this.logger.warn(`Heychat channel notice failed: ${error?.message || error}`);
    }
  }

  private recordRoomEvent(
    space: ServerRecord,
    analyticsType: 'bot_joined' | 'bot_removed',
    databaseType: string,
    detail: string,
  ): void {
    const occurredAt = Date.now();
    this.analytics.recordServerEvent({
      eventKey: `heychat_${analyticsType}:${space.externalId}:${occurredAt}`,
      serverSnowflakeId: space.serverId,
      serverName: space.guildName,
      eventType: analyticsType,
      occurredAt,
    });
    this.db.addServerEvent(space.serverId, databaseType, space.ownerId, '', detail);
  }

  private isOwnBot(botId: string | number | undefined): boolean {
    return !!this.api.botId && String(botId || '') === this.api.botId;
  }

  private isFresh(sentAt?: number): boolean {
    const timestamp = Number(sentAt);
    return Number.isFinite(timestamp) && timestamp > 0 && Math.abs(Date.now() - timestamp) <= 5 * 60_000;
  }

  private wasRecentlyHandled(msgId?: string): boolean {
    if (!msgId) return false;
    const at = this.handledMessageIds.get(msgId);
    return !!at && Date.now() - at < this.handledMessageWindowMs;
  }

  private markHandled(msgId?: string): void {
    if (!msgId) return;
    this.handledMessageIds.set(msgId, Date.now());
  }

  private extractCommandOption(event: HeychatCommandEventData, names: string[]): string {
    const options = event.command_info?.options || [];
    const normalized = new Set(names.map((name) => this.normalizeCommand(name)));
    const selected = options.find((option) => normalized.has(this.normalizeCommand(option.name || '')))
      || options[0];
    const optionValue = String(selected?.value || '').trim().toUpperCase();
    if (optionValue) return optionValue;
    // Type 50 events carry the full command text in msg while options stay
    // empty; the binding code then lives in the text, with or without a space.
    const raw = event as HeychatCommandEventData & { msg?: string };
    if (raw.msg) return this.extractCodeFromText(raw.msg);
    return '';
  }

  /** Extract an 8-character binding code from "/xchelp CODE", "/xchelpCODE" or bare "CODE" text. */
  private extractCodeFromText(text: string): string {
    const trimmed = text.trim();
    const spaced = /^\/?xchelp\s+([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.exec(trimmed);
    if (spaced) return spaced[1];
    const joined = /^\/?(?:xchelp|xc)([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.exec(trimmed);
    if (joined) return joined[1];
    const bare = /^([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.exec(trimmed);
    return bare ? bare[1].toUpperCase() : '';
  }

  private normalizeCommand(value: string): string {
    return value.trim().replace(/^\/+/, '').toLowerCase();
  }
}
