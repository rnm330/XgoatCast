import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { SessionService } from '../session/session.service';
import { SESSION_CLOSE_SEC_MAX, SESSION_CLOSE_SEC_MIN, QUALITY_PRESETS, clampInt, sanitizeAllowedQualities } from '../session/session.types';
import { SuperAdminGuard } from '../analytics/super-admin.guard';
import { PanelAccessService } from './panel-access.service';
import { PanelRegistrationService } from './panel-registration.service';
import { VERIFICATION_EMAIL_TEMPLATE, verificationEmailHtml } from './email-template';

export const FRUIT_SHARER_NAMES = [
  '苹果', '香蕉', '橙子', '蜜桃', '草莓', '蓝莓', '葡萄', '西瓜',
  '哈密瓜', '菠萝', '芒果', '椰子', '樱桃', '柠檬', '青柠', '荔枝',
  '龙眼', '石榴', '猕猴桃', '火龙果', '百香果', '杨梅', '枇杷', '柚子',
  '梨子', '杏子', '李子', '无花果', '山竹', '木瓜', '桑葚', '橘子',
] as const;

export function defaultSharerName(index = randomInt(FRUIT_SHARER_NAMES.length)) {
  return FRUIT_SHARER_NAMES[index] ?? '苹果';
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

@Controller('api')
export class PanelsController {
  constructor(private readonly access: PanelAccessService, private readonly registration: PanelRegistrationService, private readonly db: DatabaseService, private readonly sessions: SessionService) {}

  @Get('panels/registration/availability')
  availability(@Req() req: Request, @Query('id') id: string) { return this.registration.availability(req, id); }
  @Get('panels/registration/status')
  registrationStatus() { return { mailReady: this.registration.mailReady() }; }
  @Get('panels/registration/captcha')
  captcha(@Req() req: Request, @Res({ passthrough: true }) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.registration.captcha(req); }
  @Post('panels/registration/email') @HttpCode(200)
  sendEmail(@Req() req: Request, @Body() body: any) { return this.registration.sendCode(req, body || {}); }
  @Post('panels/registration/create') @HttpCode(200)
  register(@Req() req: Request, @Body() body: any) { return this.registration.register(req, body || {}); }
  @Post('panels/registration/recover') @HttpCode(200)
  recover(@Req() req: Request, @Body() body: any) { return this.registration.recover(req, body || {}); }

  @Get('panels/:id/status')
  status(@Param('id') id: string, @Req() req: Request) {
    this.access.limit(`read:${this.access.ip(req)}`, 120);
    let p: ReturnType<PanelAccessService['panel']>;
    try { p = this.access.panel(id); } catch {
      return { exists: false, legacy: /^\d+$/.test(id) && !!this.db.getSpace('kook', id) };
    }
    if (p.space.status !== 'active') return { exists: true, disabled: true };
    return { exists: true, disabled: false, name: p.space.guildName, locked: !!p.account.access_hash };
  }
  @Post('panels/:id/unlock') @HttpCode(200)
  async unlock(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    this.access.limit(`unlock:${this.access.ip(req)}`, 10);
    const { account, space } = this.access.panel(id);
    this.access.active(space);
    if (account.access_hash && !await this.access.compareAccessCode(body?.code, account.access_hash)) throw new ForbiddenException('授权码错误');
    // Recheck after expensive async comparison so a concurrent change cannot grant the new epoch.
    const current = this.access.panel(id);
    this.access.active(current.space);
    if (current.account.access_version !== account.access_version || current.space.serverSecret !== space.serverSecret) throw new ForbiddenException('授权码已变更，请重试');
    this.access.setCookie(res, req, `panel_gate_${account.id}`, this.access.sign(space, 'gate', account.access_version), `/api/panels/${account.id}`);
    return { ok: true };
  }
  @Get('panels/:id/rooms')
  rooms(@Param('id') id: string, @Req() req: Request, @Query('cursor') cursor?: string) {
    this.access.limit(`list:${this.access.ip(req)}`, 60);
    const { space } = this.access.gate(req, id);
    let before: { createdAt: number; id: string } | undefined;
    if (cursor) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 256) throw Error();
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!before || !Number.isSafeInteger(before.createdAt) || before.createdAt < 0 || typeof before.id !== 'string' || before.id.length > 100) throw Error();
      } catch { throw new BadRequestException('房间列表游标无效，请刷新'); }
    }
    const rows = this.access.sql.prepare(`SELECT s.id, s.created_at, r.title, r.view_token, r.password_hash != '' AS locked, s.viewer_count AS viewers
      FROM sessions s JOIN panel_rooms r ON r.session_id = s.id
      WHERE s.server_id = ? AND s.status IN ('active', 'grace')
      ${before ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : ''}
      ORDER BY s.created_at DESC, s.id DESC LIMIT 51`).all(space.serverId, ...(before ? [before.createdAt, before.createdAt, before.id] : [])) as any[];
    const visible = rows.slice(0, 50), last = visible[visible.length - 1];
    return { name: space.guildName, ready: !!space.agoraAppId && !!space.agoraAppCertificate, defaultName: defaultSharerName(), hasMore: rows.length > 50,
      nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null,
      rooms: visible.map(r => ({ title: r.title, viewers: r.viewers, locked: !!r.locked, viewLink: `/view?t=${r.view_token}` })) };
  }
  @Post('panels/:id/rooms') @HttpCode(200)
  async createRoom(@Param('id') id: string, @Req() req: Request, @Body() body: any) {
    const { account, space } = this.access.gate(req, id);
    this.access.limit(`create:${this.access.ip(req)}`, 1, 5000);
    this.access.limit(`create:panel:${account.id}`, 30);
    if (!space.agoraAppId || !space.agoraAppCertificate) throw new BadRequestException('面板管理员尚未配置声网凭证');
    const title = this.access.text(body?.title || defaultSharerName(), '共享人', 1, 80).trim();
    if (!title) throw new BadRequestException('共享人不能为空');
    const password = this.access.text(body?.password ?? '', '房间密码', 0, 72);
    if (Buffer.byteLength(password) > 72) throw new BadRequestException('房间密码不能超过 72 字节');
    const hash = password ? await this.access.hash(password) : '';
    this.access.gate(req, id);
    const session = this.sessions.createSession({ platform: 'panel', spaceId: space.serverId, externalSpaceId: account.id, externalChannelId: '', sharerUserId: randomUUID(), sharerUsername: title, manualCreated: true });
    try {
      this.access.sql.prepare('INSERT INTO panel_rooms(session_id, panel_id, view_token, password_hash, title) VALUES (?, ?, ?, ?, ?)').run(session.id, account.id, 'v_' + randomBytes(32).toString('hex'), hash, title);
    } catch (e) { this.sessions.cancelPendingSession(session.id); throw e; }
    return { ok: true, shareLink: `/share?t=${session.token}` };
  }

  @Post('panels/:id/admin/login') @HttpCode(200)
  async login(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    this.access.limit(`panel-login:${this.access.ip(req)}`, 10);
    const { account, space } = this.access.panel(id);
    if (!await this.access.compare(body?.password, space.passwordHash)) throw new UnauthorizedException('管理密码错误');
    if (this.access.panel(id).space.serverSecret !== space.serverSecret) throw new UnauthorizedException('管理密码已变更');
    this.access.setCookie(res, req, `panel_admin_${account.id}`, this.access.sign(space, 'admin'), `/api/panels/${account.id}`);
    return { ok: true };
  }
  @Post('panels/:id/admin/logout') @HttpCode(200)
  logout(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.access.setCookie(res, req, `panel_admin_${id.toLowerCase()}`, '', `/api/panels/${id.toLowerCase()}`, 0);
    return { ok: true };
  }
  @Get('panels/:id/admin/config')
  config(@Param('id') id: string, @Req() req: Request) {
    const { account, space } = this.access.admin(req, id);
    return { id: account.id, email: account.email, name: space.guildName, disabled: space.status !== 'active', agoraAppId: space.agoraAppId, certificateConfigured: !!space.agoraAppCertificate, accessEnabled: !!account.access_hash,
      allowedQualities: sanitizeAllowedQualities(safeParse(space.allowedQualities)), qualityOptions: QUALITY_PRESETS.map(q => ({ key: q.key, label: q.label })), idleTimeoutSec: space.idleTimeoutSec, noViewerTimeoutSec: space.noViewerTimeoutSec, allowLowLatency: !!space.allowLowLatency, allowQualityPreference: !!space.allowQualityPreference };
  }
  @Put('panels/:id/admin/config')
  async update(@Param('id') id: string, @Req() req: Request, @Body() body: any) {
    const { account, space } = this.access.admin(req, id);
    this.access.active(space);
    this.access.limit(`settings:${this.access.ip(req)}`, 10);
    const updates: any = {};
    if (body?.name !== undefined) updates.guildName = this.access.text(body.name, '面板名称', 1, 60).trim();
    if (updates.guildName === '') throw new BadRequestException('面板名称不能为空');
    for (const key of ['agoraAppId', 'agoraAppCertificate']) {
      if (body?.[key] !== undefined) {
        const value = this.access.text(body[key], '声网凭证', 0, 32).trim();
        if (value && !/^[a-fA-F0-9]{32}$/.test(value)) throw new BadRequestException('声网凭证应为 32 位十六进制字符');
        updates[key] = value;
      }
    }
    // 数值与画质不做拒绝式校验：钳制到合理边界、过滤无效 key。
    // 心跳间隔与声网令牌有效期由超管统一设置，面板管理员提交的这两个字段直接忽略。
    if (body?.idleTimeoutSec !== undefined) updates.idleTimeoutSec = clampInt(body.idleTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, space.idleTimeoutSec);
    if (body?.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = clampInt(body.noViewerTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, space.noViewerTimeoutSec);
    for (const key of ['allowLowLatency', 'allowQualityPreference']) if (body?.[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new BadRequestException('开关参数无效');
      updates[key] = body[key] ? 1 : 0;
    }
    if (body?.allowedQualities !== undefined) {
      updates.allowedQualities = JSON.stringify(sanitizeAllowedQualities(body.allowedQualities));
    }
    let accessHash: string | undefined;
    if (body?.accessEnabled !== undefined && typeof body.accessEnabled !== 'boolean') throw new BadRequestException('授权码开关无效');
    if (body?.accessEnabled === false) accessHash = '';
    else if (body?.accessEnabled === true) {
      if (body.accessCode) accessHash = await this.access.hashAccessCode(body.accessCode);
      else if (!account.access_hash) throw new BadRequestException('开启时请设置授权码');
    }
    this.access.admin(req, id); this.access.active(this.access.panel(id).space);
    this.access.sql.transaction(() => {
      this.db.updateServer(space.serverId, updates);
      if (accessHash !== undefined) this.access.sql.prepare('UPDATE panel_accounts SET access_hash = ?, access_version = access_version + 1 WHERE id = ?').run(accessHash, account.id);
    })();
    return { ok: true };
  }
  @Post('panels/:id/admin/password') @HttpCode(200)
  async changePassword(@Param('id') id: string, @Req() req: Request, @Body() body: any) {
    this.access.limit(`password:${this.access.ip(req)}`, 5);
    const { space } = this.access.admin(req, id);
    const password = this.access.password(body?.password);
    this.access.confirmPassword(password, body?.confirmPassword);
    if (!await this.access.compare(body?.oldPassword, space.passwordHash)) throw new ForbiddenException('原管理密码错误');
    const hash = await this.access.hash(password);
    this.access.admin(req, id);
    this.db.updateServer(space.serverId, { passwordHash: hash });
    this.access.rotateSecret(space.serverId);
    return { ok: true };
  }
  @Get('panels/:id/admin/rooms')
  history(@Param('id') id: string, @Req() req: Request, @Query('page') pageValue?: string) {
    const { space } = this.access.admin(req, id);
    const page = Math.max(1, Math.min(100000, Number(pageValue) || 1)) | 0;
    const rows = this.access.sql.prepare(`SELECT r.session_id AS id, r.title, s.status, s.viewer_count AS viewers, s.created_at AS createdAt, s.duration_ms AS durationMs, s.peak_viewers AS peakViewers
      FROM sessions s JOIN panel_rooms r ON r.session_id = s.id WHERE s.server_id = ? ORDER BY s.created_at DESC LIMIT 51 OFFSET ?`).all(space.serverId, (page - 1) * 50);
    return { rooms: rows.slice(0, 50), hasMore: rows.length > 50 };
  }
  @Post('panels/:id/admin/rooms/:roomId/end') @HttpCode(200)
  end(@Param('id') id: string, @Param('roomId') roomId: string, @Req() req: Request) {
    const { account } = this.access.admin(req, id);
    if (this.access.roomBySession(roomId)?.panel_id !== account.id) throw new ForbiddenException('房间不属于此面板');
    this.sessions.endSession(roomId, 'panel_admin');
    return { ok: true };
  }

  @Get('share/room-access')
  roomAccess(@Query('t') token: string, @Req() req: Request) {
    if (typeof token !== 'string' || !token.startsWith('v_')) return { required: false };
    const room = this.access.roomByToken(token);
    if (!room) throw new BadRequestException('房间不存在');
    this.access.active(this.access.panel(room.panel_id).space);
    const session = this.db.getSessionById(room.session_id);
    if (!session || session.status === 'ended') throw new BadRequestException('共享已结束');
    try { this.access.viewer(req, room); return { required: false }; } catch { return { required: true }; }
  }
  @Post('share/room-access') @HttpCode(200)
  async unlockRoom(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    this.access.limit(`room-password:${this.access.ip(req)}`, 10);
    const token = this.access.text(body?.token, '观看凭证', 1, 100);
    const room = this.access.roomByToken(token);
    if (!room) throw new BadRequestException('房间不存在');
    const { space } = this.access.panel(room.panel_id);
    this.access.active(space);
    if (room.password_hash && !await this.access.compare(body?.password, room.password_hash)) throw new ForbiddenException('房间密码错误');
    this.access.active(this.access.panel(room.panel_id).space);
    this.access.setCookie(res, req, `panel_room_${room.session_id}`, this.access.sign(space, `room:${room.session_id}`), '/api/share');
    return { ok: true };
  }

  @Get('super/panels') @UseGuards(SuperAdminGuard)
  superList(@Query('page') pageValue?: string) {
    const page = Math.max(1, Math.min(100000, Number(pageValue) || 1)) | 0;
    // Explicit allowlist: no room data, credentials or access hashes.
    const rows = this.access.sql.prepare(`SELECT p.id, p.email, s.guild_name AS name, s.status, s.created_at AS createdAt
      FROM panel_accounts p JOIN servers s ON s.server_id=p.space_id ORDER BY s.created_at DESC LIMIT 51 OFFSET ?`).all((page - 1) * 50);
    return { panels: rows.slice(0, 50), hasMore: rows.length > 50 };
  }
  @Get('super/mail-settings') @UseGuards(SuperAdminGuard)
  mailSettings() { return this.registration.mailSettings(); }
  @Get('super/mail-settings/template') @UseGuards(SuperAdminGuard)
  mailTemplate() { return { html: VERIFICATION_EMAIL_TEMPLATE, preview: verificationEmailHtml('286419') }; }
  @Put('super/mail-settings') @UseGuards(SuperAdminGuard)
  saveMailSettings(@Body() body: any) { return this.registration.saveMailSettings(body || {}); }
  @Post('super/mail-settings/test') @UseGuards(SuperAdminGuard)
  testMail(@Req() req: Request, @Body() body: any) { return this.registration.testMail(req, body || {}); }
  @Put('super/panels/:id/status') @UseGuards(SuperAdminGuard)
  superStatus(@Param('id') id: string, @Body() body: any) {
    if (typeof body?.disabled !== 'boolean') throw new BadRequestException('停用状态无效');
    const { space } = this.access.panel(id);
    this.db.updateServer(space.serverId, { status: body.disabled ? 'disabled' : 'active' });
    if (body.disabled) {
      // Invalidate gate grants on suspension, retain admin login so status remains accessible.
      this.access.sql.prepare('UPDATE panel_accounts SET access_version=access_version+1 WHERE space_id=?').run(space.serverId);
      const active = this.access.sql.prepare("SELECT id FROM sessions WHERE server_id = ? AND status != 'ended'").all(space.serverId) as any[];
      for (const s of active) this.sessions.endSession(s.id, 'panel_disabled');
    }
    return { ok: true };
  }
}
