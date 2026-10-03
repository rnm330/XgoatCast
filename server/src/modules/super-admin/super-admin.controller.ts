import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import {
  SuperAdminLoginDto,
  UpdateGlobalConfigDto,
  UpdateServerDto,
} from './super-admin.dto';
import {
  getVideoCoefficient,
  QUALITY_PRESETS,
  SESSION_CLOSE_SEC_MAX,
  SESSION_CLOSE_SEC_MIN,
  STANDARD_MINUTE_PRICE,
  clampInt,
  sanitizeAllowedQualities,
  type QualityBitrateConfig,
} from '../session/session.types';
import { AnalyticsService } from '../analytics/analytics.service';

/** 用户 ID 脱敏：保留首 3 位和末 4 位 */
function maskUserId(uid: string): string {
  if (!uid || uid.length <= 7) return uid;
  return uid.slice(0, 3) + '****' + uid.slice(-4);
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

@Controller('api/super')
export class SuperAdminController {
  private superPasswordHash: string;
  private readonly tokenSecret: string;
  private readonly tokenTtlSec = 7 * 24 * 3600;

  constructor(
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
  ) {
    const pwd = process.env.SUPER_ADMIN_PASSWORD!;
    this.superPasswordHash = bcrypt.hashSync(pwd, 10);
    this.tokenSecret = pwd;
  }

  private getNonPanelServer(id: string) {
    const server = this.db.getServer(id);
    if (server?.platform === 'panel' || id.startsWith('panel:')) throw new BadRequestException('自建面板仅支持查看基本信息和停用');
    return server;
  }
  private getNonPanelSpace(platform: string, externalId: string) {
    if (platform === 'panel') throw new BadRequestException('自建面板仅支持查看基本信息和停用');
    return this.db.getSpace(platform, externalId);
  }

  // ===== Auth =====

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: SuperAdminLoginDto) {
    if (!bcrypt.compareSync(dto.password, this.superPasswordHash)) {
      return { ok: false, message: '密码错误' };
    }
    const payload = { role: 'super_admin', exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.tokenSecret).update(body).digest('base64url');
    return { ok: true, token: body + '.' + sig };
  }

  // ===== Global Config =====

  @Get('config')
  getConfig() {
    const cfg = this.db.getGlobalConfig();
    return {
      kookBotToken: cfg.kookBotToken ? '******' : '',
      kookVerifyToken: cfg.kookVerifyToken ? '******' : '',
      kookEncryptKey: cfg.kookEncryptKey ? '******' : '',
      heychatBotId: cfg.heychatBotId,
      heychatBotToken: cfg.heychatBotToken ? '******' : '',
      publicDomain: cfg.publicDomain,
      triggerWordLabels: cfg.triggerWordLabels,
      qualityBitrates: cfg.qualityBitrates,
      qualityProfiles: QUALITY_PRESETS.map((quality) => ({
        key: quality.key,
        label: quality.label,
        width: quality.width,
        height: quality.height,
        frameRate: quality.frameRate,
        interactiveViewerHourlyRate:
          getVideoCoefficient(quality.tier, true) * STANDARD_MINUTE_PRICE * 60,
        liveViewerHourlyRate:
          getVideoCoefficient(quality.tier, false) * STANDARD_MINUTE_PRICE * 60,
      })),
      broadcasterHourlyRate: STANDARD_MINUTE_PRICE * 60,
    };
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateGlobalConfigDto) {
    if (dto.kookBotToken !== undefined && dto.kookBotToken !== '******') {
      this.db.setGlobalConfig('kookBotToken', dto.kookBotToken);
    }
    if (dto.kookVerifyToken !== undefined && dto.kookVerifyToken !== '******') {
      this.db.setGlobalConfig('kookVerifyToken', dto.kookVerifyToken);
    }
    if (dto.kookEncryptKey !== undefined && dto.kookEncryptKey !== '******') {
      this.db.setGlobalConfig('kookEncryptKey', dto.kookEncryptKey);
    }
    if (dto.heychatBotId !== undefined) {
      this.db.setGlobalConfig('heychatBotId', dto.heychatBotId.trim());
    }
    if (dto.heychatBotToken !== undefined && dto.heychatBotToken !== '******') {
      this.db.setGlobalConfig('heychatBotToken', dto.heychatBotToken);
    }
    if (dto.publicDomain !== undefined) {
      this.db.setGlobalConfig('publicDomain', dto.publicDomain);
    }
    if (dto.qualityBitrates !== undefined) {
      const sanitized = this.sanitizeQualityBitrates(dto.qualityBitrates);
      this.db.setGlobalConfig('qualityBitrates', JSON.stringify(sanitized));
    }
    if (dto.triggerWordLabels !== undefined) {
      const labels = [...new Set(dto.triggerWordLabels.map(word => word.trim()).filter(Boolean))];
      if (labels.length === 0) throw new BadRequestException('至少保留一个触发词标签');
      this.db.setTriggerWordLabels(labels);
    }
    return { ok: true };
  }

  private sanitizeQualityBitrates(input: QualityBitrateConfig): QualityBitrateConfig {
    const result: QualityBitrateConfig = {};
    for (const quality of QUALITY_PRESETS) {
      const value = input[quality.key] || {};
      const bitrateMin = value.bitrateMin;
      const bitrateMax = value.bitrateMax;
      for (const [name, bitrate] of Object.entries({ bitrateMin, bitrateMax })) {
        if (bitrate !== undefined && (!Number.isFinite(bitrate) || bitrate <= 0)) {
          throw new BadRequestException(`${quality.label} 的 ${name} 必须为正数或留空`);
        }
      }
      if (bitrateMin !== undefined && bitrateMax !== undefined && bitrateMax < bitrateMin) {
        throw new BadRequestException(`${quality.label} 的最高码率不能低于最低码率`);
      }
      result[quality.key] = {
        ...(bitrateMin !== undefined ? { bitrateMin } : {}),
        ...(bitrateMax !== undefined ? { bitrateMax } : {}),
      };
    }
    return result;
  }

  // ===== Server Management =====

  @Get('spaces')
  listSpaces(@Query('platform') platform?: string) {
    return this.db.listSpaces(platform || undefined).filter(s => s.platform !== 'panel').map((s) => ({
      spaceId: s.serverId,
      platform: s.platform,
      externalId: s.externalId,
      serverId: s.externalId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId ? '******' : '',
      createdAt: s.createdAt,
    }));
  }

  @Get('spaces/:platform/:externalId')
  getSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const s = this.getNonPanelSpace(platform, externalId);
    if (!s) return { ok: false, message: '平台空间不存在' };
    return {
      spaceId: s.serverId,
      platform: s.platform,
      externalId: s.externalId,
      serverId: s.externalId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId,
      agoraAppCertificate: s.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: s.agoraTokenExpireSec,
      allowedQualities: sanitizeAllowedQualities(safeParse(s.allowedQualities)),
      enabledTriggerWords: s.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      idleTimeoutSec: s.idleTimeoutSec,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      noViewerTimeoutSec: s.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: s.allowLowLatency,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  @Get('spaces/:platform/:externalId/events')
  getSpaceEvents(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.getNonPanelSpace(platform, externalId);
    return space ? this.db.getServerEvents(space.serverId) : [];
  }

  @Get('spaces/:platform/:externalId/sessions')
  getSpaceSessions(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.getNonPanelSpace(platform, externalId);
    if (!space) return [];
    return this.db.getSessionsByServer(space.serverId).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Put('spaces/:platform/:externalId')
  updateSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
    @Body() dto: UpdateServerDto,
  ) {
    const space = this.getNonPanelSpace(platform, externalId);
    if (!space) return { ok: false, message: '平台空间不存在' };
    return this.updateServer(space.serverId, dto);
  }

  @Delete('spaces/:platform/:externalId')
  deleteSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.getNonPanelSpace(platform, externalId);
    if (!space) return { ok: false, message: '平台空间不存在' };
    this.analytics.finalizeServerDeletion(space.serverId, space.guildName);
    this.db.deleteServer(space.serverId);
    return { ok: true };
  }

  @Get('servers')
  listServers() {
    const servers = this.db.listServers().filter(s => s.platform !== 'panel');
    return servers.map((s) => ({
      serverId: s.serverId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId ? '******' : '',
      createdAt: s.createdAt,
    }));
  }

  @Get('servers/:id')
  getServer(@Param('id') id: string) {
    const s = this.getNonPanelServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };
    return {
      serverId: s.serverId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId,
      agoraAppCertificate: s.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: s.agoraTokenExpireSec,
      allowedQualities: sanitizeAllowedQualities(safeParse(s.allowedQualities)),
      enabledTriggerWords: s.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      idleTimeoutSec: s.idleTimeoutSec,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      noViewerTimeoutSec: s.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: s.allowLowLatency,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  @Get('servers/:id/events')
  getServerEvents(@Param('id') id: string) {
    this.getNonPanelServer(id);
    return this.db.getServerEvents(id);
  }

  @Get('servers/:id/sessions')
  getServerSessions(@Param('id') id: string) {
    this.getNonPanelServer(id);
    return this.db.getSessionsByServer(id).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Put('servers/:id')
  updateServer(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    const s = this.getNonPanelServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    if (dto.agoraAppId !== undefined) updates.agoraAppId = dto.agoraAppId;
    if (dto.agoraAppCertificate !== undefined && dto.agoraAppCertificate !== '******') {
      updates.agoraAppCertificate = dto.agoraAppCertificate;
    }
    // 超管可设置心跳间隔与声网令牌有效期；数值与画质一律钳制/过滤，不做拒绝式校验。
    if (dto.agoraTokenExpireSec !== undefined) updates.agoraTokenExpireSec = clampInt(dto.agoraTokenExpireSec, 60, 86400, s.agoraTokenExpireSec);
    if (dto.idleTimeoutSec !== undefined) updates.idleTimeoutSec = clampInt(dto.idleTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, s.idleTimeoutSec);
    if (dto.heartbeatIntervalSec !== undefined) updates.heartbeatIntervalSec = clampInt(dto.heartbeatIntervalSec, 2, 60, s.heartbeatIntervalSec);
    if (dto.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = clampInt(dto.noViewerTimeoutSec, SESSION_CLOSE_SEC_MIN, SESSION_CLOSE_SEC_MAX, s.noViewerTimeoutSec);
    if (dto.allowedQualities !== undefined) {
      updates.allowedQualities = JSON.stringify(sanitizeAllowedQualities(dto.allowedQualities));
    }
    if (dto.enabledTriggerWords !== undefined) {
      const allowed = new Set(this.db.getGlobalConfig().triggerWordLabels);
      const enabled = [...new Set(dto.enabledTriggerWords.map(word => word.trim()).filter(word => allowed.has(word)))];
      if (enabled.length === 0) throw new BadRequestException('至少启用一个触发词标签');
      updates.triggerWords = enabled.join(',');
    }
    if (dto.allowLowLatency !== undefined) updates.allowLowLatency = dto.allowLowLatency;

    this.db.updateServer(id, updates);
    const current = this.getNonPanelServer(id);
    if (current) this.recordAvailabilityTransitions(s, current);
    return { ok: true };
  }

  @Delete('servers/:id')
  deleteServer(@Param('id') id: string) {
    const s = this.getNonPanelServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };
    this.analytics.finalizeServerDeletion(s.serverId, s.guildName);
    this.db.deleteServer(id);
    return { ok: true };
  }

  private recordAvailabilityTransitions(before: any, after: any): void {
    const occurredAt = Date.now();
    const beforeAgora = !!before.agoraAppId && !!before.agoraAppCertificate;
    const afterAgora = !!after.agoraAppId && !!after.agoraAppCertificate;
    const beforeReady = before.status === 'active' && !!before.bound && beforeAgora;
    const afterReady = after.status === 'active' && !!after.bound && afterAgora;
    if (beforeAgora !== afterAgora) {
      this.analytics.recordServerEvent({
        eventKey: `super_agora:${after.serverId}:${occurredAt}`,
        serverSnowflakeId: after.serverId,
        serverName: after.guildName,
        eventType: afterAgora ? 'agora_configured' : 'agora_unconfigured',
        occurredAt,
      });
    }
    if (beforeReady !== afterReady) {
      this.analytics.recordServerEvent({
        eventKey: `super_ready:${after.serverId}:${occurredAt}`,
        serverSnowflakeId: after.serverId,
        serverName: after.guildName,
        eventType: afterReady ? 'share_ready' : 'share_unready',
        occurredAt,
      });
    }
  }

  // ===== Sessions =====

  @Get('sessions')
  listAllSessions() {
    return this.db.getAllSessions().filter(s => !s.serverId.startsWith('panel:')).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Get('sessions/server/:serverId')
  listServerSessions(@Param('serverId') serverId: string) {
    this.getNonPanelServer(serverId);
    return this.db.getSessionsByServer(serverId).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  deleteSession(@Param('id') id: string) {
    const session = this.db.getSessionById(id);
    if (session) this.getNonPanelServer(session.serverId);
    const ok = this.db.deleteSession(id);
    return { ok };
  }
}
