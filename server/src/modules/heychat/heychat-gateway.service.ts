import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import WebSocket from 'ws';
import JSONbig from 'json-bigint';
import { HeychatApiService } from './heychat-api.service';
import { HeychatEventRouter } from './heychat-event.router';
import type { HeychatEventEnvelope } from './heychat.types';

const WS_BASE = 'wss://chat.xiaoheihe.cn/chatroom/ws/connect';
export const HEYCHAT_WS_CHAT_VERSION = '999.0.0';
export const HEYCHAT_WS_CONNECT_TIMEOUT_MS = 15_000;
export const HEYCHAT_WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEYCHAT_WS_PONG_TIMEOUT_MS = 15_000;
const losslessJson = JSONbig({ storeAsString: true });

@Injectable()
export class HeychatGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeychatGatewayService.name);
  private socket: WebSocket | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopping = false;
  private socketOpen = false;
  private healthy = false;
  private lastPongAt: number | null = null;
  private awaitingPongSince: number | null = null;
  private lastEventAt: number | null = null;
  private lastError = '';

  constructor(
    private readonly api: HeychatApiService,
    private readonly router: HeychatEventRouter,
  ) {}

  onModuleInit(): void {
    if (!this.api.token) {
      this.logger.warn('Heychat bot token not configured, set it in Super Admin panel');
      return;
    }
    this.connect();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.socketOpen = false;
    this.healthy = false;
  }

  get status() {
    return {
      // Keep `connected` for existing status consumers, but make it mean a
      // heartbeat-verified connection rather than a TCP/WebSocket open event.
      connected: this.healthy,
      open: this.socketOpen,
      healthy: this.healthy,
      reconnectAttempt: this.reconnectAttempt,
      lastPongAt: this.lastPongAt,
      awaitingPongSince: this.awaitingPongSince,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  reloadCredential(forceReconnect = true): boolean {
    const changed = this.api.refresh();
    if (!changed && !forceReconnect) return false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.healthy = false;
    this.reconnectAttempt = 0;
    this.lastPongAt = null;
    // Do not remove the error listener before closing a CONNECTING ws socket.
    // `ws.close()` emits an asynchronous error in that state; without the
    // listener Node treats it as an uncaught EventEmitter error and exits.
    socket?.close();
    if (this.api.token && !this.stopping) this.connect();
    return changed || !!socket || (!!this.api.token && !this.stopping);
  }

  private connect(): void {
    if (this.stopping || !this.api.token) return;
    const url = new URL(WS_BASE);
    url.searchParams.set('chat_os_type', 'bot');
    url.searchParams.set('client_type', 'heybox_chat');
    url.searchParams.set('chat_version', HEYCHAT_WS_CHAT_VERSION);
    url.searchParams.set('token', this.api.token);

    const socket = new WebSocket(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    this.socket = socket;
    this.startConnectionTimeout(socket);

    socket.on('open', () => this.handleOpen(socket));

    socket.on('message', (data, isBinary) => {
      this.handleMessage(socket, data, isBinary);
    });

    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.lastError = error.message || 'websocket_error';
      this.logger.warn(`Heychat WebSocket error: ${this.lastError}`);
    });

    socket.on('close', (code) => {
      this.handleClose(socket, code);
    });
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.clearConnectionTimeout();
    this.socketOpen = true;
    this.healthy = false;
    // TCP/WebSocket open alone does not prove the connection is healthy. Keep
    // the accumulated backoff until the gateway answers a heartbeat.
    this.lastPongAt = null;
    this.awaitingPongSince = null;
    this.lastError = '';
    this.startHeartbeat(socket);
    this.sendHeartbeat(socket);
    this.logger.log(`Heychat WebSocket open, awaiting heartbeat (botId=${this.api.botId || 'unknown'})`);
  }

  private handleMessage(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary || this.socket !== socket) return;
    const text = data.toString();
    if (/^pong\b/i.test(text.trim())) {
      if (!this.socketOpen || this.awaitingPongSince === null) return;
      this.reconnectAttempt = 0;
      this.healthy = true;
      this.lastPongAt = Date.now();
      this.awaitingPongSince = null;
      this.clearPongTimeout();
      return;
    }
    let event: HeychatEventEnvelope;
    try {
      event = losslessJson.parse(text) as HeychatEventEnvelope;
    } catch {
      this.logger.warn('Heychat WebSocket returned invalid JSON');
      return;
    }
    this.lastEventAt = Date.now();
    void this.router.route(event).catch((error: any) => {
      this.logger.error(`Heychat event failed: ${error?.message || error}`);
    });
  }

  private handleClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return;
    this.socketOpen = false;
    this.healthy = false;
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    this.socket = null;
    if (!this.stopping) {
      this.logger.warn(`Heychat WebSocket closed: code=${code}; reconnect scheduled`);
      this.scheduleReconnect();
    }
  }

  private startConnectionTimeout(socket: WebSocket): void {
    this.clearConnectionTimeout();
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = null;
      if (this.socket !== socket || this.socketOpen) return;
      this.failSocket(socket, 'websocket_connect_timeout');
    }, HEYCHAT_WS_CONNECT_TIMEOUT_MS);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat(socket);
    }, HEYCHAT_WS_HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (this.socket !== socket || !this.socketOpen || socket.readyState !== WebSocket.OPEN) return;
    this.awaitingPongSince = Date.now();
    this.clearPongTimeout();
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket || this.awaitingPongSince === null) return;
      this.failSocket(socket, 'websocket_pong_timeout');
    }, HEYCHAT_WS_PONG_TIMEOUT_MS);
    try {
      socket.send('PING', (error) => {
        if (error) this.failSocket(socket, 'websocket_heartbeat_send_failed');
      });
    } catch {
      this.failSocket(socket, 'websocket_heartbeat_send_failed');
    }
  }

  private failSocket(socket: WebSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.lastError = reason;
    this.socketOpen = false;
    this.healthy = false;
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    this.logger.warn(`Heychat WebSocket unhealthy: ${reason}; reconnect scheduled`);
    this.scheduleReconnect();
    socket.terminate();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearPongTimeout();
    this.awaitingPongSince = null;
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
