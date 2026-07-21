import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import {
  ServerAdminLoginDto,
  UpdateServerConfigDto,
  BindServerDto,
} from './server-admin.dto';

@Controller('api/server')
export class ServerAdminController {
  private readonly tokenTtlSec = 7 * 24 * 3600;

  constructor(private readonly db: DatabaseService) {}

  // ===== Auth =====

  /** Bind server: set password for the first time (called from KOOK card button) */
  @Post(':serverId/bind')
  @HttpCode(HttpStatus.OK)
  bindServer(@Param('serverId') serverId: string, @Body() dto: BindServerDto) {
    const server = this.db.getServer(serverId);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (server.bound) return { ok: false, message: '服务器已绑定' };

    // 校验绑定 token（未绑定时必须提供有效 token）
    if (!dto.token || !this.db.validateBindToken(serverId, dto.token)) {
      return { ok: false, message: '绑定链接无效或已过期，请在 KOOK 服务器内重新发送 /xc绑定 命令' };
    }

    const passwordHash = bcrypt.hashSync(dto.password, 10);
    this.db.updateServer(serverId, {
      passwordHash,
      bound: 1,
      reboundAt: Date.now(),
    });
    // 绑定成功后清空 token
    this.db.clearBindToken(serverId);
    return { ok: true, message: '绑定成功' };
  }

  /** Check if server is bound (for KOOK card flow) */
  @Get(':serverId/status')
  getServerStatus(@Param('serverId') serverId: string, @Query('token') token?: string) {
    const server = this.db.getServer(serverId);
    if (!server) return { exists: false };
    const result: any = {
      exists: true,
      bound: !!server.bound,
      guildName: server.guildName,
      openId: server.openId,
    };
    // 未绑定时校验绑定 token
    if (!server.bound) {
      if (!token) {
        result.tokenValid = false;
      } else {
        result.tokenValid = this.db.validateBindToken(serverId, token);
      }
    }
    return result;
  }

  /** Login to server admin panel */
  @Post(':serverId/login')
  @HttpCode(HttpStatus.OK)
  login(@Param('serverId') serverId: string, @Body() dto: ServerAdminLoginDto) {
    const server = this.db.getServer(serverId);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (!server.bound) return { ok: false, message: '服务器尚未绑定' };

    if (!bcrypt.compareSync(dto.password, server.passwordHash)) {
      return { ok: false, message: '密码错误' };
    }

    const payload = {
      role: 'server_admin',
      serverId,
      exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // 使用每服务器独立的 HMAC 密钥签名
    const serverSecret = server.serverSecret || process.env.SUPER_ADMIN_PASSWORD!;
    const sig = createHmac('sha256', serverSecret).update(body).digest('base64url');
    return { ok: true, token: body + '.' + sig };
  }

  // ===== Server Config =====

  @Get(':serverId/config')
  getConfig(@Param('serverId') serverId: string) {
    const server = this.db.getServer(serverId);
    if (!server) return { ok: false, message: '服务器不存在' };

    return {
      serverId: server.serverId,
      guildName: server.guildName,
      agoraAppId: server.agoraAppId,
      agoraAppCertificate: server.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: server.agoraTokenExpireSec,
      allowedQualities: JSON.parse(server.allowedQualities),
      idleTimeoutSec: server.idleTimeoutSec,
      heartbeatIntervalSec: server.heartbeatIntervalSec,
      noViewerTimeoutSec: server.noViewerTimeoutSec,
      publicDomain: server.publicDomain,
      allowLowLatency: server.allowLowLatency,
    };
  }

  @Put(':serverId/config')
  updateConfig(@Param('serverId') serverId: string, @Body() dto: UpdateServerConfigDto) {
    const server = this.db.getServer(serverId);
    if (!server) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    if (dto.agoraAppId !== undefined) updates.agoraAppId = dto.agoraAppId;
    if (dto.agoraAppCertificate !== undefined && dto.agoraAppCertificate !== '******') {
      updates.agoraAppCertificate = dto.agoraAppCertificate;
    }
    if (dto.agoraTokenExpireSec !== undefined) updates.agoraTokenExpireSec = dto.agoraTokenExpireSec;
    if (dto.allowedQualities !== undefined) updates.allowedQualities = JSON.stringify(dto.allowedQualities);
    if (dto.idleTimeoutSec !== undefined) updates.idleTimeoutSec = dto.idleTimeoutSec;
    if (dto.heartbeatIntervalSec !== undefined) updates.heartbeatIntervalSec = dto.heartbeatIntervalSec;
    if (dto.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = dto.noViewerTimeoutSec;
    if (dto.publicDomain !== undefined) updates.publicDomain = dto.publicDomain;
    if (dto.allowLowLatency !== undefined) updates.allowLowLatency = dto.allowLowLatency;

    this.db.updateServer(serverId, updates);
    return { ok: true };
  }

  // ===== Sessions =====

  @Get(':serverId/sessions')
  listSessions(@Param('serverId') serverId: string) {
    const server = this.db.getServer(serverId);
    if (!server) return [];
    return this.db.getSessionsByServerFiltered(serverId, server.reboundAt);
  }
}
