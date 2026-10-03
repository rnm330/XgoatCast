import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ShareController } from '../src/modules/share/share.controller';
import { SessionSseController } from '../src/modules/session/session-sse.controller';

test('desktop heartbeat requires matching active publisher and does not recover a stopped session', () => {
  let heartbeats = 0;
  const controller = new ShareController({} as any, { heartbeat() { heartbeats++; return true; } } as any, {} as any, {} as any);
  const request = { session: { token: 'token', publisherClientId: 'browser-id', status: 'active' } };
  assert.deepEqual(controller.heartbeat(request, 'other'), { ok: false });
  assert.deepEqual(controller.heartbeat(request), { ok: false });
  assert.deepEqual(controller.heartbeat(request, 'browser-id'), { ok: true });
  request.session.status = 'grace';
  assert.deepEqual(controller.heartbeat(request, 'browser-id'), { ok: false });
  assert.equal(heartbeats, 1);
});

test('desktop control page can observe SSE without holding the capture heartbeat alive', async () => {
  let heartbeats = 0, viewers = 0;
  const session = { id: 'session', status: 'active', publisherClientId: 'browser-id', lowLatency: false };
  const service = { getByToken: () => session, getById: () => session, toInfo: () => ({}),
    heartbeat() { heartbeats++; }, viewerConnected() { viewers++; } };
  const analytics = { clientConnected() {}, clientDisconnected() {} };
  const controller = new SessionSseController(service as any, {} as any, analytics as any);
  const response = Object.assign(new EventEmitter(), { setHeader() {}, flushHeaders() {}, write() {}, end() {} });
  await controller.stream('token', 'publisher', 'browser-id', '', '1', response as any);
  response.emit('close');
  assert.equal(heartbeats,0); assert.equal(viewers,0);
});
