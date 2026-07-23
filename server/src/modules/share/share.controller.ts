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

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
  ) {}

  @Get('info')
  @UseGuards(ShareTokenGuard)
  info(@Req() req: any) {
    const info = this.sessionService.toInfo(req.session);
    const serverId = req.session.guildId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    return {
      ...info,
      allowedQualities,
    };
  }

  @Get('token')
  @UseGuards(ShareTokenGuard)
  token(@Req() req: any, @Query('role') role: string) {
    const r: AgoraRole = role === 'publisher' ? 'publisher' : 'subscriber';
    const uid = r === 'publisher' ? 1 : Math.floor(Math.random() * 99999) + 100;
    const serverId = req.session.guildId || '';
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
    const session = this.sessionService.startSharing(
      req.session.token,
      clientId,
      lowLatency,
    );
    if (session && quality && /^[a-zA-Z0-9]+$/.test(quality)) {
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
}
