import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseService } from '../src/modules/database/database.service';
import { PanelAccessService } from '../src/modules/panels/panel-access.service';
import { PanelRegistrationService, normalizePanelId } from '../src/modules/panels/panel-registration.service';
import { PanelsController, defaultSharerName, FRUIT_SHARER_NAMES } from '../src/modules/panels/panels.controller';
import { SessionService } from '../src/modules/session/session.service';
import { AgoraService } from '../src/modules/agora/agora.service';
import { EventBusService } from '../src/modules/events/events.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { ShareTokenGuard } from '../src/modules/auth/guards/share-token.guard';
import { ShareController } from '../src/modules/share/share.controller';
import { SessionSseController } from '../src/modules/session/session-sse.controller';
import { SuperAdminController } from '../src/modules/super-admin/super-admin.controller';
import { ServerAdminController } from '../src/modules/server-admin/server-admin.controller';

function request(ip: string, cookies: Record<string, string> = {}) { return { ip, headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, secure: false } as any; }
function response(cookies: Record<string, string>) { return { cookie(name: string, value: string) { cookies[name] = value; } } as any; }

test('panel ID rules and fruit sharer names', () => {
  for (const id of ['abcde', '12345', 'ababab', 'AbC12', 'a'.repeat(15) + 'b']) assert.equal(normalizePanelId(id), id.toLowerCase());
  for (const id of ['aaaaa', '66666', 'aAaAa', 'abc', 'ab-cd', '你好123', 'super', 'register', 'abcdefghijklmnopq']) assert.throws(() => normalizePanelId(id));
  assert.equal(defaultSharerName(0), '苹果');
  assert.equal(defaultSharerName(FRUIT_SHARER_NAMES.length - 1), '橘子');
  assert.ok(FRUIT_SHARER_NAMES.includes(defaultSharerName()));
});

test('panel registration, access boundaries, recovery and suspension', async t => {
  const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'xgoat-panels-')), env = { ...process.env };
  process.chdir(directory); process.env.SUPER_ADMIN_PASSWORD = 'test-super-password'; delete process.env.SMTP_HOST;
  const db = new DatabaseService(), access = new PanelAccessService(db), registration = new PanelRegistrationService(db, access);
  const analytics = new Proxy({}, { get: () => () => undefined }) as any;
  const bus = new EventBusService(), agora = new AgoraService(db), sessions = new SessionService(db, agora, bus, analytics);
  const controller = new PanelsController(access, registration, db, sessions);
  const guard = new ShareTokenGuard(new AuthService(sessions), access), share = new ShareController(agora, sessions, db, analytics);
  const superAdmin = new SuperAdminController(db, analytics), serverAdmin = new ServerAdminController(db, analytics);
  const mails: any[] = [], admin: Record<string, string> = {}, gate: Record<string, string> = {}, viewer: Record<string, string> = {};
  let seq = 0, room: any, publisher: string;
  const req = (cookies: Record<string, string> = {}) => request(`10.0.0.${++seq}`, cookies);
  const captcha = () => { const c = registration.captcha(req()); return { captchaId: c.id, captcha: (registration as any).captchas.get(c.id).answer }; };
  const send = async (email: string, purpose: string) => { await registration.sendCode(req(), { email, purpose, ...captcha() }); return mails[mails.length - 1]?.text.match(/\b\d{6}\b/)[0]; };
  const authorize = (token: string, cookies: Record<string, string> = {}, path = '/api/share/info', role?: string) => {
    const r = Object.assign(req(cookies), { query: { t: token, role }, path });
    guard.canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any); return r;
  };
  try {
    await t.test('missing SMTP or unverified email cannot create a panel', async () => {
      assert.equal(controller.registrationStatus().mailReady, false);
      await assert.rejects(() => registration.sendCode(req(), {}), /邮件服务尚未配置/);
      await assert.rejects(() => registration.register(req(), { id: 'goat123', email: 'owner@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code: '123456' }), /邮箱验证码/);
      assert.equal(db.getSpace('panel', 'goat123'), undefined);
    });
    process.env.SMTP_HOST = 'smtp.test'; process.env.SMTP_USER = 'test'; process.env.SMTP_PASS = 'test'; process.env.SMTP_FROM = 'test@example.test';
    (registration as any).transport = { sendMail: async (m: any) => { mails.push(m); } };
    await t.test('captcha single use, case-insensitive ID/email uniqueness, atomic code consumption', async () => {
      const c = captcha();
      await assert.rejects(() => registration.sendCode(req(), { email: 'bad@example.test', purpose: 'register', ...c, captcha: 'wrong' }), /图片验证码/);
      await assert.rejects(() => registration.sendCode(req(), { email: 'bad@example.test', purpose: 'register', ...c }), /图片验证码/);
      const code = await send('OWNER@example.test', 'register');
      await assert.rejects(() => registration.register(req(), { id: 'goat123', email: 'owner@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code: '000000' }), /邮箱验证码/);
      assert.equal(db.getSpace('panel', 'goat123'), undefined);
      assert.equal((await registration.register(req(), { id: 'GoAt123', email: 'OWNER@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code })).id, 'goat123');
      assert.equal(access.panel('GOAT123').account.email, 'owner@example.test');
      assert.equal(access.panel('goat123').account.access_hash, '');
      await assert.rejects(() => registration.register(req(), { id: 'other123', email: 'owner@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code }), /邮箱验证码/);
      const second = await send('second@example.test', 'register');
      await assert.rejects(() => registration.register(req(), { id: 'GOAT123', email: 'second@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code: second }), /已被使用/);
      await registration.register(req(), { id: 'other123', email: 'second@example.test', password: 'StrongPassword1', confirmPassword: 'StrongPassword1', code: second });
      assert.throws(() => access.sql.prepare('INSERT INTO panel_accounts(id,email,space_id) VALUES(?,?,?)').run('third123', 'OWNER@EXAMPLE.TEST', 'another'), /UNIQUE/);
    });
    await t.test('ID availability rejects occupied/reserved IDs and weak or mismatched passwords are rejected before registration', async () => {
      assert.equal(registration.availability(req(), 'GOAT123').available, false);
      assert.equal(registration.availability(req(), 'super').available, false);
      assert.equal(registration.availability(req(), 'fresh123').available, true);
      for (const password of ['abcdefgh1', 'ABCDEFGH1', 'Abcdefgh', 'Ab12']) {
        assert.throws(() => access.password(password));
        await assert.rejects(() => registration.register(req(), { id: 'fresh123', email: 'fresh@example.test', password, confirmPassword: password, code: '123456' }));
      }
      await assert.rejects(() => registration.register(req(), { id: 'fresh123', email: 'fresh@example.test', password: 'StrongPassword1', confirmPassword: 'different', code: '123456' }), /两次/);
      assert.equal(db.getSpace('panel', 'fresh123'), undefined);
    });
    await t.test('authorization codes accept any nonempty length and preserve case and long suffixes', async () => {
      for (const value of ['a', '1', '!', 'Abc!123', 'X'.repeat(1000) + '!']) {
        const hash = await access.hashAccessCode(value);
        assert.equal(await access.compareAccessCode(value, hash), true);
        assert.equal(await access.compareAccessCode(value + 'x', hash), false);
      }
      const hash = await access.hashAccessCode('Ab!');
      assert.equal(await access.compareAccessCode('ab!', hash), false);
      const legacy = await access.hash('old-Authorization1');
      assert.equal(await access.compareAccessCode('old-Authorization1', legacy), true);
      await assert.rejects(() => access.hashAccessCode(''));
    });
    await t.test('mail failure leaves no usable code', async () => {
      const original = (registration as any).transport;
      (registration as any).transport = { sendMail: async () => { throw Error('provider failure'); } };
      await assert.rejects(() => send('failed@example.test', 'register'), /邮件发送失败/);
      assert.equal(access.sql.prepare('SELECT * FROM panel_email_codes WHERE email=?').get('failed@example.test'), undefined);
      (registration as any).transport = original;
    });
    await t.test('24-hour gate grants are separate from admin login and revoked on change', async () => {
      await controller.login('goat123', req(), response(admin), { password: 'StrongPassword1' });
      assert.equal(controller.config('goat123', req(admin)).accessEnabled, false);
      await assert.rejects(() => controller.createRoom('goat123', req(), {}), /尚未配置/);
      await controller.update('goat123', req(admin), { agoraAppId: 'a'.repeat(32), agoraAppCertificate: 'b'.repeat(32), accessEnabled: true, accessCode: 'access-code-1' });
      assert.throws(() => controller.rooms('goat123', req()), /授权码/); assert.throws(() => controller.rooms('goat123', req(admin)), /授权码/);
      await assert.rejects(() => controller.unlock('goat123', req(), response(gate), { code: 'wrong' }), /授权码错误/);
      await controller.unlock('goat123', req(), response(gate), { code: 'access-code-1' });
      assert.equal(controller.rooms('goat123', req(gate)).rooms.length, 0);
      const payload = JSON.parse(Buffer.from(gate.panel_gate_goat123.split('.')[0], 'base64url').toString());
      assert.ok(payload.exp > Date.now() + 23 * 3600_000 && payload.exp <= Date.now() + 24 * 3600_000);
      await controller.update('goat123', req(admin), { accessEnabled: true, accessCode: 'access-code-2' });
      assert.throws(() => controller.rooms('goat123', req(gate)), /授权码/);
      await controller.unlock('goat123', req(), response(gate), { code: 'access-code-2' });
      assert.throws(() => access.admin(req(admin), 'other123'), /登录/);
    });
    await t.test('room password enforced at APIs; viewer cannot obtain publisher credentials', async () => {
      publisher = (await controller.createRoom('goat123', req(gate), { title: '私密房间', password: 'room-pass' })).shareLink.split('t=')[1];
      const session = sessions.getByToken(publisher)!; room = access.roomBySession(session.id)!;
      assert.equal(controller.roomAccess(room.view_token, req()).required, true);
      assert.throws(() => authorize(room.view_token), /房间密码/); assert.throws(() => authorize(room.view_token, gate), /房间密码/);
      await assert.rejects(() => controller.unlockRoom(req(), response(viewer), { token: room.view_token, password: 'wrong' }), /房间密码错误/);
      await controller.unlockRoom(req(), response(viewer), { token: room.view_token, password: 'room-pass' });
      const info = share.info(authorize(room.view_token, viewer));
      assert.equal(info.shareLink, ''); assert.ok(!JSON.stringify(info).includes(publisher)); assert.ok(info.viewLink.endsWith(room.view_token));
      for (const path of ['/api/share/start', '/api/share/stop', '/api/share/heartbeat', '/api/share/start/', '/api/share/StArT']) assert.throws(() => authorize(room.view_token, viewer, path), /不能用于/);
      assert.throws(() => authorize(room.view_token, viewer, '/api/share/token', 'publisher'), /不能用于/);
      assert.equal(share.token(authorize(room.view_token, viewer), 'subscriber').appId, 'a'.repeat(32));
      assert.equal(controller.rooms('goat123', req(gate)).rooms.length, 0);
      sessions.startSharing(publisher, 'browser');
      const list = controller.rooms('goat123', req(gate)); assert.equal(list.rooms.length, 1); assert.equal(list.rooms[0].locked, true);
      assert.deepEqual(Object.keys(list.rooms[0]).sort(), ['locked', 'title', 'viewLink', 'viewers']); assert.ok(!JSON.stringify(list).includes(publisher));
      const other: Record<string, string> = {}; await controller.login('other123', req(), response(other), { password: 'StrongPassword1' });
      assert.throws(() => controller.end('other123', room.session_id, req(other)), /不属于/);
    });
    await t.test('super admin APIs and legacy admin routes cannot leak panel secrets or room links', () => {
      const snapshot = JSON.stringify(controller.superList()); assert.ok(snapshot.includes('goat123'));
      for (const secret of ['a'.repeat(32), 'b'.repeat(32), 'access-code-2', '私密房间', publisher, room.view_token, 'password_hash', 'access_hash']) assert.ok(!snapshot.includes(secret));
      for (const action of [() => superAdmin.getSpace('panel', 'goat123'), () => superAdmin.getServer('panel:goat123'), () => superAdmin.getSpaceSessions('panel', 'goat123'), () => superAdmin.getServerSessions('panel:goat123'), () => superAdmin.listServerSessions('panel:goat123'), () => superAdmin.updateServer('panel:goat123', {}), () => superAdmin.deleteServer('panel:goat123'), () => superAdmin.deleteSpace('panel', 'goat123'), () => superAdmin.deleteSession(room.session_id), () => serverAdmin.getConfig({ platform: 'panel', externalId: 'goat123' }), () => serverAdmin.login({ platform: 'panel', externalId: 'goat123' }, { password: 'StrongPassword1' })]) assert.throws(action);
      assert.ok(!JSON.stringify(superAdmin.listAllSessions()).includes(publisher)); assert.ok(!JSON.stringify(superAdmin.listSpaces()).includes('goat123'));
    });
    await t.test('SSE denies missing passwords and publisher escalation; disabling closes all live streams', async () => {
      const sse = new SessionSseController(sessions, bus, analytics, access); sse.onModuleInit();
      const stream = () => Object.assign(new EventEmitter(), { chunks: [] as string[], closed: false, setHeader() {}, flushHeaders() {}, write(s: string) { this.chunks.push(s); }, end() { this.closed = true; this.emit('close'); } });
      const denied = stream(); await sse.stream(room.view_token, 'viewer', '', 'viewer', '', denied as any, req());
      assert.equal(denied.closed, true); assert.match(denied.chunks.join(''), /session_error/);
      const elevated = stream(); await sse.stream(room.view_token, 'publisher', 'attacker', '', '', elevated as any, req(viewer)); assert.equal(elevated.closed, true);
      const viewing = stream(); await sse.stream(room.view_token, 'viewer', '', 'viewer', '', viewing as any, req(viewer));
      const publishing = stream(); await sse.stream(publisher, 'publisher', 'browser', '', '1', publishing as any, req());
      assert.equal(viewing.closed, false); controller.superStatus('goat123', { disabled: true });
      assert.equal(sessions.getByToken(publisher)?.status, 'ended'); assert.equal(viewing.closed, true); assert.equal(publishing.closed, true); assert.match(viewing.chunks.join(''), /session_ended/);
      assert.throws(() => controller.rooms('goat123', req(gate)), /停用/); assert.throws(() => controller.roomAccess(room.view_token, req(viewer)), /停用/);
      await assert.rejects(() => controller.createRoom('goat123', req(gate), {}), /停用/);
      assert.equal(controller.config('goat123', req(admin)).disabled, true);
      await assert.rejects(() => controller.update('goat123', req(admin), { name: 'changed' }), /停用/);
      controller.superStatus('goat123', { disabled: false }); assert.equal(controller.config('goat123', req(admin)).agoraAppId, 'a'.repeat(32));
      assert.throws(() => controller.rooms('goat123', req(gate)), /授权码/); assert.throws(() => controller.roomAccess(room.view_token, req(viewer)), /结束/);
    });
    await t.test('direct viewing remains independent of the gate and optional room passwords default empty', async () => {
      await controller.update('goat123', req(admin), { accessEnabled: false });
      const token = (await controller.createRoom('goat123', req(), {})).shareLink.split('t=')[1];
      const openRoom = access.roomBySession(sessions.getByToken(token)!.id)!;
      assert.ok((FRUIT_SHARER_NAMES as readonly string[]).includes(openRoom.title)); assert.equal(controller.roomAccess(openRoom.view_token, req()).required, false);
      await controller.update('goat123', req(admin), { accessEnabled: true, accessCode: 'new-access-code' });
      assert.equal(controller.roomAccess(openRoom.view_token, req()).required, false); authorize(openRoom.view_token);
      assert.throws(() => controller.rooms('goat123', req()), /授权码/);
    });
    await t.test('room cursor loads every ongoing room without duplicates, even at identical timestamps', async () => {
      await controller.update('goat123', req(admin), { accessEnabled: false });
      access.sql.transaction(() => {
        for (let i = 0; i < 105; i++) {
          const session = sessions.createSession({ platform: 'panel', spaceId: 'panel:goat123', externalSpaceId: 'goat123', externalChannelId: '', sharerUserId: `test-${i}`, sharerUsername: `Room ${i}` });
          access.sql.prepare('INSERT INTO panel_rooms(session_id,panel_id,view_token,title) VALUES(?,?,?,?)').run(session.id, 'goat123', `v_test_${i}`, `Room ${i}`);
          db.updateSession(session.id, { status: 'active', createdAt: 1000 });
        }
      })();
      const seen = new Set<string>(); let cursor: string | undefined; let batches = 0;
      do {
        const result = controller.rooms('goat123', req(), cursor); batches++;
        assert.ok(result.rooms.length <= 50);
        for (const room of result.rooms) { assert.equal(seen.has(room.viewLink), false); seen.add(room.viewLink); }
        cursor = result.nextCursor || undefined;
      } while (cursor);
      assert.equal(seen.size, 105); assert.equal(batches, 3);
      assert.throws(() => controller.rooms('goat123', req(), 'invalid'), /游标/);
    });
    await t.test('password change and email recovery revoke prior logins; codes cannot be reused', async () => {
      await assert.rejects(() => controller.changePassword('goat123', req(admin), { oldPassword: 'wrong', password: 'NewPassword1', confirmPassword: 'NewPassword1' }), /原管理密码/);
      await controller.changePassword('goat123', req(admin), { oldPassword: 'StrongPassword1', password: 'NewPassword1', confirmPassword: 'NewPassword1' });
      assert.throws(() => controller.config('goat123', req(admin)), /登录/);
      await controller.login('goat123', req(), response(admin), { password: 'NewPassword1' });
      (access as any).limits.clear(); const code = await send('owner@example.test', 'recover');
      await registration.recover(req(), { email: 'owner@example.test', password: 'RecoveredPassword1', confirmPassword: 'RecoveredPassword1', code });
      assert.throws(() => controller.config('goat123', req(admin)), /登录/);
      await assert.rejects(() => controller.login('goat123', req(), response(admin), { password: 'NewPassword1' }), /管理密码/);
      await controller.login('goat123', req(), response(admin), { password: 'RecoveredPassword1' });
      assert.equal(controller.config('goat123', req(admin)).email, 'owner@example.test');
      await assert.rejects(() => registration.recover(req(), { email: 'owner@example.test', password: 'AnotherPassword1', confirmPassword: 'AnotherPassword1', code }), /邮箱验证码/);
    });
    await t.test('request limits, tampering and expiry', () => {
      access.limit('test', 1); assert.throws(() => access.limit('test', 1), /频繁/);
      const { space } = access.panel('goat123'), signed = access.sign(space, 'admin');
      assert.equal(access.valid(signed, space, 'admin'), true); assert.equal(access.valid(signed + 'x', space, 'admin'), false); assert.equal(access.valid(signed, space, 'gate'), false);
      const now = Date.now; Date.now = () => now() + 25 * 3600_000;
      try { assert.equal(access.valid(signed, space, 'admin'), false); } finally { Date.now = now; }
    });
  } finally { db.onModuleDestroy(); process.chdir(previous); process.env = env; rmSync(directory, { recursive: true, force: true }); }
});
