import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, sign } from 'node:crypto';
import { DatabaseService } from '../src/modules/database/database.service';
import { QqRepository, qqHash } from '../src/modules/qq/qq.repository';
import { qqChallenge, qqCommand, qqSigningKey, verifyQqSignature } from '../src/modules/qq/qq-protocol';
import { QqService } from '../src/modules/qq/qq.service';
import { QqBindingController, QqWebhookController } from '../src/modules/qq/qq.controller';
import { QqApiError, QqApiService } from '../src/modules/qq/qq-api.service';
import { SessionService } from '../src/modules/session/session.service';
import { EventBusService } from '../src/modules/events/events.service';

test('QQ signature matches the official vector and rejects tampering/replay', () => {
  const secret = 'naOC0ocQE3shWLAfffVLB1rhYPG7';
  const raw = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
  const key = qqSigningKey(secret);
  assert.deepEqual([...createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)],
    [215,195,98,254,120,174,248,31,242,50,135,180,147,98,139,93,176,42,60,79,227,11,33,94,77,25,96,155,93,118,103,58]);
  const signature = sign(null, Buffer.concat([Buffer.from('1725442341'), raw]), key).toString('hex');
  const at = 1725442341000;
  assert.equal(verifyQqSignature(secret, raw, '1725442341', signature, at), true);
  assert.equal(verifyQqSignature(secret, Buffer.from('{}'), '1725442341', signature, at), false);
  assert.equal(verifyQqSignature(secret, raw, '1725442341', signature, at + 600_000), false);
  assert.equal(verifyQqSignature(secret, raw, '1725442341', 'bad', at), false);
  assert.deepEqual(qqChallenge('DG5g3B4j9X2KOErG', { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' }), {
    plain_token: 'Arq0D5A61EgUu4OxUvOp',
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  });
});

test('QQ only recognizes exact commands and device codes', () => {
  assert.equal(qqCommand('管理')?.name, 'manage');
  assert.equal(qqCommand(' <@12345> /屏幕共享 ')?.name, 'share');
  assert.equal(qqCommand('管理 abcd2345')?.code, 'ABCD2345');
  assert.equal(qqCommand('ABCD2345')?.name, 'bind');
  assert.equal(qqCommand('今天谁来管理？'), undefined);
  assert.equal(qqCommand('屏幕共享测试'), undefined);
});

test('QQ device binding, webhook deduplication and share lifecycle', async t => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'xgoat-qq-'));
  process.chdir(dir);
  const db = new DatabaseService();
  const repo = new QqRepository(db);
  db.setGlobalConfig('publicDomain', 'https://share.example.test');
  const analytics: any = { recordServerEvent() {}, recordShareCreated() {}, recordShareEnded() {}, recordSessionTransition() {} };
  const sessions = new SessionService(db, { generateChannelName: (id: string) => `test-${id}` } as any, new EventBusService(), analytics);
  const api: any = { configured: true, appId: '1234', secret: 'test-secret', memberRole: async () => '' };
  const sent: any[] = [];
  api.request = async (_path: string, _method: string, body: unknown) => { sent.push(body); return { id: `message-${sent.length}` }; };
  const service = new QqService(db, repo, api, sessions, { register() {}, unregister() {} } as any, analytics);
  let sequence = 0;
  const message = (group: string, text: string, role = 'admin', user = 'admin-user') => ({ op: 0,
    t: 'GROUP_MESSAGE_CREATE', d: { group_openid: group, id: `incoming-${++sequence}`, timestamp: new Date().toISOString(),
      content: text, author: { member_openid: user, member_role: role, username: 'QQ member' } } });
  const createSpace = (group: string) => db.createSpace({ platform: 'qq', externalId: group, displayName: 'QQ test', ownerId: '' });
  try {
    await t.test('admin binds only the verified browser; ordinary members and cross-group codes fail', () => {
      createSpace('bind'); createSpace('other');
      const intent = repo.intent('bind')!;
      const a = repo.claim('bind', intent, qqHash('a'));
      const b = repo.claim('bind', intent, qqHash('b'));
      assert.ok(a && b);
      assert.equal(repo.authorize('bind', b.code, 'member', 'member'), false);
      assert.equal(repo.authorize('other', b.code, 'admin', 'admin'), false);
      assert.equal(repo.authorize('bind', b.code, 'admin', 'admin'), true);
      assert.equal(repo.getClaim('bind', intent, a.id, qqHash('a')).state, 'revoked');
      assert.equal(repo.consume('bind', intent, b.id, qqHash('wrong'), 'password-hash'), false);
      assert.equal(repo.consume('bind', intent, b.id, qqHash('b'), 'password-hash'), true);
      assert.equal(repo.consume('bind', intent, b.id, qqHash('b'), 'password-hash'), false);
      assert.equal(db.getSpace('qq', 'bind')?.bound, 1);
      assert.equal(db.getSpace('qq', 'other')?.bound, 0);
    });
    await t.test('expiration, rotation and removal revoke browser claims', () => {
      const space = createSpace('epoch');
      const intent = repo.intent('epoch')!;
      const claim = repo.claim('epoch', intent, qqHash('device'));
      assert.equal(repo.authorize('epoch', claim.code, 'owner', 'owner'), true);
      db.updateServer(space.serverId, { serverSecret: 'new-epoch' });
      assert.equal(repo.consume('epoch', intent, claim.id, qqHash('device'), 'hash'), false);
      const next = repo.intent('epoch')!;
      const expired = repo.claim('epoch', next, qqHash('expired'));
      db.integrationDatabase.prepare('UPDATE qq_binding_claims SET expires_at=1 WHERE id=?').run(expired.id);
      assert.equal(repo.authorize('epoch', expired.code, 'owner', 'owner'), false);
      repo.revoke('epoch');
      assert.equal(repo.getIntent('epoch', next), undefined);
      assert.equal(db.getSpace('qq', 'epoch')?.status, 'kicked');
    });
    await t.test('unrelated conversations are not stored; all/@ twin events execute once', async () => {
      service.accept(message('chat', 'a private conversation'));
      assert.equal(repo.dueEvents().length, 0);
      const event = message('commands', '管理');
      service.accept(event); service.accept(event); service.accept({ ...event, t: 'GROUP_AT_MESSAGE_CREATE' });
      assert.equal(repo.dueEvents().length, 1);
      await service.processEvents();
      assert.equal(repo.dueEvents().length, 0);
      const rows = db.integrationDatabase.prepare('SELECT * FROM qq_events').all() as any[];
      assert.equal(rows.length, 1); assert.equal(rows[0].payload, '{}');
      assert.equal(repo.dueDeliveries().length, 1);
      await service.deliver();
      assert.equal(sent.length, 1);
      assert.match(sent[0].markdown.content, /spaces\/qq\/commands\?bind=/);
    });
    await t.test('missing/ordinary role does not create a binding intent', async () => {
      service.accept(message('no-role', '管理', ''));
      service.accept(message('member-role', '管理', 'member'));
      await service.processEvents();
      for (const group of ['no-role', 'member-role']) {
        assert.equal(db.integrationDatabase.prepare('SELECT COUNT(*) AS n FROM qq_binding_intents WHERE space_id=?').get(`qq:${group}`).n, 0);
      }
      for (const row of repo.dueDeliveries()) repo.finishDelivery(row.key);
    });
    await t.test('a command creates one session and passive notifications keep distinct sequences', async () => {
      const space = createSpace('share');
      db.updateServer(space.serverId, { bound: 1, agoraAppId: 'agora', agoraAppCertificate: 'cert' });
      const event = message('share', '屏幕共享', 'member', 'sharer');
      service.accept(event); service.accept(event);
      await service.processEvents();
      const active = db.getActiveSessionsByPlatformUser('qq', 'sharer');
      assert.equal(active.length, 1);
      await service.deliver();
      assert.match(sent.at(-1).markdown.content, /share\?t=/);
      const session = sessions.getById(active[0].id)!;
      await service.onSessionStarted({ platform: 'qq', sessionId: session.id, spaceId: space.serverId,
        externalSpaceId: 'share', externalChannelId: 'share', token: session.token, sharerUsername: 'test' });
      const job = repo.dueDeliveries().map(r => JSON.parse(r.payload)).find(r => r.kind === 'start');
      assert.equal(job.body.msg_id, event.d.id); assert.equal(job.body.msg_seq, 2);
      assert.match(job.body.markdown.content, /view\?t=/);
    });
    await t.test('transaction rollback cannot leave a duplicate orphan session', async () => {
      createSpace('rollback');
      const event = message('rollback', '帮助');
      repo.enqueue(event, 'rollback-key');
      assert.throws(() => repo.processEvent('rollback-key', () => {
        sessions.createSession({ platform: 'qq', spaceId: 'qq:rollback', externalSpaceId: 'rollback',
          externalChannelId: 'rollback', sharerUserId: 'rollback-user', sharerUsername: '' });
        throw new Error('fail');
      }));
      assert.equal(db.getActiveSessionsByPlatformUser('qq', 'rollback-user').length, 0);
      repo.processEvent('rollback-key', () => {});
    });
    await t.test('removal tombstone prevents message-driven resurrection even for an unknown group', async () => {
      service.accept({ op: 0, id: 'remove', t: 'GROUP_DEL_ROBOT', d: { group_openid: 'removed', timestamp: Math.floor(Date.now() / 1000) } });
      service.accept(message('removed', '管理'));
      await service.processEvents();
      assert.equal(db.getSpace('qq', 'removed'), undefined);
    });
    await t.test('webhook handshake is separate; business events require matching app and signed raw bytes', () => {
      const controller = new QqWebhookController(api, service, repo);
      const now = String(Math.floor(Date.now() / 1000));
      const request = (body: Buffer, headers: Record<string, string>) => ({ body, header: (key: string) => headers[key] }) as any;
      const event = message('signed', '帮助');
      const body = Buffer.from(JSON.stringify(event));
      const signature = sign(null, Buffer.concat([Buffer.from(now), body]), qqSigningKey(api.secret)).toString('hex');
      const headers = { 'x-bot-appid': api.appId, 'x-signature-timestamp': now, 'x-signature-ed25519': signature };
      assert.deepEqual(controller.receive(request(body, headers)), { op: 12 });
      assert.throws(() => controller.receive(request(Buffer.from('{}'), headers)));
      assert.throws(() => controller.receive(request(body, { ...headers, 'x-bot-appid': 'wrong' })));
      assert.throws(() => controller.receive(request(body, { 'x-bot-appid': api.appId })));
      const challengeBody = Buffer.from(JSON.stringify({ op: 13, d: { plain_token: 'challenge', event_ts: now } }));
      const challengeSignature = sign(null, Buffer.concat([Buffer.from(now), challengeBody]), qqSigningKey(api.secret)).toString('hex');
      assert.throws(() => controller.receive(request(challengeBody, { 'x-bot-appid': api.appId })));
      const challenge = controller.receive(request(challengeBody, { ...headers, 'x-signature-ed25519': challengeSignature })) as any;
      assert.equal(challenge.plain_token, 'challenge');
    });
    await t.test('cookie binds the browser; public URL alone cannot consume authorization', () => {
      createSpace('cookie');
      const intent = repo.intent('cookie')!;
      const controller = new QqBindingController(repo, db, analytics);
      let cookie = '';
      const res: any = { cookie(name: string, value: string, opts: any) {
        assert.equal(opts.httpOnly, true); assert.equal(opts.secure, true); assert.equal(opts.sameSite, 'strict');
        assert.match(opts.path, /spaces\/qq\/cookie\/binding/); cookie = `${name}=${value}`;
      }, clearCookie() {} };
      const claim = controller.claim('cookie', intent, { headers: {} } as any, res) as any;
      repo.authorize('cookie', claim.code, 'admin', 'admin');
      assert.equal(controller.bind('cookie', intent, { password: 'password123' }, { headers: {} } as any, res).ok, false);
      assert.equal(controller.bind('cookie', intent, { password: 'password123' }, { headers: { cookie } } as any, res).ok, true);
    });
    await t.test('uncertain proactive sends are not replayed, while passive retries retain their sequence', async () => {
      for (const row of repo.dueDeliveries()) repo.finishDelivery(row.key);
      createSpace('proactive'); createSpace('passive');
      repo.queue({ key: 'proactive', group: 'proactive', body: { msg_type: 0, content: 'status' } });
      api.request = async () => { throw new QqApiError(0, 0, true); };
      await service.deliver();
      const first = db.integrationDatabase.prepare('SELECT * FROM qq_outbox WHERE key=?').get('proactive') as any;
      assert.equal(first.state, 'uncertain');
      const passive = { key: 'passive', group: 'passive', body: { msg_type: 0, content: 'reply', msg_id: 'source', msg_seq: 2 }, replyUntil: Date.now() + 200_000 };
      repo.queue(passive); await service.deliver();
      const second = db.integrationDatabase.prepare('SELECT * FROM qq_outbox WHERE key=?').get('passive') as any;
      assert.equal(second.state, 'pending');
      assert.equal(JSON.parse(second.payload).body.msg_seq, 2);
      repo.beginDelivery(passive);
      repo.queue({ key: 'interrupted', group: 'proactive', body: { msg_type: 0, content: 'test' } });
      repo.beginDelivery({ key: 'interrupted', group: 'proactive', body: { msg_type: 0, content: 'test' } });
      new QqRepository(db);
      assert.equal((db.integrationDatabase.prepare('SELECT state FROM qq_outbox WHERE key=?').get('interrupted') as any).state, 'uncertain');
      assert.equal((db.integrationDatabase.prepare('SELECT state FROM qq_outbox WHERE key=?').get('passive') as any).state, 'pending');
      repo.finishDelivery('passive');
    });
    await t.test('Markdown denial falls back only after explicit rejection; URL denial gives a plain explanation', async () => {
      createSpace('markdown'); createSpace('link-denied');
      repo.queue({ key: 'markdown', group: 'markdown', body: { msg_type: 2, markdown: { content: '[管理](https://example.test)' }, msg_id: 'm', msg_seq: 1 }, replyUntil: Date.now() + 100_000 });
      api.request = async () => { throw new QqApiError(400, 304036); };
      await service.deliver();
      const row = db.integrationDatabase.prepare('SELECT * FROM qq_outbox WHERE key=?').get('markdown') as any;
      assert.equal(row.state, 'pending');
      assert.equal(JSON.parse(row.payload).body.content, '管理：https://example.test');
      assert.equal(JSON.parse(row.payload).body.markdown, undefined);
      repo.finishDelivery('markdown');
      repo.queue({ key: 'link-denied', group: 'link-denied', body: { msg_type: 0, content: 'https://example.test', msg_id: 'l', msg_seq: 1 }, replyUntil: Date.now() + 100_000 });
      api.request = async () => { throw new QqApiError(400, 40054010); };
      await service.deliver();
      assert.ok(repo.dueDeliveries().find(r => r.key === 'link-denied:link-error'));
    });
  } finally { service.onModuleDestroy(); db.onModuleDestroy(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});

test('QQ access token refresh is shared and 401 retries once', async () => {
  const oldFetch = global.fetch;
  const oldId = process.env.QQ_APP_ID; const oldSecret = process.env.QQ_APP_SECRET;
  process.env.QQ_APP_ID = 'test'; process.env.QQ_APP_SECRET = 'test';
  let refreshes = 0; let calls = 0;
  global.fetch = (async (url: any) => {
    if (String(url).includes('getAppAccessToken')) { refreshes++; return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 })); }
    calls++; return new Response(JSON.stringify(calls === 1 ? { code: 1 } : { id: 'bot' }), { status: calls === 1 ? 401 : 200 });
  }) as any;
  try { const api = new QqApiService(); const results = await Promise.all([api.request('/users/@me'), api.request('/users/@me')]);
    assert.equal(results.length, 2); assert.equal(refreshes, 2); assert.equal(calls, 3);
  } finally { global.fetch = oldFetch;
    if (oldId === undefined) delete process.env.QQ_APP_ID; else process.env.QQ_APP_ID = oldId;
    if (oldSecret === undefined) delete process.env.QQ_APP_SECRET; else process.env.QQ_APP_SECRET = oldSecret;
  }
});
