import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/modules/database/database.service';
import { SessionService } from '../src/modules/session/session.service';
import { AgoraService } from '../src/modules/agora/agora.service';
import { EventBusService } from '../src/modules/events/events.service';
import { PanelAccessService } from '../src/modules/panels/panel-access.service';
import { PanelRegistrationService } from '../src/modules/panels/panel-registration.service';

test('restart restores rooms, deduplicates viewers and bounds orphan cleanup across repeated restarts', async () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'restart-')), originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  process.chdir(root);
  const db = new DatabaseService();
  const analytics = new Proxy({}, { get: () => () => undefined }) as any;
  const make = () => new SessionService(db, new AgoraService(db), new EventBusService(), analytics);
  try {
    db.createServer('room', 'Room', 'owner', 'Owner');
    db.updateServer('room', { noViewerTimeoutSec: 120 });
    let service = make();
    const create = () => {
      const s = service.createSession({ platform: 'kook', spaceId: 'room', externalSpaceId: 'room', externalChannelId: '', sharerUserId: 'owner', sharerUsername: 'Owner', manualCreated: true });
      db.updateSession(s.id, { status: 'active', startedAt: now, lastHeartbeat: now }); return s;
    };
    const live = create(), orphan = create(), empty = create();
    service.viewerConnected(live.id, 'viewer1');
    assert.equal(db.getSessionById(live.id)?.totalViewerJoins, 1);
    now += 10_000; service = make(); await service.onModuleInit();
    service.viewerConnected(live.id, 'viewer1'); service.heartbeat(live.token); service.heartbeat(empty.token);
    assert.equal(db.getSessionById(live.id)?.totalViewerJoins, 1);
    const deadline = (db.integrationDatabase.prepare('SELECT until_at FROM session_recovery WHERE session_id=?').get(orphan.id) as any).until_at;
    now += 10_000; service = make(); await service.onModuleInit();
    assert.equal((db.integrationDatabase.prepare('SELECT until_at FROM session_recovery WHERE session_id=?').get(orphan.id) as any).until_at, deadline);
    service.viewerConnected(live.id, 'viewer1'); service.heartbeat(live.token); service.heartbeat(empty.token);
    now = deadline + 1; service.heartbeat(live.token); service.heartbeat(empty.token); await service.watchdog();
    assert.equal(db.getSessionById(live.id)?.status, 'active');
    assert.equal(db.getSessionById(orphan.id)?.status, 'ended');
    now += 120_000; service.heartbeat(live.token); service.heartbeat(empty.token); await service.watchdog();
    assert.equal(db.getSessionById(empty.id)?.status, 'ended');
    assert.equal(db.getSessionById(live.id)?.status, 'active');
    service.endSession(live.id, 'manual');
    service = make(); await service.onModuleInit();
    assert.equal(db.getSessionById(live.id)?.status, 'ended');
  } finally { db.onModuleDestroy(); Date.now = originalNow; process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});

test('SMTP settings persist without returning passwords and tests use saved settings', async () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'smtp-')); process.chdir(root);
  const db = new DatabaseService();
  try {
    const make = () => new PanelRegistrationService(db, new PanelAccessService(db));
    let service = make();
    const input = { host: 'smtp.example.test', port: 465, secure: true, user: 'account', password: 'secret-password', from: 'sender@example.test' };
    const saved = service.saveMailSettings(input);
    assert.equal('password' in saved, false); assert.equal(saved.passwordSet, true);
    service = make(); assert.equal(service.mailReady(), true);
    service.saveMailSettings({ ...input, password: '' });
    assert.equal((service as any).mailConfig().password, input.password);
    assert.throws(() => service.saveMailSettings({ ...input, port: 0 }));
    assert.throws(() => service.saveMailSettings({ ...input, from: 'bad\r\nBcc: victim' }));
    let verified = 0, sent = 0;
    (service as any).transport = { verify: async () => verified++, sendMail: async (mail: any) => { assert.equal(mail.to, 'test@example.test'); sent++; } };
    const req = { ip: '127.0.0.1' } as any;
    await service.testMail(req, {}); await service.testMail(req, { to: 'test@example.test' });
    assert.equal(verified, 1); assert.equal(sent, 1);
  } finally { db.onModuleDestroy(); process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
