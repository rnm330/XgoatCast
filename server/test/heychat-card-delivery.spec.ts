import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/modules/database/database.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { SessionService } from '../src/modules/session/session.service';
import { EventBusService } from '../src/modules/events/events.service';
import { HeychatService } from '../src/modules/heychat/heychat.service';
import { HeychatApiClient, HeychatApiError } from '../src/modules/heychat/heychat-api.client';

async function fixture(run: (f: any) => Promise<void>) {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'xgoat-card-tests-'));
  process.chdir(root);
  let db = new DatabaseService();
  try {
    const space = db.createSpace({ platform: 'heychat', externalId: '100', displayName: 'Room', ownerId: '42' });
    db.updateServer(space.serverId, { bound: 1 });
    const analytics = new AnalyticsService(db);
    const sessions = new SessionService(db, { generateChannelName: () => 'channel' } as any, new EventBusService(), analytics);
    const session = sessions.createSession({ platform: 'heychat', spaceId: space.serverId, externalSpaceId: '100', externalChannelId: '200', sharerUserId: '42', sharerUsername: 'Alice' });
    sessions.startSharing(session.token);
    const event = { platform: 'heychat', spaceId: space.serverId, externalSpaceId: '100', externalChannelId: '200', sessionId: session.id, token: session.token, sharerUsername: 'Alice' };
    const client = { sendChannelCard: async (..._args: any[]) => 'message-1', updateChannelCard: async (..._args: any[]) => {} };
    const api = { client };
    const service = () => new HeychatService(sessions, db, {} as any, analytics, api as any);
    await run({ db, sessions, session, event, client, api, service,
      reopen: () => { db.onModuleDestroy(); db = new DatabaseService(); return db; } });
  } finally { db.onModuleDestroy(); process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
}

test('HTTP numeric int64 IDs remain exact in rooms, owners, channels and messages', async () => {
  const results = [
    '{"rooms":[{"room_id":9007199254740993123,"create_by":9007199254740993125}],"total":1,"offset":0,"limit":50}',
    '{"room_info":{"room":{"room_id":9007199254740993123,"create_by":9007199254740993125},"channels_v2":[{"channel_id":9007199254740993127,"channel_type":1}]}}',
    '{"msg_id":9007199254740993129}',
  ];
  const client = new HeychatApiClient('token', (async () => new Response(`{"status":"ok","result":${results.shift()}}`)) as typeof fetch);
  const rooms = await client.listJoinedRooms();
  assert.equal(rooms[0].room_id, '9007199254740993123');
  assert.equal(rooms[0].create_by, '9007199254740993125');
  const room = await client.getRoom(rooms[0].room_id);
  assert.equal(room.ownerId, '9007199254740993125');
  assert.equal(room.textChannels[0].channel_id, '9007199254740993127');
  assert.equal(await client.sendChannelCard(room.roomId, 'channel', { data: [] }), '9007199254740993129');
});

test('viewing card retries retain the ack ID and duplicate lifecycle events send once', async () => {
  await fixture(async ({ db, event, client, service, sessions }: any) => {
    const acks: string[] = [];
    client.sendChannelCard = async (...args: any[]) => {
      acks.push(args[3].ackId);
      if (acks.length === 1) throw new HeychatApiError('network failure', true);
      return 'sent';
    };
    const worker = service();
    await worker.onSessionStarted(event);
    assert.equal(db.getCardJobSummary().pending, 1);
    db.retryCardJob(`heychat:start:${event.sessionId}`, 0, '');
    await worker.processCardJobs();
    await worker.onSessionStarted(event);
    assert.equal(acks.length, 2);
    assert.equal(acks[0], acks[1]);
    assert.equal(sessions.getById(event.sessionId).platformMessageId, 'sent');
    assert.deepEqual(db.getCardJobSummary(), {});
  });
});

test('ended card update is persisted and survives a database restart', async () => {
  await fixture(async ({ db, sessions, event, service, client, reopen }: any) => {
    sessions.setPlatformMessageId(event.sessionId, 'original');
    const calls: string[] = [];
    client.updateChannelCard = async (_room: string, _channel: string, messageId: string) => {
      calls.push(messageId);
      if (calls.length === 1) throw new HeychatApiError('timeout', true);
    };
    await service().onSessionEnded({ ...event, platformMessageId: 'original', reason: 'stopped' });
    const restarted = reopen();
    const analytics = new AnalyticsService(restarted);
    const newSessions = new SessionService(restarted, {} as any, new EventBusService(), analytics);
    restarted.retryCardJob(`heychat:end:${event.sessionId}`, 0, '');
    const worker = new HeychatService(newSessions, restarted, {} as any, analytics, { client } as any);
    await worker.processCardJobs();
    assert.deepEqual(calls, ['original', 'original']);
    assert.deepEqual(restarted.getCardJobSummary(), {});
  });
});

test('uncertain creates outside the short deduplication window are not resent', async () => {
  await fixture(async ({ db, event, service, client }: any) => {
    let sends = 0;
    client.sendChannelCard = async () => { sends++; throw new HeychatApiError('timeout', true); };
    const worker = service();
    await worker.onSessionStarted(event);
    db.runAnalytics('UPDATE platform_card_jobs SET first_attempt_at = ?, next_attempt_at = 0', [Date.now() - 60_000]);
    await worker.processCardJobs();
    assert.equal(sends, 1);
    assert.equal(db.getCardJobSummary().uncertain, 1);
  });
});

test('session ending during card creation queues an update to the returned message', async () => {
  await fixture(async ({ db, sessions, event, client, service }: any) => {
    const updated: string[] = [];
    client.sendChannelCard = async () => { db.updateSession(event.sessionId, { status: 'ended', endedAt: Date.now() }); return 'late-message'; };
    client.updateChannelCard = async (_room: string, _channel: string, id: string) => { updated.push(id); };
    const worker = service();
    await worker.onSessionStarted(event);
    await worker.processCardJobs();
    assert.deepEqual(updated, ['late-message']);
  });
});

test('expired create deadline is checked after waiting for the HTTP rate limiter', async () => {
  let now = 1_000;
  let sends = 0;
  const client = new HeychatApiClient('token', (async () => {
    sends++; return new Response('{"status":"ok","result":{"msg_id":"1"}}');
  }) as typeof fetch, { now: () => now, sleep: async ms => { now += ms; }, requestLimit: 1, rateWindowMs: 60_000 });
  await client.sendChannelCard('room', 'channel', { data: [] });
  await assert.rejects(client.sendChannelCard('room', 'channel', { data: [] }, { ackId: 'fixed', deadline: now + 45_000 }), /window expired/);
  assert.equal(sends, 1);
});

test('custom Heychat text trigger starts a session for another user', async () => {
  await fixture(async ({ db, event, api, service }: any) => {
    db.updateServer(event.spaceId, { triggerWords: '演示' });
    api.botId = '77';
    const worker = service();
    assert.equal(await worker.handleTextMessage({ bot_id: '77',
      room_base_info: { room_id: event.externalSpaceId },
      channel_base_info: { channel_id: event.externalChannelId },
      sender_info: { user_id: '43', nickname: 'Bob' },
      msg_id: 'command-2', send_time: Date.now(), text: '/演示',
    }), true);
    assert.equal(db.getActiveSessionsByPlatformUser('heychat', '43').length, 1);
    assert.equal(db.getActiveSessionsByPlatformUser('heychat', '42').length, 1);
    assert.equal(db.getActiveSessionsByPlatformUser('kook', '42').length, 0);
  });
});

test('dashboard includes Heychat usage, separates platform coverage and fills empty usage buckets', async () => {
  await fixture(async ({ db }: any) => {
    const analytics = new AnalyticsService(db);
    db.createSpace({ platform: 'kook', externalId: '100', displayName: 'Kook', ownerId: '42' });
    analytics.recordCoverageSnapshot({ totalMemberCount: 123, successfulServerCount: 1, failedServerCount: 0 });
    const realtime = analytics.getRealtime();
    assert.equal(realtime.servers.botPresent, 2);
    assert.equal(realtime.sharing.ongoing, 1);
    assert.equal(realtime.coverage.memberCount, 123);
    assert.equal(realtime.coverageByPlatform.heychat.serversTotal, 1);
    assert.equal(realtime.coverageByPlatform.heychat.memberCount, null);
    const overview = analytics.getOverview({ range: '24h' } as any);
    assert.equal(overview.summary.successfulShares, 1);
    assert.ok(overview.series.length >= 24);
    assert.equal(overview.series.reduce((sum: number, p: any) => sum + p.successfulShares, 0), 1);
    assert.ok(overview.series.some((p: any) => p.successfulShares === 0));
  });
});

test('coverage trend retains recent data after more than 2000 snapshots', async () => {
  await fixture(async ({ db }: any) => {
    const analytics = new AnalyticsService(db);
    const now = Date.now();
    db.runAnalyticsTransaction(() => {
      for (let i = 0; i < 2005; i++) analytics.recordCoverageSnapshot({
        capturedAt: now - (2005 - i) * 60_000, totalMemberCount: i,
        successfulServerCount: 1, failedServerCount: 0,
      });
    });
    const overview = analytics.getOverview({ range: '7d' } as any);
    assert.equal(overview.coverageSeries.at(-1)?.memberCount, 2004);
  });
});
