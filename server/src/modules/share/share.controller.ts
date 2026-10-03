import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ShareTokenGuard } from '../auth/guards/share-token.guard';
import { AgoraService } from '../agora/agora.service';
import { SessionService } from '../session/session.service';
import { AgoraRole } from '../agora/agora.types';
import { DatabaseService } from '../database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);
  private readonly desktopLaunches = new Map<string, { id: string; clientId: string; respondedAt: number }>();

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('info')
  @UseGuards(ShareTokenGuard)
  info(@Req() req: any, @Query('desktopLaunchId') desktopLaunchId?: string, @Query('desktopClientId') desktopClientId?: string) {
    const now = Date.now();
    for (const [id, response] of this.desktopLaunches) {
      if (now - response.respondedAt > 120_000) this.desktopLaunches.delete(id);
    }
    if (!req.panelViewer && /^[a-zA-Z0-9_-]{16,128}$/.test(desktopLaunchId || '') && /^[a-zA-Z0-9_-]{16,128}$/.test(desktopClientId || '')) {
      this.desktopLaunches.set(req.session.id, { id: desktopLaunchId!, clientId: desktopClientId!, respondedAt: now });
      if (this.desktopLaunches.size > 2000) this.desktopLaunches.delete(this.desktopLaunches.keys().next().value!);
    }
    const info = this.sessionService.toInfo(req.session);
    const serverId = req.session.spaceId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    return {
      ...info,
      ...(req.panelViewer ? { shareLink: '', publisherClientId: undefined } : {}),
      allowedQualities,
      qualityBitrates: this.db.getGlobalConfig().qualityBitrates,
      desktopLaunch: req.panelViewer ? undefined : this.desktopLaunches.get(req.session.id),
    };
  }

  @Get('token')
  @UseGuards(ShareTokenGuard)
  token(@Req() req: any, @Query('role') role: string) {
    const r: AgoraRole = role === 'publisher' ? 'publisher' : 'subscriber';
    const uid = r === 'publisher' ? 1 : Math.floor(Math.random() * 99999) + 100;
    const serverId = req.session.spaceId || '';
    const result = this.agora.generateToken(req.session.channel, uid, r, serverId);
    if (!result.appId) {
      this.logger.warn(`token endpoint: appId not configured for serverId=${serverId}`);
      throw new HttpException(
        { message: '该服务器尚未配置 Agora App ID，请联系服务器管理员在管理面板中配置', code: 'AGORA_NOT_CONFIGURED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return result;
  }

  @Post('start')
  @UseGuards(ShareTokenGuard)
  start(
    @Req() req: any,
    @Body('quality') quality?: string,
    @Body('clientId') clientId?: string,
    @Body('lowLatency') lowLatency?: boolean,
  ) {
    const serverId = req.session.spaceId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    if (!quality || !allowedQualities.includes(quality)) {
      throw new HttpException(
        { message: '该画质未对本服务器开放，请刷新页面后重新选择', code: 'QUALITY_NOT_ALLOWED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const session = this.sessionService.startSharing(
      req.session.token,
      clientId,
      lowLatency,
    );
    if (session) {
      this.sessionService.updateQuality(session.id, quality);
    }
    if (!session) {
      return { ok: false, message: 'unable to start sharing (session ended or publisher locked)' };
    }
    return { ok: true };
  }

  @Post('stop')
  @UseGuards(ShareTokenGuard)
  stop(@Req() req: any) {
    const session = this.sessionService.stopSharing(req.session.token);
    return { ok: !!session };
  }

  /** Desktop capture owns its heartbeat independently from the browser control page. */
  @Post('heartbeat')
  @UseGuards(ShareTokenGuard)
  heartbeat(@Req() req: any, @Body('clientId') clientId?: string) {
    if (!clientId || req.session.publisherClientId !== clientId || req.session.status !== 'active') {
      return { ok: false };
    }
    return { ok: this.sessionService.heartbeat(req.session.token) };
  }

  @Post('telemetry')
  @UseGuards(ShareTokenGuard)
  telemetry(@Req() req: any, @Body() body: any) {
    this.analytics.recordClientTelemetry(req.session, {
      pageType: body?.pageType,
      eventType: body?.eventType,
      failureReason: body?.failureReason,
      deviceType: body?.deviceType,
      osName: body?.osName,
      browserName: body?.browserName,
      browserMajor: body?.browserMajor,
    });
    return { ok: true };
  }
}
