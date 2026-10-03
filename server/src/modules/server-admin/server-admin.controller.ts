import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes } from 'crypto';
import { SESSION_CLOSE_SEC_MAX, SESSION_CLOSE_SEC_MIN, clampInt, sanitizeAllowedQualities } from '../session/session.types';

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
import { AnalyticsService } from '../analytics/analytics.service';
import {
  ServerAdminLoginDto,
  UpdateServerConfigDto,
  BindServerDto,
} from './server-admin.dto';

@Controller('api')
export class ServerAdminController {
  private readonly tokenTtlSec = 7 * 24 * 3600;
  private readonly heychatClaimCookie = 'xgoat_hc_bind_claim';

  constructor(
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
  ) {}

  private resolveSpace(params: Record<string, string>) {
    const platform = params.platform || 'kook';
    const externalId = params.externalId || params.serverId || '';
    const server = this.db.getSpace(platform, externalId);
    if (server?.platform === 'panel') throw new BadRequestException('请使用独立面板管理入口');
    return { platform, externalId, server };
  }

  // ===== Auth =====

  /** Bind server: set password for the first time (called from KOOK card button) */
  @Post(['server/:serverId/bind', 'spaces/:platform/:externalId/bind'])
  @HttpCode(HttpStatus.OK)
  bindServer(@Param() params: Record<string, string>, @Body() dto: BindServerDto) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (server.bound) return { ok: false, message: '服务器已绑定' };
    if (server.platform !== 'kook') {
      return { ok: false, message: '该平台必须使用设备验证码完成绑定' };
    }

    // 校验绑定 token（未绑定时必须提供有效 token）
    if (!dto.token || !this.db.validateBindToken(server.serverId, dto.token)) {
      return { ok: false, message: '绑定链接无效或已过期，请在 KOOK 服务器内重新发送 /xchelp 命令' };
    }

    const passwordHash = bcrypt.hashSync(dto.password, 10);
    this.db.updateServer(server.serverId, {
      passwordHash,
      bound: 1,
      reboundAt: Date.now(),
    });
    // 绑定成功后清空 token
    this.db.clearBindToken(server.serverId);
    const boundAt = Date.now();
    this.analytics.recordServerEvent({
      eventKey: `server_bound:${server.serverId}:${boundAt}`,
      serverSnowflakeId: server.serverId,
      serverName: server.guildName,
      eventType: 'bound',
      occurredAt: boundAt,
    });
    const current = this.db.getServer(server.serverId);
    if (current) this.recordAvailabilityTransitions(server, current, boundAt);
    return { ok: true, message: '绑定成功' };
  }

  /** Public metadata only. An intent locates a flow but never authorizes it. */
  @Get('spaces/heychat/:externalId/binding/:intentId/status')
  getHeychatBindingIntentStatus(
    @Param('externalId') roomId: string,
    @Param('intentId') intentId: string,
  ) {
    const intent = this.db.getHeychatBindingIntent(roomId, intentId);
    const space = this.db.getSpace('heychat', roomId);
    if (!intent || !space || space.serverId !== intent.spaceId) {
      return { ok: false, state: 'unavailable' };
    }
    if (space.status !== 'active' || !!space.bound || intent.state === 'revoked') {
      return { ok: false, state: 'unavailable' };
    }
    return {
      ok: intent.state !== 'expired',
      state: intent.state,
      expiresAt: intent.expiresAt,
      roomName: space.guildName,
    };
  }

  /** Create or resume this browser's independent claim for a public intent. */
  @Post('spaces/heychat/:externalId/binding/:intentId/claim')
  @HttpCode(HttpStatus.OK)
  claimHeychatBindingIntent(
    @Param('externalId') roomId: string,
    @Param('intentId') intentId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const credential = this.readHeychatClaimCookie(req);
    if (credential) {
      const existing = this.db.getHeychatBindingClaim(
        roomId,
        intentId,
        credential.claimId,
        credential.secretHash,
      );
      if (existing && existing.state !== 'expired' && existing.state !== 'revoked') {
        return {
          ok: true,
          state: existing.state,
          code: existing.code,
          expiresAt: existing.expiresAt,
        };
      }
    }

    const secret = randomBytes(32).toString('base64url');
    const claim = this.db.createHeychatBindingClaim(
      roomId,
      intentId,
      this.hashHeychatClaimSecret(secret),
    );
    if (!claim) return { ok: false, state: 'unavailable' };

    res.cookie(
      this.heychatClaimCookie,
      `${claim.claimId}.${secret}`,
      this.heychatClaimCookieOptions(roomId, intentId, claim.expiresAt),
    );
    return {
      ok: true,
      state: claim.state,
      code: claim.code,
      expiresAt: claim.expiresAt,
    };
  }

  /** Poll only the claim proven by this browser's HttpOnly cookie. */
  @Get('spaces/heychat/:externalId/binding/:intentId/poll')
  pollHeychatBindingClaim(
    @Param('externalId') roomId: string,
    @Param('intentId') intentId: string,
    @Req() req: Request,
  ) {
    const credential = this.readHeychatClaimCookie(req);
    if (!credential) return { ok: false, state: 'unavailable' };
    const claim = this.db.getHeychatBindingClaim(
      roomId,
      intentId,
      credential.claimId,
      credential.secretHash,
    );
    if (!claim) return { ok: false, state: 'unavailable' };
    return {
      ok: claim.state === 'pending' || claim.state === 'authorized',
      state: claim.state,
      expiresAt: claim.expiresAt,
    };
  }

  /** Atomically consume this browser's authorized claim and bind the room. */
  @Post('spaces/heychat/:externalId/binding/:intentId/bind')
  @HttpCode(HttpStatus.OK)
  bindHeychatClaim(
    @Param('externalId') roomId: string,
    @Param('intentId') intentId: string,
    @Body() dto: BindServerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const credential = this.readHeychatClaimCookie(req);
    if (!credential) return { ok: false, message: '设备授权无效或已过期' };
    const before = this.db.getSpace('heychat', roomId);
    if (!before || before.status !== 'active' || !!before.bound) {
      return { ok: false, message: '房间当前不可绑定' };
    }

    const passwordHash = bcrypt.hashSync(dto.password, 10);
    const current = this.db.consumeHeychatBindingClaim(
      roomId,
      intentId,
      credential.claimId,
      credential.secretHash,
      passwordHash,
    );
    if (!current) return { ok: false, message: '设备授权无效或已过期' };

    res.clearCookie(
      this.heychatClaimCookie,
      this.heychatClaimCookieOptions(roomId, intentId, Date.now()),
    );
    const boundAt = Date.now();
    this.analytics.recordServerEvent({
      eventKey: `server_bound:${current.serverId}:${boundAt}`,
      serverSnowflakeId: current.serverId,
      serverName: current.guildName,
      eventType: 'bound',
      occurredAt: boundAt,
    });
    this.recordAvailabilityTransitions(before, current, boundAt);
    return { ok: true, message: '绑定成功' };
  }

  /** Check if server is bound (for KOOK card flow) */
  @Get(['server/:serverId/status', 'spaces/:platform/:externalId/status'])
  getServerStatus(@Param() params: Record<string, string>, @Query('token') token?: string) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { exists: false };
    const result: any = {
      exists: true,
      platform,
      externalId,
      bound: !!server.bound,
      guildName: server.guildName,
      openId: server.openId,
    };
    // 未绑定时校验绑定 token
    if (!server.bound) {
      if (!token) {
        result.tokenValid = false;
      } else {
        result.tokenValid = this.db.validateBindToken(server.serverId, token);
      }
    }
    return result;
  }

  /** Login to server admin panel */
  @Post(['server/:serverId/login', 'spaces/:platform/:externalId/login'])
  @HttpCode(HttpStatus.OK)
  login(@Param() params: Record<string, string>, @Body() dto: ServerAdminLoginDto) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (!server.bound) return { ok: false, message: '服务器尚未绑定' };
    if (server.status !== 'active') return { ok: false, message: '机器人当前不在该平台空间' };

    if (!bcrypt.compareSync(dto.password, server.passwordHash)) {
      return { ok: false, message: '密码错误' };
    }

    const payload = {
      role: 'space_admin',
      spaceId: server.serverId,
      platform,
      externalId,
      exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // 使用每服务器独立的 HMAC 密钥签名
    const serverSecret = server.serverSecret || process.env.SUPER_ADMIN_PASSWORD!;
    const sig = createHmac('sha256', serverSecret).update(body).digest('base64url');
    return { ok: true, token: body + '.' + sig };
  }

  // ===== Server Config =====

  @Get(['server/:serverId/config', 'spaces/:platform/:externalId/config'])
  getConfig(@Param() params: Record<string, string>) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };

    return {
      spaceId: server.serverId,
      serverId: externalId,
      platform,
      externalId,
      guildName: server.guildName,
      agoraAppId: server.agoraAppId,
      agoraAppCertificate: server.agoraAppCertificate ? '******' : '',
      allowedQualities: sanitizeAllowedQualities(safeParse(server.allowedQualities)),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      enabledTriggerWords: server.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      idleTimeoutSec: server.idleTimeoutSec,
      noViewerTimeoutSec: server.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: server.allowLowLatency,
      allowQualityPreference: server.allowQualityPreference,
    };
  }

  @Put(['server/:serverId/config', 'spaces/:platform/:externalId/config'])
  updateConfig(@Param() params: Record<string, string>, @Body() dto: UpdateServerConfigDto) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    if (dto.agoraAppId !== undefined) updates.agoraAppId = dto.agoraAppId;
    if (dto.agoraAppCertificate !== undefined && dto.agoraAppCertificate !== '******') {
      updates.agoraAppCertificate = dto.agoraAppCertificate;
    }
    // 数值与画质不做拒绝式校验：钳制到合理边界、过滤无效 key。
    // 心跳间隔与声网令牌有效期由超管统一设置，这里忽略管理员提交的这两个字段。
    if (dto.idleTimeoutSec !== undefined) updates.idleTimeoutSec = clampInt(dto.idleTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, server.idleTimeoutSec);
    if (dto.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = clampInt(dto.noViewerTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, server.noViewerTimeoutSec);
    if (dto.allowedQualities !== undefined) {
      updates.allowedQualities = JSON.stringify(sanitizeAllowedQualities(dto.allowedQualities));
    }
    if (dto.enabledTriggerWords !== undefined) {
      const allowed = new Set(this.db.getGlobalConfig().triggerWordLabels);
      const enabled = [...new Set(dto.enabledTriggerWords.map(word => word.trim()).filter(word => allowed.has(word)))];
      if (enabled.length === 0) throw new BadRequestException('至少启用一个触发词标签');
      updates.triggerWords = enabled.join(',');
    }
    if (dto.allowQualityPreference !== undefined) updates.allowQualityPreference = dto.allowQualityPreference;
    if (dto.allowLowLatency !== undefined) updates.allowLowLatency = dto.allowLowLatency;

    this.db.updateServer(server.serverId, updates);
    const current = this.db.getServer(server.serverId);
    if (current) this.recordAvailabilityTransitions(server, current);
    return { ok: true };
  }

  @Post(['server/:serverId/presence', 'spaces/:platform/:externalId/presence'])
  presence(@Param() params: Record<string, string>, @Body() body: any) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false };
    const browserSessionId = String(body?.browserSessionId || '').slice(0, 100);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(browserSessionId)) {
      throw new BadRequestException('浏览器会话标识无效');
    }
    this.analytics.clientConnected('server_admin', browserSessionId, {
      deviceType: body?.deviceType,
      osName: body?.osName,
      browserName: body?.browserName,
      browserMajor: body?.browserMajor,
    });
    return { ok: true };
  }

  private recordAvailabilityTransitions(before: any, after: any, occurredAt = Date.now()): void {
    const beforeAgora = !!before.agoraAppId && !!before.agoraAppCertificate;
    const afterAgora = !!after.agoraAppId && !!after.agoraAppCertificate;
    const beforeReady = before.status === 'active' && !!before.bound && beforeAgora;
    const afterReady = after.status === 'active' && !!after.bound && afterAgora;
    if (beforeAgora !== afterAgora) {
      this.analytics.recordServerEvent({
        eventKey: `agora:${after.serverId}:${occurredAt}`,
        serverSnowflakeId: after.serverId,
        serverName: after.guildName,
        eventType: afterAgora ? 'agora_configured' : 'agora_unconfigured',
        occurredAt,
      });
    }
    if (beforeReady !== afterReady) {
      this.analytics.recordServerEvent({
        eventKey: `ready:${after.serverId}:${occurredAt}`,
        serverSnowflakeId: after.serverId,
        serverName: after.guildName,
        eventType: afterReady ? 'share_ready' : 'share_unready',
        occurredAt,
      });
    }
  }

  private readHeychatClaimCookie(req: Request): {
    claimId: string;
    secretHash: string;
  } | undefined {
    const values = String(req.headers.cookie || '')
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(`${this.heychatClaimCookie}=`));
    for (const entry of values) {
      let value = entry.slice(this.heychatClaimCookie.length + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        continue;
      }
      const separator = value.indexOf('.');
      if (separator <= 0) continue;
      const claimId = value.slice(0, separator);
      const secret = value.slice(separator + 1);
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(claimId) || !/^[A-Za-z0-9_-]{40,64}$/.test(secret)) {
        continue;
      }
      try {
        if (Buffer.from(secret, 'base64url').length !== 32) continue;
      } catch {
        continue;
      }
      return { claimId, secretHash: this.hashHeychatClaimSecret(secret) };
    }
    return undefined;
  }

  private hashHeychatClaimSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  private heychatClaimCookieOptions(roomId: string, intentId: string, expiresAt: number) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'strict' as const,
      path: `/api/spaces/heychat/${encodeURIComponent(roomId)}/binding/${encodeURIComponent(intentId)}`,
      expires: new Date(expiresAt),
    };
  }

  // ===== Sessions =====

  @Get(['server/:serverId/sessions', 'spaces/:platform/:externalId/sessions'])
  listSessions(@Param() params: Record<string, string>) {
    const { server } = this.resolveSpace(params);
    if (!server) return [];
    return this.db.getSessionsByServerFiltered(server.serverId, server.reboundAt);
  }
}
