import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import {
  SuperAdminLoginDto,
  UpdateGlobalConfigDto,
  UpdateServerDto,
} from './super-admin.dto';

/** 用户 ID 脱敏：保留首 3 位和末 4 位 */
function maskUserId(uid: string): string {
  if (!uid || uid.length <= 7) return uid;
  return uid.slice(0, 3) + '****' + uid.slice(-4);
}

@Controller('api/super')
export class SuperAdminController {
  private superPasswordHash: string;
  private readonly tokenSecret: string;
  private readonly tokenTtlSec = 7 * 24 * 3600;

  constructor(private readonly db: DatabaseService) {
    const pwd = process.env.SUPER_ADMIN_PASSWORD!;
    this.superPasswordHash = bcrypt.hashSync(pwd, 10);
    this.tokenSecret = pwd;
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
      publicDomain: cfg.publicDomain,
    };
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateGlobalConfigDto) {
    if (dto.kookBotToken !== undefined && dto.kookBotToken !== '******') {
      this.db.setGlobalConfig('kookBotToken', dto.kookBotToken);
    }
    if (dto.publicDomain !== undefined) {
      this.db.setGlobalConfig('publicDomain', dto.publicDomain);
    }
    return { ok: true };
  }

  // ===== Server Management =====

  @Get('servers')
  listServers() {
    const servers = this.db.listServers();
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
    const s = this.db.getServer(id);
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
      allowedQualities: JSON.parse(s.allowedQualities),
      triggerWords: s.triggerWords,
      idleTimeoutSec: s.idleTimeoutSec,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      noViewerTimeoutSec: s.noViewerTimeoutSec,
      publicDomain: s.publicDomain,
      allowLowLatency: s.allowLowLatency,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  @Get('servers/:id/events')
  getServerEvents(@Param('id') id: string) {
    return this.db.getServerEvents(id);
  }

  @Get('servers/:id/sessions')
  getServerSessions(@Param('id') id: string) {
    return this.db.getSessionsByServer(id).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Put('servers/:id')
  updateServer(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    const s = this.db.getServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    if (dto.agoraAppId !== undefined) updates.agoraAppId = dto.agoraAppId;
    if (dto.agoraAppCertificate !== undefined && dto.agoraAppCertificate !== '******') {
      updates.agoraAppCertificate = dto.agoraAppCertificate;
    }
    if (dto.agoraTokenExpireSec !== undefined) updates.agoraTokenExpireSec = dto.agoraTokenExpireSec;
    if (dto.allowedQualities !== undefined) updates.allowedQualities = JSON.stringify(dto.allowedQualities);
    if (dto.triggerWords !== undefined) updates.triggerWords = dto.triggerWords;
    if (dto.idleTimeoutSec !== undefined) updates.idleTimeoutSec = dto.idleTimeoutSec;
    if (dto.heartbeatIntervalSec !== undefined) updates.heartbeatIntervalSec = dto.heartbeatIntervalSec;
    if (dto.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = dto.noViewerTimeoutSec;
    if (dto.publicDomain !== undefined) updates.publicDomain = dto.publicDomain;
    if (dto.allowLowLatency !== undefined) updates.allowLowLatency = dto.allowLowLatency;

    this.db.updateServer(id, updates);
    return { ok: true };
  }

  @Delete('servers/:id')
  deleteServer(@Param('id') id: string) {
    const s = this.db.getServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };
    this.db.deleteServer(id);
    return { ok: true };
  }

  // ===== Sessions =====

  @Get('sessions')
  listAllSessions() {
    return this.db.getAllSessions().map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Get('sessions/server/:serverId')
  listServerSessions(@Param('serverId') serverId: string) {
    return this.db.getSessionsByServer(serverId).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  deleteSession(@Param('id') id: string) {
    const ok = this.db.deleteSession(id);
    return { ok };
  }
}
