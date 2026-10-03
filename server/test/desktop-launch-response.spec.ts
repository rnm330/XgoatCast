import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareController } from '../src/modules/share/share.controller';

test('desktop launch response is tied to a session and attempt, expires, and excludes panel viewers', () => {
  const controller = new ShareController({ getAllowedQualities: () => ['720p30'] } as any,
    { toInfo: (session: any) => ({ id: session.id, status: 'pending' }) } as any,
    { getGlobalConfig: () => ({ qualityBitrates: {} }) } as any, {} as any);
  const req = { session: { id: 'session-1', spaceId: 'space' } };
  const id = 'attempt_1234567890', client = 'client_1234567890';
  controller.info(req, id, client);
  assert.equal(controller.info(req).desktopLaunch?.id, id);
  assert.equal(controller.info({ session: { id: 'session-2' } }).desktopLaunch, undefined);
  assert.equal(controller.info({ ...req, panelViewer: true }, 'other_12345678901', client).desktopLaunch, undefined);
  assert.equal(controller.info(req).desktopLaunch?.id, id);
  controller.info(req, 'new_attempt_123456', client);
  assert.equal(controller.info(req).desktopLaunch?.id, 'new_attempt_123456');
  const now = Date.now;
  try { Date.now = () => now() + 121_000; assert.equal(controller.info(req).desktopLaunch, undefined); }
  finally { Date.now = now; }
});
