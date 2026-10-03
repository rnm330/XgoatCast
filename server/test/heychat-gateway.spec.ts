import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import {
  HEYCHAT_WS_CONNECT_TIMEOUT_MS,
  HEYCHAT_WS_CHAT_VERSION,
  HEYCHAT_WS_HEARTBEAT_INTERVAL_MS,
  HEYCHAT_WS_PONG_TIMEOUT_MS,
  HeychatGatewayService,
} from '../src/modules/heychat/heychat-gateway.service';

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  terminateCalls = 0;
  closeCalls = 0;
  removeAllListenersCalls = 0;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): void {
    this.removeAllListenersCalls += 1;
  }
}

type GatewayInternals = {
  socket: WebSocket | null;
  socketOpen: boolean;
  healthy: boolean;
  stopping: boolean;
  reconnectAttempt: number;
  connect(): void;
  startConnectionTimeout(socket: WebSocket): void;
  startHeartbeat(socket: WebSocket): void;
  handleOpen(socket: WebSocket): void;
  handleMessage(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): void;
  handleClose(socket: WebSocket, code: number): void;
};

function createGateway() {
  const routed: unknown[] = [];
  const api = {
    botId: 'fixture-bot',
    token: 'fixture-token',
    refresh() { return false; },
  };
  const gateway = new HeychatGatewayService(
    api as any,
    { async route(event: unknown) { routed.push(event); return true; } } as any,
  );
  (gateway as any).logger = { log() {}, warn() {}, error() {} };
  return {
    gateway,
    internals: gateway as unknown as GatewayInternals,
    routed,
    api,
  };
}

test('WebSocket transport keeps the documented 999 protocol version', () => {
  assert.equal(HEYCHAT_WS_CHAT_VERSION, '999.0.0');
});

test('PONG records liveness and cancels the outstanding heartbeat timeout', (t) => {
  t.mock.timers.enable({
    apis: ['setInterval', 'setTimeout', 'Date'],
    now: 1_000,
  });
  const { gateway, internals, routed } = createGateway();
  const fakeSocket = new FakeSocket();
  const socket = fakeSocket as unknown as WebSocket;
  internals.socket = socket;
  internals.socketOpen = true;
  internals.healthy = false;
  internals.reconnectAttempt = 3;
  internals.startHeartbeat(socket);

  t.mock.timers.tick(HEYCHAT_WS_HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(fakeSocket.sent, ['PING']);
  assert.equal(gateway.status.awaitingPongSince, 31_000);
  assert.equal(gateway.status.open, true);
  assert.equal(gateway.status.connected, false);

  internals.handleMessage(socket, Buffer.from('PONG'), false);
  assert.equal(gateway.status.reconnectAttempt, 0);
  assert.equal(gateway.status.lastPongAt, 31_000);
  assert.equal(gateway.status.awaitingPongSince, null);
  assert.equal(gateway.status.healthy, true);
  assert.equal(routed.length, 0);

  t.mock.timers.tick(HEYCHAT_WS_PONG_TIMEOUT_MS);
  assert.equal(fakeSocket.terminateCalls, 0);
  assert.equal(gateway.status.connected, true);

  gateway.onModuleDestroy();
  t.mock.timers.reset();
});

test('an open socket is not healthy until its immediate PING receives PONG', (t) => {
  t.mock.timers.enable({
    apis: ['setInterval', 'setTimeout', 'Date'],
    now: 50_000,
  });
  const { gateway, internals } = createGateway();
  const fakeSocket = new FakeSocket();
  const socket = fakeSocket as unknown as WebSocket;
  internals.socket = socket;
  internals.socketOpen = false;
  internals.healthy = false;
  internals.reconnectAttempt = 3;

  internals.handleOpen(socket);
  assert.deepEqual(fakeSocket.sent, ['PING']);
  assert.equal(gateway.status.open, true);
  assert.equal(gateway.status.healthy, false);
  assert.equal(gateway.status.connected, false);
  assert.equal(gateway.status.reconnectAttempt, 3);
  internals.handleMessage(socket, Buffer.from('PONG'), false);
  assert.equal(gateway.status.reconnectAttempt, 0);
  assert.equal(gateway.status.connected, true);
  assert.equal(gateway.status.healthy, true);

  gateway.onModuleDestroy();
  t.mock.timers.reset();
});

test('missing PONG marks the socket disconnected, terminates it, and schedules reconnect', (t) => {
  t.mock.timers.enable({
    apis: ['setInterval', 'setTimeout', 'Date'],
    now: 10_000,
  });
  const { gateway, internals } = createGateway();
  const fakeSocket = new FakeSocket();
  const socket = fakeSocket as unknown as WebSocket;
  internals.socket = socket;
  internals.socketOpen = false;
  internals.healthy = false;
  internals.reconnectAttempt = 3;
  internals.handleOpen(socket);

  assert.deepEqual(fakeSocket.sent, ['PING']);
  assert.equal(gateway.status.open, true);
  assert.equal(gateway.status.connected, false);
  t.mock.timers.tick(HEYCHAT_WS_PONG_TIMEOUT_MS);

  assert.equal(fakeSocket.terminateCalls, 1);
  assert.equal(gateway.status.connected, false);
  assert.equal(gateway.status.open, false);
  assert.equal(gateway.status.awaitingPongSince, null);
  assert.equal(gateway.status.lastError, 'websocket_pong_timeout');
  assert.equal(gateway.status.reconnectAttempt, 4);

  internals.handleClose(socket, 1006);
  assert.equal(gateway.status.reconnectAttempt, 4);

  gateway.onModuleDestroy();
  t.mock.timers.reset();
});

test('a connection that never opens is terminated and enters the same reconnect path', (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'Date'],
    now: 100_000,
  });
  const { gateway, internals } = createGateway();
  const fakeSocket = new FakeSocket();
  fakeSocket.readyState = WebSocket.CONNECTING;
  const socket = fakeSocket as unknown as WebSocket;
  internals.socket = socket;
  internals.socketOpen = false;
  internals.healthy = false;
  internals.startConnectionTimeout(socket);

  t.mock.timers.tick(HEYCHAT_WS_CONNECT_TIMEOUT_MS);

  assert.equal(fakeSocket.terminateCalls, 1);
  assert.equal(gateway.status.connected, false);
  assert.equal(gateway.status.lastError, 'websocket_connect_timeout');
  assert.equal(gateway.status.reconnectAttempt, 1);

  gateway.onModuleDestroy();
  t.mock.timers.reset();
});

test('credential reload force-reconnects an unchanged token without stripping socket error listeners', () => {
  const { gateway, internals } = createGateway();
  const fakeSocket = new FakeSocket();
  fakeSocket.readyState = WebSocket.CONNECTING;
  internals.socket = fakeSocket as unknown as WebSocket;
  internals.socketOpen = false;
  internals.healthy = false;
  internals.reconnectAttempt = 5;
  let connectCalls = 0;
  internals.connect = () => { connectCalls += 1; };

  assert.equal(gateway.reloadCredential(), true);
  assert.equal(fakeSocket.closeCalls, 1);
  assert.equal(fakeSocket.removeAllListenersCalls, 0);
  assert.equal(connectCalls, 1);
  assert.equal(gateway.status.open, false);
  assert.equal(gateway.status.healthy, false);
  assert.equal(gateway.status.reconnectAttempt, 0);
});

test('credential reload can explicitly skip reconnect when neither token nor socket changed', () => {
  const { gateway, internals } = createGateway();
  let connectCalls = 0;
  internals.connect = () => { connectCalls += 1; };

  assert.equal(gateway.reloadCredential(false), false);
  assert.equal(connectCalls, 0);
});
