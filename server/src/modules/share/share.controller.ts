import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ShareTokenGuard } from '../auth/guards/share-token.guard';
import { AgoraService } from '../agora/agora.service';
import { SessionService } from '../session/session.service';
import { DatabaseService } from '../database/database.service';
import { KookService } from '../kook/kook.service';
import { AgoraRole } from '../agora/agora.types';

/** KOOK IDs are numeric snowflake strings; reject anything else */
function isValidKookId(id: string): boolean {
  return /^\d+$/.test(id) && id.length >= 10 && id.length <= 32;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 一键 token：用于 reshare 流程的 CSRF 防护，5 分钟有效 */
interface ReshareToken {
  channelId: string;
  guildId: string;
  expiresAt: number;
}

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);
  /** reshare 一次性 token 内存存储（5 分钟 TTL） */
  private readonly reshareTokens = new Map<string, ReshareToken>();

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly kookService: KookService,
  ) {}

  /** 清理过期的 reshare token */
  private cleanReshareTokens(): void {
    const now = Date.now();
    for (const [k, v] of this.reshareTokens) {
      if (now > v.expiresAt) this.reshareTokens.delete(k);
    }
  }

  @Get('info')
  @UseGuards(ShareTokenGuard)
  info(@Req() req: any) {
    const info = this.sessionService.toInfo(req.session);
    // Get allowed qualities for this server
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

  /** 重新发起共享：显示确认页面（含一次性 token 防 CSRF） */
  @Get('reshare')
  async reshare(@Query('c') channelId: string, @Query('g') guildId: string, @Res() res: any) {
    if (!channelId || !isValidKookId(channelId)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send('<h2>参数无效</h2>');
      return;
    }
    // 生成一次性 token，5 分钟有效
    this.cleanReshareTokens();
    const token = randomBytes(32).toString('hex');
    this.reshareTokens.set(token, {
      channelId,
      guildId: guildId || '',
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const safeChannelId = htmlEscape(channelId);
    const safeGuildId = htmlEscape(guildId || '');
    const safeToken = htmlEscape(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xgoat.Cast - 重新发起共享</title></head>' +
      '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;background:#0f1020;color:#fff">' +
      '<h2 style="color:#FF8C42;margin-bottom:16px">🐑 Xgoat.Cast 屏幕共享</h2>' +
      '<p style="color:#aaa;margin:16px 0 32px">确认要重新发起屏幕共享吗？</p>' +
      '<form method="POST" action="/api/share/reshare-confirm" style="display:inline-block">' +
      '<input type="hidden" name="channelId" value="' + safeChannelId + '">' +
      '<input type="hidden" name="guildId" value="' + safeGuildId + '">' +
      '<input type="hidden" name="_rtoken" value="' + safeToken + '">' +
      '<button type="submit" style="padding:12px 32px;background:linear-gradient(135deg,#FF6B35,#FF8C42);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer">✅ 确认发起</button>' +
      '</form>' +
      '<p style="color:#666;margin-top:24px;font-size:14px">新的共享链接将推送到 KOOK 频道</p>' +
      '</body></html>',
    );
  }

  /** 发布端开始共享 */
  @Post('start')
  @UseGuards(ShareTokenGuard)
  start(@Req() req: any, @Body('quality') quality?: string, @Body('clientId') clientId?: string, @Body('lowLatency') lowLatency?: boolean) {
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

  /** 发布端停止共享 */
  @Post('stop')
  @UseGuards(ShareTokenGuard)
  stop(@Req() req: any) {
    const session = this.sessionService.stopSharing(req.session.token);
    return { ok: !!session };
  }

  /** 确认重新发起：创建新 session 并推送共享链接卡片到频道（需一次性 token） */
  @Post('reshare-confirm')
  async reshareConfirm(
    @Body('channelId') channelId: string,
    @Body('guildId') guildId: string,
    @Body('_rtoken') reshareToken: string,
    @Res() res: any,
  ) {
    if (!channelId || !isValidKookId(channelId)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send('<h2>参数无效</h2>');
      return;
    }

    // 验证一次性 token
    this.cleanReshareTokens();
    const entry = this.reshareTokens.get(reshareToken || '');
    if (!entry || entry.channelId !== channelId) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(403).send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Xgoat.Cast - 拒绝</title></head>' +
        '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;background:#0f1020;color:#fff">' +
        '<h2 style="color:#ef4444">❌ 请求无效或已过期</h2>' +
        '<p style="color:#aaa">请从 KOOK 频道卡片重新进入</p>' +
        '</body></html>',
      );
      return;
    }
    // 一次性消费，防止重放
    this.reshareTokens.delete(reshareToken);

    try {
      const shareLink = await this.kookService.pushShareLinkCard(channelId, '重新发起', guildId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (shareLink) {
        res.send(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xgoat.Cast - 发起成功</title></head>' +
          '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;background:#0f1020;color:#fff">' +
          '<h2 style="color:#FF8C42">✅ 已重新发起屏幕共享</h2>' +
          '<p style="color:#aaa;margin:16px 0">新共享链接已推送到 KOOK 频道</p>' +
          '<a href="' + shareLink + '" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF6B35,#FF8C42);color:#fff;border-radius:12px;text-decoration:none;font-weight:600">🖥 点击开始共享</a>' +
          '</body></html>',
        );
      } else {
        res.send(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Xgoat.Cast - 失败</title></head>' +
          '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;background:#0f1020;color:#fff">' +
          '<h2 style="color:#ef4444">❌ 重新发起失败</h2>' +
          '<p style="color:#aaa">机器人可能未连接，请稍后重试或频道发送「屏幕共享」</p>' +
          '</body></html>',
        );
      }
    } catch (err: any) {
      this.logger.error('reshare-confirm error: ' + (err?.message || err));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(500).send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Xgoat.Cast - 错误</title></head>' +
        '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;background:#0f1020;color:#fff">' +
        '<h2 style="color:#ef4444">❌ 服务暂时不可用</h2>' +
        '<p style="color:#aaa">请稍后重试或频道发送「屏幕共享」</p>' +
        '</body></html>',
      );
    }
  }
}
