import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerRecord } from '../src/modules/database/database.service';
import { HeychatService } from '../src/modules/heychat/heychat.service';

const ROOM_ID = 'room-public-binding';
const CHANNEL_ID = 'channel-public-binding';
const OWNER_ID = '4080598';

function makeSpace(ownerId = OWNER_ID): ServerRecord {
  return { serverId: `heychat:${ROOM_ID}`, platform: 'heychat', externalId: ROOM_ID, openId: '', guildName: 'Public binding room', ownerId, ownerUsername: '', passwordHash: '', bound: 0, status: 'active', agoraAppId: '', agoraAppCertificate: '', agoraTokenExpireSec: 3600, allowedQualities: '[]', triggerWords: '屏幕共享', idleTimeoutSec: 60, heartbeatIntervalSec: 5, noViewerTimeoutSec: 180, publicDomain: '', allowLowLatency: 0, allowQualityPreference: 1, reboundAt: 0, bindToken: '', bindTokenExpires: 0, serverSecret: '', createdAt: 1, updatedAt: 1 };
}

function makeEvent(senderId = OWNER_ID) {
  return { bot_id: '103252254', room_base_info: { room_id: ROOM_ID, room_name: 'Public binding room' }, channel_base_info: { channel_id: CHANNEL_ID, channel_name: 'general' }, command_info: { name: '/xchelp' }, sender_info: { user_id: senderId, nickname: 'ShawnF.' }, send_time: Date.now() };
}

function makeService(options: { channelFailure?: Error; ownerId?: string } = {}) {
  const space = makeSpace(options.ownerId);
  const privateMessages: Array<{ userId: string; message: string }> = [];
  const channelMessages: Array<{ roomId: string; channelId: string; message: string }> = [];
  const bindingCards: Array<{ roomId: string; channelId: string; card: unknown }> = [];
  const client = {
    async sendPrivateMarkdown(userId: string, message: string) { privateMessages.push({ userId, message }); return 'private-message'; },
    async sendChannelMarkdown(roomId: string, channelId: string, message: string) { channelMessages.push({ roomId, channelId, message }); if (options.channelFailure) throw options.channelFailure; return 'channel-message'; },
    async sendChannelCard(roomId: string, channelId: string, card: unknown) { bindingCards.push({ roomId, channelId, card }); if (options.channelFailure) throw options.channelFailure; return 'binding-card'; },
  };
  const db = {
    getSpace(platform: string, externalId: string) { assert.equal(platform, 'heychat'); assert.equal(externalId, ROOM_ID); return space; },
    getGlobalConfig() { return { publicDomain: 'https://cast.example' }; },
    createHeychatBindingIntent(serverId: string) { assert.equal(serverId, ROOM_ID); return { intentId: 'intent-1', expiresAt: Date.now() + 300000 }; },
  };
  const service = new HeychatService({} as any, db as any, { register() {}, unregister() {} } as any, {} as any, { isReady: true, botId: '103252254', client } as any);
  return { service, privateMessages, channelMessages, bindingCards };
}

test('/xchelp publishes a public device binding card without private DM', async () => {
  const { service, privateMessages, channelMessages, bindingCards } = makeService();
  assert.equal(await service.handleCommand(makeEvent()), true);
  assert.equal(privateMessages.length, 0); assert.equal(channelMessages.length, 0); assert.equal(bindingCards.length, 1);
  assert.match(JSON.stringify(bindingCards[0].card), /intent-1/); assert.equal(JSON.stringify(bindingCards[0].card).includes('?t='), false);
});

test('/xchelp finishes safely when the public binding card fails', async () => {
  const { service, privateMessages, channelMessages, bindingCards } = makeService({ channelFailure: new Error('send failed') });
  assert.equal(await service.handleCommand(makeEvent()), true);
  assert.equal(privateMessages.length, 0); assert.equal(channelMessages.length, 1); assert.equal(bindingCards.length, 1);
});

test('/xchelp for a non-owner is a public channel notice', async () => {
  const { service, privateMessages, channelMessages, bindingCards } = makeService({ ownerId: 'different-owner' });
  assert.equal(await service.handleCommand(makeEvent()), true);
  assert.equal(privateMessages.length, 0); assert.equal(bindingCards.length, 0); assert.equal(channelMessages.length, 1);
  assert.match(channelMessages[0].message, /房主/);
});

test('a bare 8-character binding code sent as a plain channel message authorizes the owner claim', async () => {
  const space = makeSpace();
  const claims: Array<{ roomId: string; code: string; userId: string }> = [];
  const channelMessages: Array<{ roomId: string; channelId: string; message: string }> = [];
  const client = {
    async sendPrivateMarkdown() { return 'private-message'; },
    async sendChannelMarkdown(roomId: string, channelId: string, message: string) { channelMessages.push({ roomId, channelId, message }); return 'channel-message'; },
    async sendChannelCard() { return 'binding-card'; },
  };
  const db = {
    getSpace(platform: string, externalId: string) { assert.equal(platform, 'heychat'); assert.equal(externalId, ROOM_ID); return space; },
    getGlobalConfig() { return { publicDomain: 'https://cast.example' }; },
    createHeychatBindingIntent(serverId: string) { assert.equal(serverId, ROOM_ID); return { intentId: 'intent-1', expiresAt: Date.now() + 300000 }; },
    authorizeHeychatBindingClaim(roomId: string, code: string, userId: string) { claims.push({ roomId, code, userId }); return { claimId: 'claim-1', state: 'authorized' }; },
  };
  const service = new HeychatService({} as any, db as any, { register() {}, unregister() {} } as any, {} as any, { isReady: true, botId: '103252254', client } as any);

  assert.equal(await service.handleTextMessage({
    bot_id: '103252254',
    room_base_info: { room_id: ROOM_ID, room_name: 'Public binding room' },
    channel_base_info: { channel_id: CHANNEL_ID, channel_name: 'general' },
    sender_info: { user_id: OWNER_ID, nickname: 'ShawnF.' },
    msg_id: 'message-1',
    text: 'BE6XFZVU',
    send_time: Date.now(),
  }), true);

  assert.deepEqual(claims, [{ roomId: ROOM_ID, code: 'BE6XFZVU', userId: OWNER_ID }]);
  assert.equal(channelMessages.length, 1);
  assert.match(channelMessages[0].message, /设备已授权/);
});

test('a flat USER_IM_MESSAGE push carrying "/xchelp <code>" authorizes the owner claim', async () => {
  const space = makeSpace();
  const claims: Array<{ roomId: string; code: string; userId: string }> = [];
  const channelMessages: Array<{ roomId: string; channelId: string; message: string }> = [];
  const client = {
    async sendPrivateMarkdown() { return 'private-message'; },
    async sendChannelMarkdown(roomId: string, channelId: string, message: string) { channelMessages.push({ roomId, channelId, message }); return 'channel-message'; },
    async sendChannelCard() { return 'binding-card'; },
  };
  const db = {
    getSpace(platform: string, externalId: string) { assert.equal(platform, 'heychat'); assert.equal(externalId, ROOM_ID); return space; },
    getGlobalConfig() { return { publicDomain: 'https://cast.example' }; },
    createHeychatBindingIntent(serverId: string) { assert.equal(serverId, ROOM_ID); return { intentId: 'intent-1', expiresAt: Date.now() + 300000 }; },
    authorizeHeychatBindingClaim(roomId: string, code: string, userId: string) { claims.push({ roomId, code, userId }); return { claimId: 'claim-1', state: 'authorized' }; },
  };
  const service = new HeychatService({} as any, db as any, { register() {}, unregister() {} } as any, {} as any, { isReady: true, botId: '103252254', client } as any);

  // Mirrors the real type=5 push (notify_type=USER_IM_MESSAGE): no
  // *_base_info/sender_info wrappers; identifiers live directly on data.
  const flatEvent = {
    channel_id: 'channel-id',
    channel_name: '默认频道',
    channel_type: 1,
    msg: '/xchelp 9WX8DHZS',
    msg_id: '2092514824136126464',
    nickname: 'ShawnF.',
    room_id: ROOM_ID,
    send_time: Date.now(),
    user_id: 4080598,
    user_info: { user_base_info: { nickname: 'ShawnF.', user_id: 4080598 } },
  };

  assert.equal(await service.handleTextMessage(flatEvent as any), true);
  assert.deepEqual(claims, [{ roomId: ROOM_ID, code: '9WX8DHZS', userId: OWNER_ID }]);
  assert.equal(channelMessages.length, 1);
  assert.match(channelMessages[0].message, /设备已授权/);
});

test('twin pushes of one command (type=50 + type=5, same msg_id) are handled once', async () => {
  const { service, bindingCards } = makeService();
  const event = { ...makeEvent(), msg_id: 'twin-msg-1' };

  assert.equal(await service.handleCommand(event), true);
  assert.equal(await service.handleCommand(event), false);
  assert.equal(bindingCards.length, 1);
});

test('type=50 command with empty options authorizes the code from the msg text', async () => {
  const space = makeSpace();
  const claims: Array<{ roomId: string; code: string; userId: string }> = [];
  const channelMessages: Array<{ roomId: string; channelId: string; message: string }> = [];
  const client = {
    async sendPrivateMarkdown() { return 'private-message'; },
    async sendChannelMarkdown(roomId: string, channelId: string, message: string) { channelMessages.push({ roomId, channelId, message }); return 'channel-message'; },
    async sendChannelCard() { return 'binding-card'; },
  };
  const db = {
    getSpace(platform: string, externalId: string) { assert.equal(platform, 'heychat'); assert.equal(externalId, ROOM_ID); return space; },
    getGlobalConfig() { return { publicDomain: 'https://cast.example' }; },
    createHeychatBindingIntent(serverId: string) { assert.equal(serverId, ROOM_ID); return { intentId: 'intent-1', expiresAt: Date.now() + 300000 }; },
    authorizeHeychatBindingClaim(roomId: string, code: string, userId: string) { claims.push({ roomId, code, userId }); return { claimId: 'claim-1', state: 'authorized' }; },
  };
  const service = new HeychatService({} as any, db as any, { register() {}, unregister() {} } as any, {} as any, { isReady: true, botId: '103252254', client } as any);

  // Mirrors the real type=50 push: options empty, code only in msg text.
  const commandEvent = {
    ...makeEvent(),
    msg_id: 'type50-msg-1',
    msg: '/xchelp D46UES3R',
    command_info: { name: '/xchelp', options: [] },
  };
  assert.equal(await service.handleCommand(commandEvent as any), true);
  assert.deepEqual(claims, [{ roomId: ROOM_ID, code: 'D46UES3R', userId: OWNER_ID }]);
});

test('type=5 text with the code joined to the command name authorizes it', async () => {
  const space = makeSpace();
  const claims: Array<{ roomId: string; code: string; userId: string }> = [];
  const channelMessages: Array<{ roomId: string; channelId: string; message: string }> = [];
  const client = {
    async sendPrivateMarkdown() { return 'private-message'; },
    async sendChannelMarkdown(roomId: string, channelId: string, message: string) { channelMessages.push({ roomId, channelId, message }); return 'channel-message'; },
    async sendChannelCard() { return 'binding-card'; },
  };
  const db = {
    getSpace(platform: string, externalId: string) { assert.equal(platform, 'heychat'); assert.equal(externalId, ROOM_ID); return space; },
    getGlobalConfig() { return { publicDomain: 'https://cast.example' }; },
    createHeychatBindingIntent(serverId: string) { assert.equal(serverId, ROOM_ID); return { intentId: 'intent-1', expiresAt: Date.now() + 300000 }; },
    authorizeHeychatBindingClaim(roomId: string, code: string, userId: string) { claims.push({ roomId, code, userId }); return { claimId: 'claim-1', state: 'authorized' }; },
  };
  const service = new HeychatService({} as any, db as any, { register() {}, unregister() {} } as any, {} as any, { isReady: true, botId: '103252254', client } as any);

  assert.equal(await service.handleTextMessage({
    bot_id: '103252254',
    room_base_info: { room_id: ROOM_ID },
    channel_base_info: { channel_id: 'channel-1' },
    sender_info: { user_id: OWNER_ID },
    msg_id: 'joined-msg-1',
    msg: '/xchelpC92MLPAC',
    send_time: Date.now(),
  } as any), true);
  assert.deepEqual(claims, [{ roomId: ROOM_ID, code: 'C92MLPAC', userId: OWNER_ID }]);
});
