import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { QqApiError, QqApiService } from './qq-api.service';
import { QqRepository, qqHash } from './qq.repository';
import { QqService } from './qq.service';
import { qqChallenge, QqEvent, verifyQqSignature } from './qq-protocol';
import { DatabaseService } from '../database/database.service';
import { BindServerDto } from '../server-admin/server-admin.dto';
import { AnalyticsService } from '../analytics/analytics.service';

@Controller('api/integrations/qq')
export class QqWebhookController {
  constructor(private readonly api: QqApiService, private readonly service: QqService, private readonly repo: QqRepository) {}
  @Post('webhook')
  @HttpCode(200)
  receive(@Req() req: Request) {
    if (!this.api.configured) throw new HttpException('qq_not_configured', 503);
    if (req.header('x-bot-appid') !== this.api.appId) throw new HttpException('wrong_app', 401);
    if (!Buffer.isBuffer(req.body)) throw new HttpException('raw_body_required', 400);
    if (!verifyQqSignature(this.api.secret, req.body, req.header('x-signature-timestamp') || '', req.header('x-signature-ed25519') || '')) {
      throw new HttpException('invalid_signature', 401);
    }
    let event: QqEvent;
    try { event = JSON.parse(req.body.toString('utf8')); }
    catch { throw new HttpException('invalid_json', 400); }
    if (!event || !event.d || typeof event.d !== 'object' || Array.isArray(event.d)) throw new HttpException('invalid_event', 400);
    // Verify the handshake too: otherwise this endpoint would be a signing oracle.
    if (event.op === 13) {
      try {
        const result = qqChallenge(this.api.secret, event.d);
        if (Math.abs(Date.now() - Number(event.d.event_ts) * 1000) > 5 * 60_000) throw new Error('expired');
        this.repo.setStatus('lastChallengeAt', Date.now());
        return result;
      } catch { throw new HttpException('invalid_challenge', 400); }
    }
    if (event.d.application_id && String(event.d.application_id) !== this.api.appId) throw new HttpException('wrong_app', 401);
    this.service.accept(event);
    return { op: 12 }; // Acknowledge persistence promptly; the worker handles the command.
  }
}

@Controller('api/spaces/qq/:externalId/binding/:intentId')
export class QqBindingController {
  private readonly cookie = 'xgoat_qq_bind_claim';
  constructor(private readonly repo: QqRepository, private readonly db: DatabaseService, private readonly analytics: AnalyticsService) {}
  private credential(req: Request) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [name, raw] = part.trim().split('=');
      if (name !== this.cookie || !raw) continue;
      let value: string;
      try { value = decodeURIComponent(raw); } catch { continue; }
      const match = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (match) return { id: match[1], hash: qqHash(match[2]) };
    }
  }
  private options(group: string, intent: string, expires: number) {
    return { httpOnly: true, secure: true, sameSite: 'strict' as const,
      path: `/api/spaces/qq/${encodeURIComponent(group)}/binding/${encodeURIComponent(intent)}`, expires: new Date(expires) };
  }
  @Get('status')
  status(@Param('externalId') group: string, @Param('intentId') intent: string) {
    const row = this.repo.getIntent(group, intent);
    return row ? { ok: true, state: 'active', expiresAt: row.expires_at, roomName: row.guild_name } : { ok: false, state: 'unavailable' };
  }
  @Post('claim')
  @HttpCode(200)
  claim(@Param('externalId') group: string, @Param('intentId') intent: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const credential = this.credential(req);
    const existing = credential && this.repo.getClaim(group, intent, credential.id, credential.hash);
    if (existing && ['pending', 'authorized'].includes(existing.state)) {
      return { ok: true, state: existing.state, code: existing.code, expiresAt: existing.expires_at };
    }
    const secret = randomBytes(32).toString('base64url');
    const claim = this.repo.claim(group, intent, qqHash(secret));
    if (!claim) return { ok: false, state: 'unavailable' };
    res.cookie(this.cookie, `${claim.id}.${secret}`, this.options(group, intent, claim.expires_at));
    return { ok: true, state: claim.state, code: claim.code, expiresAt: claim.expires_at };
  }
  @Get('poll')
  poll(@Param('externalId') group: string, @Param('intentId') intent: string, @Req() req: Request) {
    const credential = this.credential(req);
    const row = credential && this.repo.getClaim(group, intent, credential.id, credential.hash);
    return row ? { ok: ['pending', 'authorized'].includes(row.state), state: row.state, expiresAt: row.expires_at } : { ok: false, state: 'unavailable' };
  }
  @Post('bind')
  @HttpCode(200)
  bind(@Param('externalId') group: string, @Param('intentId') intent: string, @Body() dto: BindServerDto,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const credential = this.credential(req);
    const row = credential && this.repo.getClaim(group, intent, credential.id, credential.hash);
    if (!credential || row?.state !== 'authorized') return { ok: false, message: '设备授权无效或已过期' };
    const ok = this.repo.consume(group, intent, credential.id, credential.hash, bcrypt.hashSync(dto.password, 10));
    if (!ok) return { ok: false, message: '设备授权无效或已过期' };
    res.clearCookie(this.cookie, this.options(group, intent, Date.now()));
    const space = this.db.getSpace('qq', group)!;
    this.analytics.recordServerEvent({ eventKey: `server_bound:${space.serverId}:${space.reboundAt}`,
      serverSnowflakeId: space.serverId, serverName: space.guildName, eventType: 'bound', occurredAt: space.reboundAt });
    return { ok: true, message: '绑定成功' };
  }
}

@Controller('api/super/qq')
export class QqStatusController {
  constructor(private readonly api: QqApiService, private readonly repo: QqRepository, private readonly db: DatabaseService) {}
  @Get('status')
  status() {
    return { mode: 'webhook', configured: this.api.configured, appId: this.api.appId,
      callbackUrl: `${this.db.getGlobalConfig().publicDomain.replace(/\/+$/, '')}/api/integrations/qq/webhook`,
      ...this.repo.status(), commands: ['管理', '屏幕共享', '帮助'] };
  }
  @Post('panel')
  async panel() {
    try {
      const result = await this.api.syncPanel();
      this.repo.setStatus('panel', { ...result, at: Date.now() });
      return { ok: true, ...result };
    } catch (e) { throw new HttpException(e instanceof QqApiError ? e.message : 'QQ面板同步失败', 502); }
  }
  @Post('verify')
  async verify() {
    try {
      const bot = await this.api.request('/users/@me');
      this.repo.setStatus('bot', { name: bot.username, id: bot.id, verifiedAt: Date.now() });
      return { ok: true, name: bot.username, id: bot.id };
    } catch (e) { throw new HttpException(e instanceof QqApiError ? e.message : 'QQ连接验证失败', 502); }
  }
}
