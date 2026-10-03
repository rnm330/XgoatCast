import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService, ServerRecord } from '../database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SessionService } from '../session/session.service';
import { PlatformRegistryService } from '../platform/platform-registry.service';
import type { PlatformSessionAdapter } from '../platform/platform-session.adapter';
import type { SessionStartedEvent, SessionEndedEvent } from '../events/events.service';
import { QqApiError, QqApiService } from './qq-api.service';
import { qqAdmin, qqCommand, QqEvent } from './qq-protocol';
import { QqDelivery, qqHash, QqRepository } from './qq.repository';

const messageEvents = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']);
const membershipEvents = new Set(['GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_RECEIVE', 'GROUP_MSG_REJECT']);

@Injectable()
export class QqService implements OnModuleInit, OnModuleDestroy, PlatformSessionAdapter {
  readonly platform = 'qq' as const;
  private readonly logger = new Logger(QqService.name);
  private working = false;
  private sending = false;
  private stopping = false;
  private readonly lastGroupSend = new Map<string, number>();
  constructor(private readonly db: DatabaseService, private readonly repo: QqRepository,
    private readonly api: QqApiService, private readonly sessions: SessionService,
    private readonly registry: PlatformRegistryService, private readonly analytics: AnalyticsService) {}

  private coverageBusy = false;
  private coverageCursor = 0;
  @Interval(60_000)
  async collectMemberCoverage() {
    if (this.coverageBusy || this.stopping || !this.api.configured) return;
    const spaces = this.db.listSpaces('qq').filter(s => s.status === 'active');
    if (!spaces.length) return;
    const space = spaces[this.coverageCursor++ % spaces.length];
    this.coverageBusy = true;
    try {
      const info = await this.api.request(`/v2/groups/${encodeURIComponent(space.externalId)}/info`);
      if (Number.isSafeInteger(info.group_member_num) && info.group_member_num >= 0) {
        this.analytics.upsertServerMemberCount(space.serverId, info.group_member_num);
      }
      if (typeof info.group_name === 'string' && info.group_name.trim()) this.db.updateServer(space.serverId, { guildName: info.group_name });
    } catch (e) {
      this.repo.setStatus('coverageError', { error: e instanceof QqApiError ? e.message : 'coverage_unavailable', at: Date.now() });
    } finally { this.coverageBusy = false; }
  }

  onModuleInit() { this.registry.register(this); }
  onModuleDestroy() { this.stopping = true; this.registry.unregister(this); }

  /** Keep only actionable commands. Ordinary conversations/attachments never enter storage. */
  accept(event: QqEvent) {
    const type = event.t || '';
    const d = event.d;
    if (event.op !== 0 || typeof d.group_openid !== 'string' || !d.group_openid) return;
    this.repo.setStatus('lastWebhookAt', Date.now());
    const group = d.group_openid;
    if (messageEvents.has(type)) {
      this.repo.observe(group, type);
      const command = qqCommand(d.content);
      if (!command || d.author?.bot || typeof d.id !== 'string' || typeof d.author?.member_openid !== 'string') return;
      const timestamp = Date.parse(d.timestamp);
      if (!Number.isFinite(timestamp) || Date.now() - timestamp > 5 * 60_000 || timestamp > Date.now() + 60_000) return;
      this.repo.enqueue({ op: 0, t: type, d: { id: d.id, group_openid: group, timestamp: d.timestamp,
        command, author: { member_openid: d.author.member_openid, member_role: d.author.member_role,
          username: typeof d.author.username === 'string' ? d.author.username.slice(0, 80) : '' } } },
      `msg:${qqHash(`${this.api.appId}:${group}:${d.id}`)}`);
    } else if (membershipEvents.has(type)) {
      const timestamp = Number(d.timestamp) * 1000;
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 60_000) return;
      this.repo.enqueue({ op: 0, t: type, id: event.id, d: { group_openid: group,
        timestamp: d.timestamp, op_member_openid: d.op_member_openid } },
      `event:${qqHash(`${this.api.appId}:${type}:${group}:${event.id || d.timestamp}`)}`);
    }
  }

  @Interval(1_000)
  async processEvents() {
    if (this.working || this.stopping || !this.api.configured) return;
    this.working = true;
    try {
      for (const row of this.repo.dueEvents()) {
        const event = JSON.parse(row.payload) as QqEvent;
        let role = event.d.author?.member_role || '';
        if (['manage', 'bind'].includes(event.d.command?.name) && !['member', 'admin', 'owner'].includes(role)) {
          try { role = await this.api.memberRole(event.d.group_openid, event.d.author.member_openid); }
          catch { role = ''; }
        }
        try { this.repo.processEvent(row.key, () => this.handle(event, row.key, role)); }
        catch (error) {
          this.repo.failEvent(row.key, 'command_failed');
          this.repo.setStatus('lastCommandError', { error: 'command_failed', at: Date.now() });
          this.logger.error(`QQ command failed: ${error instanceof Error ? error.name : 'unknown'}`);
        }
      }
    } finally { this.working = false; }
  }

  private domain() {
    const value = this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '');
    if (!/^https:\/\/[^/\s]+/.test(value)) throw new Error('QQ requires a public HTTPS domain');
    return value;
  }
  private response(event: QqEvent, key: string, text: string, link?: { label: string; url: string }) {
    const d = event.d;
    const body: Record<string, any> = { msg_type: 0, content: text, msg_seq: 1 };
    if (messageEvents.has(event.t || '')) body.msg_id = d.id;
    else if (event.id) body.event_id = event.id;
    if (link) {
      body.msg_type = 2; delete body.content;
      body.markdown = { content: `${text}\n\n[${link.label}](${link.url})` };
      body.keyboard = { content: { rows: [{ buttons: [{ id: 'open', render_data: { label: link.label, style: 1 },
        action: { type: 0, permission: { type: 2 }, data: link.url } }] }] } };
    }
    const timestamp = messageEvents.has(event.t || '') ? Date.parse(d.timestamp) : Number(d.timestamp) * 1000;
    this.repo.queue({ key: `${key}:reply`, group: d.group_openid, body, replyUntil: timestamp + 290_000 });
  }

  private handle(event: QqEvent, key: string, role: string) {
    const d = event.d;
    const group = d.group_openid;
    let space = this.db.getSpace('qq', group);
    if (event.t === 'GROUP_DEL_ROBOT') {
      if (!this.repo.membership(group, Number(d.timestamp) * 1000, false)) return;
      this.repo.revoke(group);
      if (space) this.record(space, 'bot_removed', 'bot_kicked');
      return;
    }
    if (event.t === 'GROUP_MSG_RECEIVE' || event.t === 'GROUP_MSG_REJECT') {
      this.repo.push(group, event.t === 'GROUP_MSG_RECEIVE');
      return;
    }
    if (event.t === 'GROUP_ADD_ROBOT') {
      if (!this.repo.membership(group, Number(d.timestamp) * 1000, true)) return;
      space = this.db.createSpace({ platform: 'qq', externalId: group, displayName: 'QQ群', ownerId: '' });
      this.record(space, 'bot_joined', 'bot_joined');
      this.response(event, key, '🐑 XgoatCast 已加入本群。请先在群内 @机器人，再发送指令：群主或管理员发送“管理”完成绑定，成员发送“屏幕共享”发起共享。');
      return;
    }
    // Messages cannot reactivate a removed bot; only a newer join event may do so.
    if (space?.status === 'kicked' || !this.repo.acceptsMessage(group, Date.parse(d.timestamp))) return;
    if (!space) {
      space = this.db.createSpace({ platform: 'qq', externalId: group, displayName: 'QQ群', ownerId: '' });
      this.record(space, 'bot_joined', 'bot_joined');
    }
    const command = d.command;
    const user = d.author.member_openid;
    if (command.name === 'manage' || command.name === 'bind') {
      if (!qqAdmin(role)) {
        this.response(event, key, role === 'member' ? '仅群主和管理员可绑定或调起管理入口。'
          : 'QQ 未提供可验证的群管理身份，暂时无法绑定。请群主或管理员 @机器人 后重试；仍失败请检查群成员信息权限。');
        return;
      }
      if (command.name === 'bind') {
        const ok = this.repo.authorize(group, command.code, user, role);
        this.response(event, key, ok ? '✅ 设备已授权，请回到刚才打开绑定页面的浏览器设置管理密码。'
          : '绑定码无效、已过期或已被使用，请先 @机器人，再发送“管理”重新获取绑定入口。');
        return;
      }
      const intent = !space.bound ? this.repo.intent(group) : undefined;
      const url = `${this.domain()}/spaces/qq/${encodeURIComponent(group)}${intent ? `?bind=${encodeURIComponent(intent)}` : ''}`;
      this.response(event, key, space.bound ? '本群已绑定 XgoatCast，打开管理面板后输入管理密码。'
        : '群主或管理员打开网页后，先在本群输入 @ 并选择本机器人，再粘贴页面上的绑定码发送，再回到原浏览器设置管理密码。',
      { label: space.bound ? '打开管理面板' : '打开绑定页面', url });
      return;
    }
    if (command.name === 'help') {
      this.response(event, key, '🐑 XgoatCast\n管理：群主或管理员绑定、配置本群。\n屏幕共享：发起网页共享，开始后群内发布观看入口。\n以上指令均需先在群内 @机器人，再发送。');
      return;
    }
    if (!space.bound) { this.response(event, key, '本群尚未绑定，请群主或管理员先 @机器人，再发送“管理”完成绑定。'); return; }
    if (!space.agoraAppId || !space.agoraAppCertificate) {
      this.response(event, key, '本群尚未配置声网，请管理员先 @机器人，再发送“管理”完成共享配置。'); return;
    }
    if (this.sessions.hasActiveSession(user, 'qq')) {
      this.response(event, key, '你已有一个未结束的屏幕共享，请先结束后再发起。'); return;
    }
    const session = this.sessions.createSession({ platform: 'qq', spaceId: space.serverId,
      externalSpaceId: group, externalChannelId: group, sharerUserId: user, sharerUsername: d.author.username || 'QQ用户' });
    this.repo.saveReply(session.id, d.id, Date.parse(d.timestamp) + 290_000);
    this.response(event, key, '🐑 屏幕共享已创建。请发起者打开下面的网页开始共享；开始后会发布观看入口。',
      { label: '开始屏幕共享', url: `${this.domain()}/share?t=${session.token}` });
    // Attach session ownership to the delivery so a terminal failure can cancel it.
    const sql = this.db.integrationDatabase;
    const row = sql.prepare('SELECT payload FROM qq_outbox WHERE key=?').get(`${key}:reply`) as any;
    if (row) { const job = JSON.parse(row.payload); job.sessionId = session.id; job.kind = 'create';
      sql.prepare('UPDATE qq_outbox SET payload=? WHERE key=?').run(JSON.stringify(job), `${key}:reply`); }
  }

  private record(space: ServerRecord, type: 'bot_joined' | 'bot_removed', databaseType: string) {
    const now = Date.now();
    this.db.addServerEvent(space.serverId, databaseType, '', '', type === 'bot_joined' ? 'QQ机器人加入群聊' : 'QQ机器人退出群聊');
    this.analytics.recordServerEvent({ eventKey: `qq:${type}:${space.externalId}:${now}`, serverSnowflakeId: space.serverId,
      serverName: space.guildName, eventType: type, occurredAt: now });
  }

  async onSessionStarted(event: SessionStartedEvent) {
    if (event.platform !== 'qq') return;
    this.lifecycle(event.sessionId, 'start');
  }
  async onSessionEnded(event: SessionEndedEvent) {
    if (event.platform !== 'qq') return;
    this.lifecycle(event.sessionId, 'end');
  }
  private lifecycle(sessionId: string, kind: 'start' | 'end') {
    const session = this.sessions.getById(sessionId);
    if (!session || session.platform !== 'qq' || (kind === 'end' && !session.startedAt)) return;
    const reply = this.repo.reply(sessionId);
    const info = this.sessions.toInfo(session);
    const text = kind === 'start' ? '🐑 屏幕共享已开始，点击下方链接观看。'
      : `🐑 屏幕共享已结束\n观看总人数：${session.totalViewerJoins || 0} 人\n共享时长：${Math.round((session.durationMs || 0) / 1000)} 秒\n标准时长：${info.standardMinutes} 分钟\n预估费用：¥${info.estimatedCost.toFixed(2)}\n先 @机器人，再发送“屏幕共享”可重新发起。`;
    const body: Record<string, any> = kind === 'start'
      ? { msg_type: 2, markdown: { content: `${text}\n\n[点击观看](${this.domain()}/view?t=${session.token})` } }
      : { msg_type: 0, content: text };
    if (reply) { body.msg_id = reply.message_id; body.msg_seq = kind === 'start' ? 2 : 3; }
    this.repo.queue({ key: `qq:${kind}:${sessionId}`, group: session.externalSpaceId, body,
      replyUntil: reply?.expires_at, sessionId, kind });
  }

  @Interval(2_500)
  async deliver() {
    if (this.sending || this.stopping || !this.api.configured) return;
    this.sending = true;
    try {
      for (const row of this.repo.dueDeliveries()) {
        const job = JSON.parse(row.payload) as QqDelivery;
        if (Date.now() - (this.lastGroupSend.get(job.group) || 0) < 3_100) continue;
        const space = this.db.getSpace('qq', job.group);
        if (!space || space.status !== 'active') { this.repo.finishDelivery(job.key, 'cancelled'); continue; }
        const session = job.sessionId ? this.sessions.getById(job.sessionId) : undefined;
        if ((job.kind === 'start' || job.kind === 'create') && (!session || session.status === 'ended')) {
          this.repo.finishDelivery(job.key, 'cancelled'); continue;
        }
        if ((job.body.msg_id || job.body.event_id) && (job.replyUntil || 0) <= Date.now()) {
          if (row.first_at || job.kind === 'create' || !job.kind) {
            this.failDelivery(job, 'reply_expired'); continue;
          }
          delete job.body.msg_id; delete job.body.event_id; delete job.body.msg_seq;
        }
        if (!job.body.msg_id && !job.body.event_id && !this.repo.canPush(job.group)) {
          this.failDelivery(job, 'group_push_disabled'); continue;
        }
        this.repo.beginDelivery(job);
        this.lastGroupSend.set(job.group, Date.now());
        try {
          const result = await this.api.request(`/v2/groups/${encodeURIComponent(job.group)}/messages`, 'POST', job.body);
          if (job.kind === 'start' && result.id) this.sessions.setPlatformMessageId(job.sessionId!, String(result.id));
          this.repo.finishDelivery(job.key);
        } catch (error) {
          const apiError = error instanceof QqApiError ? error : new QqApiError(0, 0, true);
          // A rejected Markdown format may fall back to plain text; never fallback
          // after a timeout because the original message might already be visible.
          if ([304036, 304037, 50056, 40034127, 40034124].includes(apiError.code) && job.body.markdown && !apiError.uncertain) {
            const content = job.body.markdown.content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1：$2');
            job.body = { ...job.body, msg_type: 0, content }; delete job.body.markdown; delete job.body.keyboard;
            this.repo.beginDelivery(job); this.repo.retryDelivery(job.key, 'markdown_unavailable');
          } else if (apiError.code === 40054005 && job.body.msg_id) {
            this.repo.finishDelivery(job.key); // Same msg_id + seq was already delivered.
          } else if (row.attempts < 4 && (apiError.status === 429 || apiError.status === 401
            || [40034100].includes(apiError.code)
            || (apiError.uncertain && job.body.msg_id && (job.replyUntil || 0) > Date.now() + 15_000))) {
            this.repo.retryDelivery(job.key, apiError.message);
          } else {
            this.failDelivery(job, apiError.message, apiError.uncertain ? 'uncertain' : 'failed');
            if ([40054010, 304003].includes(apiError.code) && job.body.msg_id && (job.replyUntil || 0) > Date.now()) {
              this.repo.queue({ key: `${job.key}:link-error`, group: job.group, replyUntil: job.replyUntil,
                body: { msg_type: 0, content: 'QQ暂不允许机器人发送本站链接，请联系服务管理员检查链接权限或域名配置后重试。',
                  msg_id: job.body.msg_id, msg_seq: job.body.msg_seq } });
            }
          }
        }
        break; // <=24 requests/min per bot; >=3.1 seconds between group sends.
      }
    } finally { this.sending = false; }
  }
  private failDelivery(job: QqDelivery, error: string, state = 'failed') {
    this.repo.finishDelivery(job.key, state, error);
    if (job.kind === 'create' && job.sessionId && state !== 'uncertain') this.sessions.cancelPendingSession(job.sessionId, 'qq_message_failed');
    this.repo.setStatus('lastDeliveryError', { error, state, at: Date.now() });
    this.logger.warn(`QQ delivery ${state}: ${error}`);
  }

  @Interval(60_000)
  cleanup() {
    this.repo.cleanup();
    for (const [group, at] of this.lastGroupSend) if (at < Date.now() - 60_000) this.lastGroupSend.delete(group);
  }
}
