import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerRecord } from '../src/modules/database/database.service';
import { HeychatApiClient } from '../src/modules/heychat/heychat-api.client';
import { HeychatService } from '../src/modules/heychat/heychat.service';
import type { HeychatJoinedRoom } from '../src/modules/heychat/heychat.types';

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ status: 'ok', result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSpace(externalId: string): ServerRecord {
  return {
    serverId: `heychat:${externalId}`,
    platform: 'heychat',
    externalId,
    openId: '',
    guildName: externalId,
    ownerId: `owner-${externalId}`,
    ownerUsername: '',
    passwordHash: `bound-password-${externalId}`,
    bound: 1,
    status: 'active',
    agoraAppId: '',
    agoraAppCertificate: '',
    agoraTokenExpireSec: 0,
    allowedQualities: '[]',
    triggerWords: '',
    idleTimeoutSec: 0,
    heartbeatIntervalSec: 0,
    noViewerTimeoutSec: 0,
    publicDomain: '',
    allowQualityPreference: 1,
    allowLowLatency: 0,
    reboundAt: 0,
    bindToken: '',
    bindTokenExpires: 0,
    serverSecret: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function joinedRoom(externalId: string): HeychatJoinedRoom {
  return {
    room_id: externalId,
    room_name: externalId,
    create_by: `owner-${externalId}`,
  };
}

class RoomSyncDatabase {
  readonly kicked: string[] = [];
  readonly roomEvents: string[] = [];

  constructor(readonly spaces: ServerRecord[]) {}

  listSpaces(platform: string): ServerRecord[] {
    assert.equal(platform, 'heychat');
    return this.spaces;
  }

  getSpace(platform: string, externalId: string): ServerRecord | undefined {
    assert.equal(platform, 'heychat');
    return this.spaces.find((space) => space.externalId === externalId);
  }

  createSpace(input: { platform: string; externalId: string }): ServerRecord {
    const existing = this.getSpace(input.platform, input.externalId);
    if (!existing) throw new Error(`Unexpected room creation in fixture: ${input.externalId}`);
    return existing;
  }

  updateServer(serverId: string, fields: Partial<ServerRecord>): void {
    const space = this.spaces.find((candidate) => candidate.serverId === serverId);
    if (!space) throw new Error(`Unknown fixture space: ${serverId}`);
    Object.assign(space, fields);
  }

  getServer(serverId: string): ServerRecord | undefined {
    return this.spaces.find((space) => space.serverId === serverId);
  }

  kickServer(serverId: string): void {
    const space = this.getServer(serverId);
    if (!space) throw new Error(`Unknown fixture space: ${serverId}`);
    this.kicked.push(space.externalId);
    space.status = 'kicked';
    space.bound = 0;
    space.passwordHash = '';
  }

  markServerAbsentPreservingBinding(serverId: string): boolean {
    const space = this.getServer(serverId);
    if (!space || space.status !== 'active') return false;
    space.status = 'kicked';
    return true;
  }

  addServerEvent(serverId: string): void {
    this.roomEvents.push(serverId);
  }
}

type RoomSnapshot = HeychatJoinedRoom[] | Error;

function scriptedClient(...snapshots: RoomSnapshot[]) {
  let index = 0;
  return {
    async listJoinedRooms(): Promise<HeychatJoinedRoom[]> {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
}

function makeHarness(spaces: ServerRecord[], client: ReturnType<typeof scriptedClient>) {
  const db = new RoomSyncDatabase(spaces);
  const api: any = {
    client,
    requireClient() {
      if (!this.client) throw new Error('missing fixture client');
      return this.client;
    },
  };
  const analyticsEvents: string[] = [];
  const service = new HeychatService(
    {} as any,
    db as any,
    { register() {}, unregister() {} } as any,
    {
      recordServerEvent(event: { serverSnowflakeId: string }) {
        analyticsEvents.push(event.serverSnowflakeId);
      },
    } as any,
    api,
  );
  return { service, db, api, analyticsEvents };
}

test('joined-room client rejects successful but unverified response shapes', async () => {
  const invalidShape = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({})) as typeof fetch,
  );
  await assert.rejects(
    invalidShape.listJoinedRooms(),
    /joined-room API returned an unverified response/,
  );

  const invalidEntry = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({ rooms: [{ room_name: 'missing id' }] })) as typeof fetch,
  );
  await assert.rejects(
    invalidEntry.listJoinedRooms(),
    /joined-room API returned an invalid room entry/,
  );

  const missingOwner = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({
      rooms: {
        rooms: [{ room_id: 'room-1', room_name: 'missing owner' }],
        total: 1,
        offset: 0,
        limit: 20,
      },
    })) as typeof fetch,
  );
  await assert.rejects(
    missingOwner.listJoinedRooms(),
    /joined-room API returned an invalid room entry/,
  );
});

test('joined-room client retrieves a complete 51-room metadata snapshot in three pages', async () => {
  const expected = Array.from({ length: 51 }, (_, index) => joinedRoom(`room-${index}`));
  const requests: Array<{ offset: number; limit: number }> = [];
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      requests.push({ offset, limit });
      return ok({
        rooms: {
          rooms: expected.slice(offset, offset + limit),
          total: expected.length,
          offset,
          limit,
        },
      });
    }) as typeof fetch,
  );

  assert.deepEqual(await client.listJoinedRooms(), expected);
  assert.deepEqual(requests, [
    { offset: 0, limit: 50 },
    { offset: 50, limit: 50 },
  ]);
});

test('joined-room client also accepts the official flat pagination shape', async () => {
  const expected = Array.from({ length: 21 }, (_, index) => joinedRoom(`flat-room-${index}`));
  const requests: number[] = [];
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      requests.push(offset);
      return ok({
        rooms: expected.slice(offset, offset + limit),
        total: expected.length,
        offset,
        limit,
      });
    }) as typeof fetch,
  );

  assert.deepEqual(await client.listJoinedRooms(), expected);
  assert.deepEqual(requests, [0]);
});

test('joined-room client rejects truncated pages and legacy arrays without metadata', async () => {
  const truncated = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({
      rooms: {
        rooms: Array.from({ length: 19 }, (_, index) => joinedRoom(`room-${index}`)),
        total: 51,
        offset: 0,
        limit: 20,
      },
    })) as typeof fetch,
  );
  await assert.rejects(
    truncated.listJoinedRooms(),
    /snapshot incomplete at offset 0/,
  );

  const legacyFullPage = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({
      rooms: Array.from({ length: 20 }, (_, index) => joinedRoom(`room-${index}`)),
    })) as typeof fetch,
  );
  await assert.rejects(
    legacyFullPage.listJoinedRooms(),
    /without pagination metadata/,
  );

  const legacyShortPage = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({
      rooms: Array.from({ length: 19 }, (_, index) => joinedRoom(`room-${index}`)),
    })) as typeof fetch,
  );
  await assert.rejects(
    legacyShortPage.listJoinedRooms(),
    /without pagination metadata/,
  );
});

test('a truncated metadata snapshot never reaches room removal reconciliation', async () => {
  const spaces = ['room-a', 'room-b', 'room-c', 'room-d'].map(makeSpace);
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({
      rooms: {
        rooms: spaces.slice(1).map((space) => joinedRoom(space.externalId)),
        total: spaces.length,
        offset: 0,
        limit: 20,
      },
    })) as typeof fetch,
  );
  const { service, db, analyticsEvents } = makeHarness(spaces, client);

  await service.syncRooms();
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces.every((space) => space.status === 'active'), true);
  assert.equal(spaces.every((space) => space.bound === 1), true);
  assert.deepEqual(analyticsEvents, []);
});

test('joined-room client rejects pagination drift and duplicate room IDs', async () => {
  let driftCall = 0;
  const paginationDrift = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      driftCall += 1;
      return ok({
        rooms: {
          rooms: Array.from({ length: 20 }, (_, index) => joinedRoom(`room-${offset + index}`)),
          total: driftCall === 1 ? 51 : 50,
          offset,
          limit: 20,
        },
      });
    }) as typeof fetch,
  );
  await assert.rejects(
    paginationDrift.listJoinedRooms(),
    /pagination changed during sync/,
  );

  const duplicate = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      const rooms = offset === 0
        ? Array.from({ length: 20 }, (_, index) => joinedRoom(`room-${index}`))
        : [joinedRoom('room-19')];
      return ok({ rooms: { rooms, total: 21, offset, limit: 20 } });
    }) as typeof fetch,
  );
  await assert.rejects(
    duplicate.listJoinedRooms(),
    /duplicate room ID room-19/,
  );
});

test('verified empty room lists never kick or clear a binding', async () => {
  const space = makeSpace('room-a');
  const { service, db, analyticsEvents } = makeHarness([space], scriptedClient([]));

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(space.status, 'active');
  assert.equal(space.bound, 1);
  assert.notEqual(space.passwordHash, '');

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);

  await service.syncRooms();
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(space.status, 'active');
  assert.equal(space.bound, 1);
  assert.notEqual(space.passwordHash, '');
  assert.deepEqual(analyticsEvents, []);
});

test('repeated anomalous mass disappearance snapshots never kick or clear bindings', async () => {
  const spaces = Array.from({ length: 10 }, (_, index) => makeSpace(`room-${index}`));
  const survivingRoom = joinedRoom('room-0');
  const { service, db } = makeHarness(spaces, scriptedClient([survivingRoom]));

  await service.syncRooms();
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces.every((space) => space.bound === 1), true);

  await service.syncRooms();
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces.every((space) => space.status === 'active'), true);
  assert.equal(spaces.every((space) => space.bound === 1), true);
  assert.equal(spaces.every((space) => space.passwordHash !== ''), true);
});

test('an isolated room exit is marked kicked without clearing its binding', async () => {
  const spaces = ['room-a', 'room-b', 'room-c', 'room-d'].map(makeSpace);
  const joined = spaces.slice(1).map((space) => joinedRoom(space.externalId));
  const { service, db } = makeHarness(spaces, scriptedClient(joined));

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces[0].status, 'kicked');
  assert.equal(spaces[0].bound, 1);
  assert.notEqual(spaces[0].passwordHash, '');
  assert.equal(spaces.slice(1).every((space) => space.status === 'active'), true);
});

test('a failed sync breaks the consecutive removal confirmation chain', async () => {
  const spaces = ['room-a', 'room-b', 'room-c', 'room-d'].map(makeSpace);
  const roomsWithoutA = spaces.slice(1).map((space) => joinedRoom(space.externalId));
  const client = scriptedClient(roomsWithoutA, new Error('temporary API failure'), roomsWithoutA);
  const { service, db } = makeHarness(spaces, client);

  await service.syncRooms();
  await service.syncRooms();
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces[0].status, 'kicked');
  assert.equal(spaces[0].bound, 1);
});

test('changing API clients resets pending removal confirmations', async () => {
  const spaces = ['room-a', 'room-b', 'room-c', 'room-d'].map(makeSpace);
  const roomsWithoutA = spaces.slice(1).map((space) => joinedRoom(space.externalId));
  const firstClient = scriptedClient(roomsWithoutA);
  const { service, db, api } = makeHarness(spaces, firstClient);

  await service.syncRooms();
  api.client = scriptedClient(roomsWithoutA);
  await service.syncRooms();
  assert.deepEqual(db.kicked, []);

  await service.syncRooms();
  assert.deepEqual(db.kicked, []);
  assert.equal(spaces[0].status, 'kicked');
  assert.equal(spaces[0].bound, 1);
});

test('a definitive membership removal event still clears the binding', async () => {
  const space = makeSpace('room-a');
  const { service, db, api } = makeHarness([space], scriptedClient([joinedRoom('room-a')]));
  api.botId = '42';

  assert.equal(await service.handleRoomMembership({
    room_base_info: { room_id: 'room-a' },
    user_info: { user_id: '42', bot: true },
    state: 0,
  }), true);
  assert.deepEqual(db.kicked, ['room-a']);
  assert.equal(space.status, 'kicked');
  assert.equal(space.bound, 0);
  assert.equal(space.passwordHash, '');
});
