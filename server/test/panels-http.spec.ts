import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../src/modules/database/database.module';
import { DatabaseService } from '../src/modules/database/database.service';
import { EventsModule } from '../src/modules/events/events.module';
import { AgoraModule } from '../src/modules/agora/agora.module';
import { SessionModule } from '../src/modules/session/session.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AnalyticsModule } from '../src/modules/analytics/analytics.module';
import { ShareModule } from '../src/modules/share/share.module';
import { PanelsModule } from '../src/modules/panels/panels.module';
import { SuperAdminModule } from '../src/modules/super-admin/super-admin.module';
import { PanelAccessService } from '../src/modules/panels/panel-access.service';
import { PanelRegistrationService } from '../src/modules/panels/panel-registration.service';
import { createHmac } from 'node:crypto';

@Module({ imports: [DatabaseModule, EventsModule, AgoraModule, AnalyticsModule, SessionModule, AuthModule, ShareModule, PanelsModule, SuperAdminModule] })
class PanelTestModule {}

test('HTTP routes enforce cookie scopes, viewer roles, protected list access and super admin guard', async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'panel-http-'));
  const old = process.env.SUPER_ADMIN_PASSWORD; process.env.SUPER_ADMIN_PASSWORD = 'test-super-password'; process.chdir(dir);
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    app = await NestFactory.create(PanelTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const db = app.get(DatabaseService), access = app.get(PanelAccessService);
    const space = db.createSpace({ platform: 'panel', externalId: 'http123', displayName: 'HTTP test', ownerId: '' });
    db.updateServer(space.serverId, { bound: 1, passwordHash: await access.hash('admin-password'), agoraAppId: 'a'.repeat(32), agoraAppCertificate: 'b'.repeat(32) });
    access.sql.prepare('INSERT INTO panel_accounts(id,email,space_id,access_hash) VALUES(?,?,?,?)').run('http123', 'http@example.test', space.serverId, await access.hash('gate-password'));
    const call = (path: string, body?: any, cookie = '', method = body === undefined ? 'GET' : 'POST', authorization = '') => fetch(url + path, { method, headers: { 'content-type': 'application/json', cookie, authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call('/api/panels/http123/rooms')).status, 403);
    assert.equal((await call('/api/panels/http123/admin/config')).status, 401);
    assert.equal((await call('/api/super/panels')).status, 401);
    assert.equal((await call('/api/super/mail-settings')).status, 401);
    assert.equal((await call('/api/super/mail-settings/template')).status, 401);
    assert.equal((await call('/api/super/mail-settings', {}, '', 'PUT')).status, 401);
    assert.equal((await call('/api/super/mail-settings/test', {})).status, 401);
    const challenge = await call('/api/panels/registration/captcha');
    assert.equal(challenge.status, 200); assert.equal(challenge.headers.get('cache-control'), 'no-store');
    assert.match((await challenge.json()).image, /^data:image\/svg\+xml;base64,/);
    const login = await call('/api/panels/http123/admin/login', { password: 'admin-password' });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
    const adminCookie = cookie(login);
    const gateResult = await call('/api/panels/http123/unlock', { code: 'gate-password' });
    assert.equal(gateResult.status, 200); const gateCookie = cookie(gateResult);
    const created = await call('/api/panels/http123/rooms', { title: 'protected', password: 'room-password' }, gateCookie);
    assert.equal(created.status, 200); const publisher = (await created.json()).shareLink.split('t=')[1];
    const session = db.getSessionByToken(publisher)!;
    const room = access.roomBySession(session.id)!;
    assert.equal((await call(`/api/share/token?t=${room.view_token}&role=subscriber`)).status, 403);
    const unlocked = await call('/api/share/room-access', { token: room.view_token, password: 'room-password' });
    assert.equal(unlocked.status, 200); const roomCookie = cookie(unlocked);
    const info = await call(`/api/share/info?t=${room.view_token}`, undefined, roomCookie);
    assert.equal(info.status, 200); assert.ok(!(await info.text()).includes(publisher));
    for (const path of ['/api/share/start', '/api/share/start/', '/api/share/StArT', '/api/share/stop', '/api/share/heartbeat']) assert.equal((await call(path, { token: room.view_token, quality: '1080p_2' }, roomCookie)).status, 403, path);
    assert.equal((await call(`/api/share/token?t=${room.view_token}&role=publisher`, undefined, roomCookie)).status, 403);
    assert.equal((await call('/api/panels/http123/admin/config', undefined, adminCookie)).status, 200);
    assert.equal((await call('/api/share/start', { token: publisher, quality: '1080p_2', clientId: 'http-publisher' })).status, 201);
    assert.equal((await (await call('/api/panels/http123/rooms', undefined, gateCookie)).json()).rooms.length, 1);
    const payload = Buffer.from(JSON.stringify({ role: 'super_admin', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const auth = 'Bearer ' + payload + '.' + createHmac('sha256', process.env.SUPER_ADMIN_PASSWORD!).update(payload).digest('base64url');
    const mail = await call('/api/super/mail-settings', { host: 'smtp.example.test', port: 465, secure: true, user: 'test', password: 'smtp-test-secret', from: 'test@example.test' }, '', 'PUT', auth);
    assert.equal(mail.status, 200); assert.ok(!(await mail.text()).includes('smtp-test-secret'));
    const mailRead = await call('/api/super/mail-settings', undefined, '', 'GET', auth);
    assert.equal(mailRead.status, 200); assert.ok(!(await mailRead.text()).includes('smtp-test-secret'));
    const template = await call('/api/super/mail-settings/template', undefined, '', 'GET', auth);
    assert.equal(template.status, 200);
    const templateBody = await template.json();
    assert.match(templateBody.html, /{{code}}/); assert.doesNotMatch(templateBody.html, /{{scene}}/);
    assert.match(templateBody.preview, /286419/); assert.doesNotMatch(templateBody.preview, /{{/);
    access.sql.prepare("DELETE FROM global_config WHERE key='smtpSettings'").run();
    const list = await call('/api/super/panels', undefined, '', 'GET', auth); assert.equal(list.status, 200);
    const listBody = await list.text(); assert.ok(!listBody.includes(publisher)); assert.ok(!listBody.includes('a'.repeat(32))); assert.ok(!listBody.includes('protected'));
    assert.equal((await call('/api/super/panels/http123/status', { disabled: true }, '', 'PUT', auth)).status, 200);
    assert.equal((await call(`/api/share/info?t=${publisher}`)).status, 401);
    assert.equal((await call('/api/panels/http123/admin/config', undefined, adminCookie)).status, 200);
    assert.equal((await call('/api/panels/http123/rooms', undefined, gateCookie)).status, 403);
    assert.equal(app.get(PanelRegistrationService).mailReady(), !!(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_USER && process.env.SMTP_PASS));
  } finally { await app?.close(); process.chdir(cwd); if (old === undefined) delete process.env.SUPER_ADMIN_PASSWORD; else process.env.SUPER_ADMIN_PASSWORD = old; rmSync(dir, { recursive: true, force: true }); }
});

test('panel config save sanitizes legacy quality keys, clamps timeouts and ignores super-only fields', async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'panel-config-'));
  const old = process.env.SUPER_ADMIN_PASSWORD; process.env.SUPER_ADMIN_PASSWORD = 'test-super-password'; process.chdir(dir);
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    app = await NestFactory.create(PanelTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const db = app.get(DatabaseService), access = app.get(PanelAccessService);
    const space = db.createSpace({ platform: 'panel', externalId: 'cfg123', displayName: 'Cfg test', ownerId: '' });
    db.updateServer(space.serverId, { bound: 1, passwordHash: await access.hash('admin-password') });
    access.sql.prepare('INSERT INTO panel_accounts(id,email,space_id,access_hash) VALUES(?,?,?,?)').run('cfg123', 'cfg@example.test', space.serverId, '');
    // 模拟历史数据：包含已被重命名的旧画质 key
    db.updateServer(space.serverId, { allowedQualities: '["540p30","720p30","1080p30","1080p60","1440p30","1440p60","4k30"]' });
    const call = (path: string, body?: any, cookie = '', method = body === undefined ? 'GET' : 'POST', authorization = '') => fetch(url + path, { method, headers: { 'content-type': 'application/json', cookie, authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];
    const login = await call('/api/panels/cfg123/admin/login', { password: 'admin-password' });
    assert.equal(login.status, 200);
    const adminCookie = cookie(login);

    // 页面提交“旧 key + 当前全选”的画质列表：应保存成功并清洗为有效 key（修复“至少选择一个有效画质”误报）
    const saved = await call('/api/panels/cfg123/admin/config', {
      name: 'Cfg test', agoraAppId: '', allowedQualities: ['540p30', '720p30', '1080p30', '1080p60', '1440p30', '1440p60', '4k30', '480p_2', '1080p_2'],
      idleTimeoutSec: 60, noViewerTimeoutSec: 180, allowLowLatency: true, allowQualityPreference: true, accessEnabled: false,
    }, adminCookie, 'PUT');
    assert.equal(saved.status, 200, await saved.text());
    const cleaned = JSON.parse(db.getServer(space.serverId)!.allowedQualities);
    assert.deepEqual([...cleaned].sort(), ['1080p_2', '1080p60', '1440p30', '1440p60', '480p_2', '4k30', '720p30'].sort());

    // 超时数值钳制到 10～600，而不是拒绝
    await call('/api/panels/cfg123/admin/config', { idleTimeoutSec: 9999, noViewerTimeoutSec: 1 }, adminCookie, 'PUT');
    const afterClamp = db.getServer(space.serverId)!;
    assert.equal(afterClamp.idleTimeoutSec, 600);
    assert.equal(afterClamp.noViewerTimeoutSec, 10);

    // 心跳间隔与声网令牌有效期由超管设置：面板管理员的提交被忽略
    const before = db.getServer(space.serverId)!;
    await call('/api/panels/cfg123/admin/config', { heartbeatIntervalSec: 1, agoraTokenExpireSec: 999999 }, adminCookie, 'PUT');
    const afterIgnore = db.getServer(space.serverId)!;
    assert.equal(afterIgnore.heartbeatIntervalSec, before.heartbeatIntervalSec);
    assert.equal(afterIgnore.agoraTokenExpireSec, before.agoraTokenExpireSec);

    // 空画质列表回退为全部画质，不再报“至少选择一个有效画质”
    await call('/api/panels/cfg123/admin/config', { allowedQualities: [] }, adminCookie, 'PUT');
    const emptied = JSON.parse(db.getServer(space.serverId)!.allowedQualities);
    assert.equal(emptied.length, 7);

    // 超管仍可设置心跳与令牌有效期，且被钳制到合理边界
    const payload = Buffer.from(JSON.stringify({ role: 'super_admin', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const auth = 'Bearer ' + payload + '.' + createHmac('sha256', process.env.SUPER_ADMIN_PASSWORD!).update(payload).digest('base64url');
    const kook = db.createSpace({ platform: 'kook', externalId: '999111', spaceId: '999111', displayName: 'Kook cfg', ownerId: 'u1' });
    const superSave = await call(`/api/super/servers/${kook.serverId}`, { heartbeatIntervalSec: 1, agoraTokenExpireSec: 999999 }, '', 'PUT', auth);
    assert.equal(superSave.status, 200, await superSave.text());
    const kookRow = db.getServer(kook.serverId)!;
    assert.equal(kookRow.heartbeatIntervalSec, 2);
    assert.equal(kookRow.agoraTokenExpireSec, 86400);
  } finally { await app?.close(); process.chdir(cwd); if (old === undefined) delete process.env.SUPER_ADMIN_PASSWORD; else process.env.SUPER_ADMIN_PASSWORD = old; rmSync(dir, { recursive: true, force: true }); }
});
