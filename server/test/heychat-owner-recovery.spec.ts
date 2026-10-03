import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerRecord } from '../src/modules/database/database.service';
import { HeychatApiClient } from '../src/modules/heychat/heychat-api.client';
import { HeychatService } from '../src/modules/heychat/heychat.service';

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ status: 'ok', result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRoomClient(result: unknown): HeychatApiClient {
  return new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok(result)) as typeof fetch,
  );
}

test('room detail normalizes the online room_info room and channels_v2 shape', async () => {
  const client = makeRoomClient({
    room_info: {
      room: {
        room_id: 'room-online',
        room_name: 'Online room',
        create_by: 9007199254740993123n.toString(),
        public_id: 'public-online',
      },
      channels_v2: [{
        channel_id: 'category-online',
        channel_type: 0,
        channel_list: [{ channel_id: 'text-online', channel_type: 1 }],
      }],
    },
  });

  assert.deepEqual(await client.getRoom('fallback-room'), {
    roomId: 'room-online',
    roomName: 'Online room',
    ownerId: '9007199254740993123',
    publicId: 'public-online',
    textChannels: [{ channel_id: 'text-online', channel_type: 1 }],
  });
});

test('room detail keeps normalizing the legacy room and channels shape', async () => {
  const client = makeRoomClient({
    room: {
      room_id: 'room-legacy',
      room_name: 'Legacy room',
      create_by: 42,
      public_id: 'public-legacy',
    },
    channels: [{ channel_id: 'text-legacy', channel_type: 1 }],
  });

  assert.deepEqual(await client.getRoom('fallback-room'), {
    roomId: 'room-legacy',
    roomName: 'Legacy room',
    ownerId: '42',
    publicId: 'public-legacy',
    textChannels: [{ channel_id: 'text-legacy', channel_type: 1 }],
  });
});

function makeUnboundOwnerlessSpace(): ServerRecord {
  return {
    serverId: 'heychat:room-recovered',
    platform: 'heychat',
    externalId: 'room-recovered',
    openId: '',
    guildName: 'Recovered room',
    ownerId: '',
    ownerUsername: '',
    passwordHash: '',
    bound: 0,
    status: 'active',
    agoraAppId: '',
    agoraAppCertificate: '',
    agoraTokenExpireSec: 3600,
    allowedQualities: '[]',
    triggerWords: '',
    idleTimeoutSec: 60,
    heartbeatIntervalSec: 5,
    noViewerTimeoutSec: 180,
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

test('repeated sync sends one public device-binding card when an unbound room recovers its owner', async () => {
  const space = makeUnboundOwnerlessSpace();
  const roomEvents: string[] = [];
  const recoveredRoom = {
    room_id: space.externalId,
    room_name: space.guildName,
    create_by: 'owner-recovered',
  };
  const client = {
    async listJoinedRooms() {
      return [recoveredRoom];
    },
    async getRoom() {
      return { textChannels: [{ channel_id: 'text-recovered', channel_type: 1 }] };
    },
    async sendChannelCard(_roomId: string, _channelId: string, _card: unknown) {
      bindingRecipients.push('owner-recovered');
      return 'binding-card-1';
    },
  };
  const db = {
    listSpaces(platform: string) {
      assert.equal(platform, 'heychat');
      return [space];
    },
    getSpace(platform: string, externalId: string) {
      assert.equal(platform, 'heychat');
      return externalId === space.externalId ? space : undefined;
    },
    createSpace() {
      return space;
    },
    updateServer(serverId: string, fields: Partial<ServerRecord>) {
      assert.equal(serverId, space.serverId);
      Object.assign(space, fields);
    },
    getServer(serverId: string) {
      return serverId === space.serverId ? space : undefined;
    },
    addServerEvent(serverId: string) {
      roomEvents.push(serverId);
    },
    createHeychatBindingIntent() {
      return { intentId: 'intent-recovered', expiresAt: Date.now() + 300000 };
    },
    getGlobalConfig() {
      return { publicDomain: 'https://cast.example' };
    },
  };
  const service = new HeychatService(
    {} as any,
    db as any,
    { register() {}, unregister() {} } as any,
    { recordServerEvent() { roomEvents.push('analytics'); } } as any,
    {
      client,
      requireClient() {
        return client;
      },
    } as any,
  );
  const bindingRecipients: string[] = [];

  await service.syncRooms();
  await service.syncRooms();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(space.ownerId, 'owner-recovered');
  assert.deepEqual(bindingRecipients, ['owner-recovered']);
  assert.deepEqual(roomEvents, []);
});

test('a rejoined room never sends a binding token to a stale owner without a fresh owner ID', async () => {
  const space = makeUnboundOwnerlessSpace();
  space.ownerId = 'stale-owner';
  space.status = 'kicked';
  const db = {
    getSpace: () => space,
    createSpace: () => space,
    updateServer: (_serverId: string, fields: Partial<ServerRecord>) => Object.assign(space, fields),
    getServer: () => space,
    addServerEvent() {},
  };
  const service = new HeychatService(
    {} as any,
    db as any,
    { register() {}, unregister() {} } as any,
    { recordServerEvent() {} } as any,
    { client: {} } as any,
  );
  const recipients: string[] = [];
  (service as any).sendBindingMessage = async (current: ServerRecord) => {
    recipients.push(current.ownerId);
  };

  await (service as any).upsertRoom({
    room_id: space.externalId,
    room_name: space.guildName,
  }, true);
  await Promise.resolve();

  assert.deepEqual(recipients, []);
});
