import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEYCHAT_API_REQUEST_LIMIT,
  HEYCHAT_HTTP_CHAT_VERSION,
  HeychatApiClient,
  HeychatApiError,
} from '../src/modules/heychat/heychat-api.client';
import {
  buildHeychatEndedCard,
  buildHeychatShareStartCard,
  buildHeychatViewingCard,
} from '../src/modules/heychat/heychat-card-builder';
import { HeychatEventRouter } from '../src/modules/heychat/heychat-event.router';

type CapturedRequest = { url: URL; init: RequestInit; body: any };

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ status: 'ok', result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('API client sends documented channel, update, and private-message payloads', async () => {
  const captured: CapturedRequest[] = [];
  const fakeFetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    captured.push({ url, init, body });
    return ok({ msg_id: `message-${captured.length}` });
  }) as typeof fetch;
  const token = Buffer.from('103252254;fixture-a;fixture-b').toString('base64');
  const client = new HeychatApiClient(token, fakeFetch, { botId: '103252254' });
  const card = buildHeychatViewingCard({
    sharerUsername: 'tester',
    viewUrl: 'https://cast.example/view?t=fixture',
  });

  assert.equal(client.botId, '103252254');
  assert.equal(await client.sendChannelCard('room-1', 'channel-1', card), 'message-1');
  await client.updateChannelCard('room-1', 'channel-1', 'message-1', card);
  await client.sendPrivateMarkdown('9007199254740993123', 'private fixture');
  assert.equal(
    await client.sendChannelMarkdown('room-1', 'channel-1', 'channel fixture'),
    'message-4',
  );

  assert.equal(captured[0].url.pathname, '/chatroom/v2/channel_msg/send');
  assert.equal(captured[1].url.pathname, '/chatroom/v2/channel_msg/update');
  assert.equal(captured[2].url.pathname, '/chatroom/v3/msg/user');
  assert.equal(captured[3].url.pathname, '/chatroom/v2/channel_msg/send');
  for (const request of captured) {
    assert.equal(request.url.searchParams.get('chat_os_type'), 'bot');
    assert.equal(request.url.searchParams.get('client_type'), 'heybox_chat');
    assert.equal((request.init.headers as Record<string, string>).token, token);
    assert.equal(
      (request.init.headers as Record<string, string>)['Content-Type'],
      'application/json;charset=UTF-8',
    );
  }
  assert.equal(captured[0].body.msg_type, 20);
  assert.deepEqual(JSON.parse(captured[0].body.msg), card);
  assert.equal(captured[1].body.msg_id, 'message-1');
  assert.equal(captured[1].body.msg_type, 20);
  assert.equal(captured[2].body.msg_type, 4);
  assert.equal(captured[2].body.to_user_id, '9007199254740993123');
  for (const request of captured) {
    assert.equal(request.url.searchParams.get('chat_version'), HEYCHAT_HTTP_CHAT_VERSION);
  }
});

test('official flat joined-room and room-detail responses are normalized', async () => {
  const fakeFetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    assert.equal(url.searchParams.get('chat_version'), HEYCHAT_HTTP_CHAT_VERSION);
    assert.equal(
      (init.headers as Record<string, string>)['Content-Type'],
      'application/json;charset=UTF-8',
    );
    if (url.pathname.endsWith('/room/joined')) {
      return ok({
        rooms: [{ room_id: 'room-1', room_name: 'Fixture room', create_by: 42 }],
        total: 1,
        offset: 0,
        limit: 20,
      });
    }
    return ok({
      room: { room_id: 'room-1', room_name: 'Fixture room', create_by: 42 },
      channels: [{
        channel_id: 'category',
        channel_type: 0,
        channel_list: [{ channel_id: 'text-1', channel_type: 1 }],
      }],
    });
  }) as typeof fetch;
  const client = new HeychatApiClient(Buffer.from('42;a;b').toString('base64'), fakeFetch);

  assert.deepEqual(await client.listJoinedRooms(), [
    { room_id: 'room-1', room_name: 'Fixture room', create_by: 42 },
  ]);
  assert.deepEqual(await client.getRoom('room-1'), {
    roomId: 'room-1',
    roomName: 'Fixture room',
    ownerId: '42',
    publicId: '',
    textChannels: [{ channel_id: 'text-1', channel_type: 1 }],
  });
});

test('successful message responses must contain msg_id', async () => {
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => ok({ heychat_ack_id: 'fixture' })) as typeof fetch,
  );

  await assert.rejects(
    client.sendChannelMarkdown('room-1', 'channel-1', 'fixture'),
    (error: unknown) => (
      error instanceof HeychatApiError
      && !error.retryable
      && /success without msg_id/.test(error.message)
    ),
  );
});

test('GET retries a non-JSON 429 using documented reset headers', async () => {
  let calls = 0;
  let now = 1_000;
  const sleeps: number[] = [];
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'X-RateLimit-Reset-After': '0.5' },
        });
      }
      return ok({
        room: { room_id: 'room-1', room_name: 'Fixture room', create_by: 42 },
        channels: [],
      });
    }) as typeof fetch,
    {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      getAttempts: 2,
    },
  );

  assert.equal((await client.getRoom('room-1')).roomId, 'room-1');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test('POST exposes non-JSON 429 metadata without unsafe automatic replay', async () => {
  let calls = 0;
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => {
      calls += 1;
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      });
    }) as typeof fetch,
  );

  await assert.rejects(
    client.sendChannelMarkdown('room-1', 'channel-1', 'fixture'),
    (error: unknown) => (
      error instanceof HeychatApiError
      && error.retryable
      && error.status === 429
      && error.retryAfterMs === 2_000
    ),
  );
  assert.equal(calls, 1);
});

test('global HTTP gate admits at most its configured request count per window without real waiting', async () => {
  assert.equal(HEYCHAT_API_REQUEST_LIMIT, 300);
  let now = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const client = new HeychatApiClient(
    Buffer.from('42;a;b').toString('base64'),
    (async () => {
      calls += 1;
      return ok({ msg_id: `message-${calls}` });
    }) as typeof fetch,
    {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      requestLimit: 2,
      rateWindowMs: 1_000,
    },
  );

  const messageIds = await Promise.all([
    client.sendChannelMarkdown('room-1', 'channel-1', 'one'),
    client.sendChannelMarkdown('room-1', 'channel-1', 'two'),
    client.sendChannelMarkdown('room-1', 'channel-1', 'three'),
  ]);
  assert.deepEqual(messageIds.sort(), ['message-1', 'message-2', 'message-3']);
  assert.deepEqual(sleeps, [1_000]);
});

test('cards support a link button, a server callback, and updating the original message', () => {
  const viewing = buildHeychatViewingCard({
    sharerUsername: 'tester',
    viewUrl: 'https://cast.example/view?t=fixture',
  });
  const ended = buildHeychatEndedCard({
    sharerUsername: 'tester',
    totalViewerJoins: 3,
    durationMs: 65_000,
    standardMinutes: 2,
    estimatedCost: 0.12,
  });

  assert.deepEqual(viewing.data[0].modules[2].btns[0], {
    type: 'button',
    event: 'link-to',
    value: 'https://cast.example/view?t=fixture',
    text: '点击观看',
    theme: 'success',
  });
  assert.equal(ended.data[0].modules[3].btns[0].event, 'server');
  assert.equal(ended.data[0].modules[3].btns[0].value, 'reshare');
});

function commandEvent(sequence: string | number, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    sequence,
    type: '50',
    timestamp: now,
    data: {
      bot_id: 103252254,
      channel_base_info: {
        channel_id: 'channel-1',
        channel_name: 'default',
        channel_type: 1,
      },
      command_info: {
        id: 'command-1',
        name: '/xchelp',
        options: [],
        type: 0,
      },
      msg_id: `message-${sequence}`,
      room_base_info: {
        room_id: 'room-1',
        room_name: 'Fixture room',
      },
      send_time: now,
      sender_info: {
        bot: false,
        nickname: 'tester',
        user_id: 4080598,
      },
    },
    ...overrides,
  };
}

function cardButtonEvent(sequence: string | number) {
  const now = Date.now();
  return {
    sequence,
    type: 'card_message_btn_click',
    timestamp: now,
    data: {
      channel_base_info: { channel_id: 'channel-1', channel_type: 1 },
      event: 'server',
      msg_id: 'card-message-1',
      room_base_info: { room_id: 'room-1' },
      send_time: now,
      sender_info: { bot: false, user_id: 4080598 },
      text: '重新发起共享',
      value: 'reshare',
    },
  };
}

function membershipEvent(sequence: string | number) {
  return {
    sequence,
    type: '3001',
    timestamp: Date.now(),
    data: {
      room_base_info: { room_id: 'room-1' },
      state: 1,
      user_info: { bot: true, user_id: 103252254 },
    },
  };
}

function quietRouter(service: object): HeychatEventRouter {
  const router = new HeychatEventRouter(service as any);
  (router as any).logger = { debug() {}, warn() {} };
  return router;
}

test('event router deduplicates sequence values and dispatches documented protocol event types', async () => {
  const calls: string[] = [];
  const service = {
    async handleCommand() { calls.push('command'); return true; },
    async handleCardButton() { calls.push('button'); return true; },
    async handleRoomMembership() { calls.push('membership'); return true; },
  };
  const router = quietRouter(service);

  assert.equal(await router.route(commandEvent(1)), true);
  assert.equal(await router.route(commandEvent('01')), false);
  assert.equal(await router.route(cardButtonEvent(2)), true);
  assert.equal(await router.route(membershipEvent(3)), true);
  assert.deepEqual(calls, ['command', 'button', 'membership']);
});

test('event router strictly rejects missing, invalid, stale, and far-future envelope timestamps', async (t) => {
  const fixedNow = Date.now();
  t.mock.method(Date, 'now', () => fixedNow);
  let calls = 0;
  const router = quietRouter({
    async handleCommand() { calls += 1; return true; },
    async handleCardButton() { calls += 1; return true; },
    async handleRoomMembership() { calls += 1; return true; },
  });
  const now = Date.now();

  assert.equal(await router.route(commandEvent(10, { timestamp: undefined })), false);
  assert.equal(await router.route(commandEvent(11, { timestamp: Number.NaN })), false);
  assert.equal(await router.route(commandEvent(12, { timestamp: now - 5 * 60_000 - 1 })), false);
  assert.equal(await router.route(commandEvent(13, { timestamp: now + 5 * 60_000 + 1 })), false);
  assert.equal(calls, 0);
});

test('event router commits a sequence only after a handler fulfils and permits failed delivery retry', async () => {
  let attempts = 0;
  const router = quietRouter({
    async handleCommand() {
      attempts += 1;
      if (attempts === 1) throw new Error('transient fixture failure');
      return true;
    },
    async handleCardButton() { return true; },
    async handleRoomMembership() { return true; },
  });
  const event = commandEvent(20);

  await assert.rejects(router.route(event), /transient fixture failure/);
  assert.equal(await router.route(event), true);
  assert.equal(await router.route(event), false);
  assert.equal(attempts, 2);
});

test('event router processes handlers serially in receive order', async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const router = quietRouter({
    async handleCommand(event: any) {
      const name = event.command_info.name;
      calls.push(`start:${name}`);
      if (name === '/first') await firstGate;
      calls.push(`end:${name}`);
      return true;
    },
    async handleCardButton() { return true; },
    async handleRoomMembership() { return true; },
  });
  const first = commandEvent(30);
  (first.data as any).command_info.name = '/first';
  const second = commandEvent(31);
  (second.data as any).command_info.name = '/second';

  const firstResult = router.route(first);
  const secondResult = router.route(second);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start:/first']);
  releaseFirst();

  assert.equal(await firstResult, true);
  assert.equal(await secondResult, true);
  assert.deepEqual(calls, [
    'start:/first',
    'end:/first',
    'start:/second',
    'end:/second',
  ]);
});

test('event router rejects malformed known-event data and keeps unknown event types ignored', async () => {
  let calls = 0;
  const router = quietRouter({
    async handleCommand() { calls += 1; return true; },
    async handleCardButton() { calls += 1; return true; },
    async handleRoomMembership() { calls += 1; return true; },
  });

  const missingCommandSender = commandEvent(40);
  delete (missingCommandSender.data as any).sender_info;
  assert.equal(await router.route(missingCommandSender), false);

  const missingCardMessage = cardButtonEvent(41);
  delete (missingCardMessage.data as any).msg_id;
  assert.equal(await router.route(missingCardMessage), false);

  const invalidMembershipState = membershipEvent(42);
  (invalidMembershipState.data as any).state = 2;
  assert.equal(await router.route(invalidMembershipState), false);

  assert.equal(await router.route({
    sequence: 43,
    type: '5003',
    timestamp: Date.now(),
    data: {},
  }), false);
  assert.equal(calls, 0);
});

test('event router accepts the flat type=5 push shape and forwards it to handleTextMessage', async () => {
  const received: unknown[] = [];
  const router = quietRouter({
    async handleTextMessage(data: unknown) { received.push(data); return true; },
  });
  const now = Date.now();
  const flatEnvelope = {
    sequence: 132982233040,
    type: '5',
    notify_type: 'USER_IM_MESSAGE',
    timestamp: now,
    data: {
      channel_id: '3999086263567654914',
      channel_name: '默认频道',
      channel_type: 1,
      msg: '/xchelp 9WX8DHZS',
      msg_id: '2092514898933153792',
      nickname: 'ShawnF.',
      room_id: '3999086263490035712',
      send_time: now,
      user_id: 4080598,
      user_info: { user_base_info: { nickname: 'ShawnF.', user_id: 4080598 } },
    },
  };

  assert.equal(await router.route(flatEnvelope), true);
  assert.equal(received.length, 1);
  assert.equal((received[0] as any).msg, '/xchelp 9WX8DHZS');
  assert.equal((received[0] as any).user_id, 4080598);
});

test('share start card uses a link button instead of raw link text', () => {
  const card = buildHeychatShareStartCard({
    sharerUsername: 'tester',
    shareUrl: 'https://cast.example/share?t=fixture',
  });
  const modules = card.data[0].modules;
  assert.deepEqual(modules[3].btns[0], {
    type: 'button',
    event: 'link-to',
    value: 'https://cast.example/share?t=fixture',
    text: '点击开始共享',
    theme: 'success',
  });
  assert.match(JSON.stringify(card), /点击开始共享/);
});
