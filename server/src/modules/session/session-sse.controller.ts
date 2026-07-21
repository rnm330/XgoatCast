import {
  Controller,
  Get,
  Query,
  Res,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Response } from 'express';
import { SessionService } from './session.service';
import { EventBusService } from '../events/events.service';

interface SseClient {
  res: Response;
  role: 'publisher' | 'viewer';
  /** publisher: clientId; viewer: viewerId (UUID from sessionStorage) */
  uid: string;
}

@Controller('api/share')
export class SessionSseController implements OnModuleInit {
  private readonly logger = new Logger(SessionSseController.name);

  /** sessionId → connected SSE clients */
  private readonly sseClients = new Map<string, SseClient[]>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly bus: EventBusService,
  ) {}

  onModuleInit() {
    // 会话状态变更 → 推送给该 session 的所有 SSE 客户端
    this.bus.onSessionStateChanged((event) => {
      const state = this.buildState(event.sessionId);
      if (state) {
        this.pushToSession(event.sessionId, 'session_state', state);
      }
    });

    // 会话结束 → 推送给该 session 的所有 SSE 客户端，然后清理
    this.bus.onSessionEnded((event) => {
      this.pushToSession(event.sessionId, 'session_ended', {
        sessionId: event.sessionId,
      });
      this.sseClients.delete(event.sessionId);
    });
  }

  /**
   * SSE 事件流端点。
   * 发布端: GET /api/share/stream?t=<token>&role=publisher&cid=<clientId>
   * 观众端: GET /api/share/stream?t=<token>&role=viewer&vid=<viewerId>
   */
  @Get('stream')
  async stream(
    @Query('t') token: string,
    @Query('role') role: string,
    @Query('cid') clientId: string,
    @Query('vid') viewerId: string,
    @Res() res: Response,
  ) {
    // ===== SSE 响应头 =====
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
    res.flushHeaders();

    // ===== 鉴权 =====
    if (!token) {
      this.sendAndClose(res, 'session_error', { message: 'missing token' });
      return;
    }

    const session = this.sessionService.getByToken(token);
    if (!session) {
      this.sendAndClose(res, 'session_error', {
        message: 'invalid or expired link',
      });
      return;
    }

    if (session.status === 'ended') {
      this.sendAndClose(res, 'session_error', { message: 'share ended' });
      return;
    }

    const resolvedRole = (role === 'publisher' ? 'publisher' : 'viewer') as
      | 'publisher'
      | 'viewer';
    const uid = resolvedRole === 'viewer' ? viewerId || 'anon-viewer' : clientId || 'anon-publisher';

    // ===== 连接数限制 =====
    const MAX_CLIENTS_PER_SESSION = 200;
    const currentClients = this.sseClients.get(session.id) || [];
    if (currentClients.length >= MAX_CLIENTS_PER_SESSION) {
      this.sendAndClose(res, 'session_error', { message: 'too many connections' });
      return;
    }

    // ===== 注册客户端 =====
    if (!this.sseClients.has(session.id)) {
      this.sseClients.set(session.id, []);
    }
    this.sseClients.get(session.id)!.push({ res, role: resolvedRole, uid });

    this.logger.log(
      `SSE client connected: session=${session.id}, role=${resolvedRole}, uid=${uid.substring(0, 8)}`,
    );

    // ===== TOCTOU 再检查：注册后 session 可能已被 watchdog 结束 =====
    const latest = this.sessionService.getById(session.id);
    if (!latest || latest.status === 'ended') {
      res.write(`event: session_ended\ndata: ${JSON.stringify({ sessionId: session.id })}\n\n`);
      this.removeClient(session.id, res);
      res.end();
      return;
    }

    // 观众连接后，同步指标到 DB + 推送状态给所有客户端
    if (resolvedRole === 'viewer') {
      this.sessionService.updateViewerMetrics(
        session.id,
        this.countViewers(session.id),
        true,
      );
    }

    // ===== 发布端心跳保活 =====
    let keepalive: ReturnType<typeof setInterval> | null = null;
    if (resolvedRole === 'publisher') {
      // 连接建立时立即更新心跳（同时触发 GRACE 恢复）
      this.sessionService.heartbeat(token);

      keepalive = setInterval(() => {
        try {
          this.sessionService.heartbeat(token);
          res.write(': hb\n\n');
        } catch {
          // 连接已断开，清理由 close 事件处理
        }
      }, 4000);
    } else {
      keepalive = setInterval(() => {
        try {
          res.write(': hb\n\n');
        } catch {
          // 连接已断开
        }
      }, 4000);
    }

    // ===== 推送初始状态 =====
    const state = this.buildState(session.id);
    if (state) {
      res.write(`event: session_state\ndata: ${JSON.stringify(state)}\n\n`);
    }

    // ===== 连接关闭时清理 =====
    res.on('close', () => {
      if (keepalive) clearInterval(keepalive);
      const wasViewer = resolvedRole === 'viewer';
      this.removeClient(session.id, res);
      this.logger.log(
        `SSE client disconnected: session=${session.id}, role=${resolvedRole}`,
      );

      // 观众离开后，同步指标到 DB + 推送状态给所有客户端
      if (wasViewer) {
        this.sessionService.updateViewerMetrics(
          session.id,
          this.countViewers(session.id),
          false,
        );
      }
    });
  }

  // ===== 私有方法 =====

  /** 构建 session_state 数据，包含实时观众数 */
  private buildState(sessionId: string) {
    const session = this.sessionService.getById(sessionId);
    if (!session) return null;
    const info = this.sessionService.toInfo(session);
    return {
      status: session.status,
      viewerCount: this.countViewers(sessionId),
      publisherClientId: session.publisherClientId,
      idleRemainingSec: info.idleRemainingSec,
      noViewerRemainingSec: info.noViewerRemainingSec,
      lowLatency: session.lowLatency,
    };
  }

  /** 统计指定 session 的当前在线观众数（活跃 SSE 连接中 role=viewer 的数量） */
  private countViewers(sessionId: string): number {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return 0;
    return clients.filter((c) => c.role === 'viewer').length;
  }

  /** 向指定 session 的所有 SSE 客户端推送事件 */
  private pushToSession(sessionId: string, event: string, data: any) {
    const clients = this.sseClients.get(sessionId);
    if (!clients || clients.length === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const stale: Response[] = [];
    for (const client of clients) {
      try {
        client.res.write(payload);
      } catch {
        // 写入失败（连接已断），标记为待清理
        stale.push(client.res);
      }
    }
    // 批量清理僵尸客户端，避免下次推送再次尝试写入
    for (const res of stale) {
      this.removeClient(sessionId, res);
    }
  }


  /** 移除一个 SSE 客户端 */
  private removeClient(sessionId: string, res: Response) {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return;
    const idx = clients.findIndex((c) => c.res === res);
    if (idx >= 0) clients.splice(idx, 1);
    if (clients.length === 0) this.sseClients.delete(sessionId);
  }

  /** 发送一个事件后关闭连接 */
  private sendAndClose(res: Response, event: string, data: any) {
    try {
      res.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    } catch {
      // ignore
    }
    res.end();
  }
}
