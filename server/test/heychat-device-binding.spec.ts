import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validate } from 'class-validator';
import { DatabaseService } from '../src/modules/database/database.service';
import { BindServerDto } from '../src/modules/server-admin/server-admin.dto';
import { ServerAdminController } from '../src/modules/server-admin/server-admin.controller';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createHeychatSpace(db: DatabaseService, roomId: string, ownerId: string) {
  return db.createSpace({
    platform: 'heychat',
    externalId: roomId,
    displayName: `Room ${roomId}`,
    ownerId,
  });
}

test('Heychat device binding is browser-bound, one-time, and revocable', async (t) => {
  const previousCwd = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'xgoatcast-heychat-device-bind-'));
  process.chdir(fixtureRoot);
  const db = new DatabaseService();
  try {
    await t.test('one public intent supports independent claims and authorizes exactly one', () => {
      const roomId = 'room-multi-claim';
      const ownerId = 'owner-multi-claim';
      createHeychatSpace(db, roomId, ownerId);
      const intent = db.createHeychatBindingIntent(roomId);
      assert.ok(intent);

      const firstSecret = digest('first-browser-secret');
      const secondSecret = digest('second-browser-secret');
      const first = db.createHeychatBindingClaim(roomId, intent.intentId, firstSecret);
      const second = db.createHeychatBindingClaim(roomId, intent.intentId, secondSecret);
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.claimId, second.claimId);
      assert.notEqual(first.code, second.code);
      assert.match(first.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);

      assert.equal(
        db.getHeychatBindingClaim(roomId, intent.intentId, first.claimId, digest('wrong')),
        undefined,
      );
      assert.equal(db.authorizeHeychatBindingClaim(roomId, second.code, 'not-owner'), undefined);
      const authorized = db.authorizeHeychatBindingClaim(roomId, second.code, ownerId);
      assert.equal(authorized?.claimId, second.claimId);
      assert.equal(authorized?.state, 'authorized');
      assert.equal(
        db.getHeychatBindingClaim(roomId, intent.intentId, first.claimId, firstSecret)?.state,
        'revoked',
      );

      assert.equal(
        db.consumeHeychatBindingClaim(
          roomId,
          intent.intentId,
          first.claimId,
          firstSecret,
          'hash-for-revoked-claim',
        ),
        undefined,
      );
      assert.equal(
        db.consumeHeychatBindingClaim(
          roomId,
          intent.intentId,
          second.claimId,
          digest('wrong'),
          'hash-for-wrong-browser',
        ),
        undefined,
      );

      db.generateBindToken(intent.spaceId);
      const bound = db.consumeHeychatBindingClaim(
        roomId,
        intent.intentId,
        second.claimId,
        secondSecret,
        'device-password-hash',
      );
      assert.equal(bound?.platform, 'heychat');
      assert.equal(bound?.status, 'active');
      assert.equal(bound?.bound, 1);
      assert.equal(bound?.passwordHash, 'device-password-hash');
      assert.equal(bound?.bindToken, '');
      assert.equal(db.getHeychatBindingIntent(roomId, intent.intentId), undefined);
      assert.equal(
        db.consumeHeychatBindingClaim(
          roomId,
          intent.intentId,
          second.claimId,
          secondSecret,
          'second-password-hash',
        ),
        undefined,
      );
    });

    await t.test('KOOK, kicked, and already-bound spaces cannot enter device binding', () => {
      db.createSpace({
        platform: 'kook',
        externalId: 'kook-room',
        spaceId: 'kook-room',
        displayName: 'KOOK room',
        ownerId: 'kook-owner',
      });
      assert.equal(db.createHeychatBindingIntent('kook-room'), undefined);

      const kicked = createHeychatSpace(db, 'room-kicked', 'owner-kicked');
      db.kickServer(kicked.serverId);
      assert.equal(db.createHeychatBindingIntent(kicked.externalId), undefined);

      const bound = createHeychatSpace(db, 'room-bound', 'owner-bound');
      db.updateServer(bound.serverId, { bound: 1, passwordHash: 'existing' });
      assert.equal(db.createHeychatBindingIntent(bound.externalId), undefined);
    });

    await t.test('legacy URL tokens remain KOOK-only and cannot bypass Heychat claims', () => {
      const analytics = {
        recordServerEvent() {},
      } as any;
      const controller = new ServerAdminController(db, analytics);
      const heychat = createHeychatSpace(db, 'room-no-token-bypass', 'owner-no-token-bypass');
      const oldHeychatToken = db.generateBindToken(heychat.serverId);
      const intent = db.createHeychatBindingIntent(heychat.externalId)!;
      assert.equal(db.getServer(heychat.serverId)?.bindToken, '');
      assert.deepEqual(
        controller.bindServer(
          { platform: 'heychat', externalId: heychat.externalId },
          { password: 'password-eight', token: oldHeychatToken },
        ),
        { ok: false, message: '该平台必须使用设备验证码完成绑定' },
      );
      assert.equal(db.getHeychatBindingIntent(heychat.externalId, intent.intentId)?.state, 'active');
      assert.equal(db.getServer(heychat.serverId)?.bound, 0);

      const kook = db.createSpace({
        platform: 'kook',
        externalId: 'kook-token-bind',
        spaceId: 'kook-token-bind',
        displayName: 'KOOK token bind',
        ownerId: 'kook-token-owner',
      });
      const kookToken = db.generateBindToken(kook.serverId);
      assert.equal(
        controller.bindServer(
          { platform: 'kook', externalId: kook.externalId },
          { password: 'password-eight', token: kookToken },
        ).ok,
        true,
      );
      assert.equal(db.getServer(kook.serverId)?.bound, 1);
    });

    await t.test('authoritative exit clears claims and token and rotates the admin key', () => {
      const space = createHeychatSpace(db, 'room-exit', 'owner-exit');
      const intent = db.createHeychatBindingIntent(space.externalId)!;
      const secretHash = digest('exit-browser');
      const claim = db.createHeychatBindingClaim(space.externalId, intent.intentId, secretHash)!;
      db.generateBindToken(space.serverId);
      const before = db.getServer(space.serverId)!;

      db.kickServer(space.serverId);
      const after = db.getServer(space.serverId)!;
      assert.equal(after.status, 'kicked');
      assert.equal(after.bound, 0);
      assert.equal(after.passwordHash, '');
      assert.equal(after.bindToken, '');
      assert.notEqual(after.serverSecret, before.serverSecret);
      assert.equal(db.getHeychatBindingIntent(space.externalId, intent.intentId), undefined);
      assert.equal(
        db.getHeychatBindingClaim(space.externalId, intent.intentId, claim.claimId, secretHash),
        undefined,
      );
    });

    await t.test('Heychat reentry never restores a credential epoch preserved by reconciliation', () => {
      const space = createHeychatSpace(db, 'room-reentry', 'owner-reentry');
      const intent = db.createHeychatBindingIntent(space.externalId)!;
      db.createHeychatBindingClaim(
        space.externalId,
        intent.intentId,
        digest('reentry-browser'),
      );
      db.updateServer(space.serverId, { bound: 1, passwordHash: 'preserved-password' });
      db.generateBindToken(space.serverId);
      const before = db.getServer(space.serverId)!;
      assert.equal(db.markServerAbsentPreservingBinding(space.serverId), true);

      const rejoined = createHeychatSpace(db, space.externalId, space.ownerId);
      assert.equal(rejoined.status, 'active');
      assert.equal(rejoined.bound, 0);
      assert.equal(rejoined.passwordHash, '');
      assert.equal(rejoined.bindToken, '');
      assert.notEqual(rejoined.serverSecret, before.serverSecret);
      assert.equal(db.getHeychatBindingIntent(space.externalId, intent.intentId), undefined);
    });

    await t.test('KOOK owner changes and kicks retain their existing token and key lifecycle', () => {
      const space = db.createSpace({
        platform: 'kook',
        externalId: 'kook-compatibility',
        spaceId: 'kook-compatibility',
        displayName: 'KOOK compatibility',
        ownerId: 'kook-owner-before',
      });
      db.updateServer(space.serverId, { bound: 1, passwordHash: 'kook-password' });
      const token = db.generateBindToken(space.serverId);
      const before = db.getServer(space.serverId)!;

      db.updateServer(space.serverId, { ownerId: 'kook-owner-after' });
      const ownerChanged = db.getServer(space.serverId)!;
      assert.equal(ownerChanged.bound, 1);
      assert.equal(ownerChanged.passwordHash, 'kook-password');
      assert.equal(ownerChanged.bindToken, token);
      assert.equal(ownerChanged.serverSecret, before.serverSecret);

      db.kickServer(space.serverId);
      const kicked = db.getServer(space.serverId)!;
      assert.equal(kicked.status, 'kicked');
      assert.equal(kicked.bound, 0);
      assert.equal(kicked.passwordHash, '');
      assert.equal(kicked.bindToken, token);
      assert.equal(kicked.serverSecret, before.serverSecret);
    });

    await t.test('owner epoch changes revoke binding, claims, token, and old JWT key', () => {
      const space = createHeychatSpace(db, 'room-owner-change', 'owner-before');
      const intent = db.createHeychatBindingIntent(space.externalId)!;
      db.createHeychatBindingClaim(
        space.externalId,
        intent.intentId,
        digest('owner-change-browser'),
      );
      db.generateBindToken(space.serverId);
      db.updateServer(space.serverId, { bound: 1, passwordHash: 'old-password-hash' });
      const before = db.getServer(space.serverId)!;

      db.updateServer(space.serverId, { ownerId: 'owner-after' });
      const after = db.getServer(space.serverId)!;
      assert.equal(after.ownerId, 'owner-after');
      assert.equal(after.bound, 0);
      assert.equal(after.passwordHash, '');
      assert.equal(after.bindToken, '');
      assert.notEqual(after.serverSecret, before.serverSecret);
      assert.equal(db.getHeychatBindingIntent(space.externalId, intent.intentId), undefined);
    });

    await t.test('controller exposes no raw secret and binds only the cookie-owning browser', () => {
      const roomId = 'room-controller';
      const ownerId = 'owner-controller';
      createHeychatSpace(db, roomId, ownerId);
      const intent = db.createHeychatBindingIntent(roomId)!;
      const analyticsEvents: any[] = [];
      const controller = new ServerAdminController(db, {
        recordServerEvent(event: any) {
          analyticsEvents.push(event);
        },
      } as any);
      let cookie: { name: string; value: string; options: any } | undefined;
      let cleared = false;
      const response = {
        cookie(name: string, value: string, options: any) {
          cookie = { name, value, options };
        },
        clearCookie() {
          cleared = true;
        },
      } as any;

      assert.equal(
        controller.getHeychatBindingIntentStatus(roomId, intent.intentId).state,
        'active',
      );
      const claimed = controller.claimHeychatBindingIntent(
        roomId,
        intent.intentId,
        { headers: {} } as any,
        response,
      );
      assert.equal(claimed.ok, true);
      assert.equal(claimed.state, 'pending');
      assert.match(String(claimed.code), /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
      assert.ok(cookie);
      assert.equal(cookie.options.httpOnly, true);
      assert.equal(cookie.options.secure, true);
      assert.equal(cookie.options.sameSite, 'strict');
      assert.match(cookie.options.path, new RegExp(`/binding/${intent.intentId}$`));
      assert.equal('secret' in claimed, false);
      assert.equal('claimId' in claimed, false);

      const [claimId, rawSecret] = cookie.value.split('.');
      assert.equal(Buffer.from(rawSecret, 'base64url').length, 32);
      const stored = (db as any).db.prepare(
        'SELECT secret_hash FROM heychat_binding_claims WHERE claim_id = ?',
      ).get(claimId) as { secret_hash: string };
      assert.equal(stored.secret_hash, digest(rawSecret));
      assert.notEqual(stored.secret_hash, rawSecret);

      const request = {
        headers: { cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}` },
      } as any;
      assert.equal(controller.pollHeychatBindingClaim(roomId, intent.intentId, request).state, 'pending');
      assert.ok(db.authorizeHeychatBindingClaim(roomId, String(claimed.code), ownerId));
      assert.equal(
        controller.pollHeychatBindingClaim(roomId, intent.intentId, request).state,
        'authorized',
      );
      assert.deepEqual(
        controller.pollHeychatBindingClaim(
          roomId,
          intent.intentId,
          { headers: { cookie: `${cookie.name}=invalid.invalid` } } as any,
        ),
        { ok: false, state: 'unavailable' },
      );

      const result = controller.bindHeychatClaim(
        roomId,
        intent.intentId,
        { password: 'password-eight' },
        request,
        response,
      );
      assert.equal(result.ok, true);
      assert.equal(cleared, true);
      assert.equal(db.getSpace('heychat', roomId)?.bound, 1);
      assert.equal(analyticsEvents.length, 1);
    });

    await t.test('binding DTO rejects passwords shorter than eight characters', async () => {
      const tooShort = Object.assign(new BindServerDto(), { password: '1234567' });
      const valid = Object.assign(new BindServerDto(), { password: '12345678' });
      assert.ok((await validate(tooShort)).length > 0);
      assert.equal((await validate(valid)).length, 0);
    });

    await t.test('explicit Heychat bot ID is persisted independently of its token', () => {
      assert.equal(db.getGlobalConfig().heychatBotId, '');
      db.setGlobalConfig('heychatBotId', '103252254');
      assert.equal(db.getGlobalConfig().heychatBotId, '103252254');
    });

    await t.test('main auth gate keeps device endpoints public but rejects inactive space admins', () => {
      const source = readFileSync(join(previousCwd, 'src', 'main.ts'), 'utf8');
      assert.match(source, /binding\\\/\[\^\/\]\+\\\/\(status\|claim\|poll\|bind\)/);
      assert.match(source, /server\.status !== 'active' \|\| !server\.bound/);
    });
  } finally {
    db.onModuleDestroy();
    process.chdir(previousCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
