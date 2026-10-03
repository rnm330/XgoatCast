import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseService } from '../src/modules/database/database.service';
import { KookEventRouter } from '../src/modules/kook/kook-event.router';
import { KookWebhookEnvelope } from '../src/modules/kook/kook-event.types';
import { KookService } from '../src/modules/kook/kook.service';
import { KookWebhookRepository } from '../src/modules/kook/kook-webhook.repository';
import { KookWebhookWorker } from '../src/modules/kook/kook-webhook.worker';

function harness() {
  const created: any[] = [];
  const cards: string[] = [];
  const notices: string[] = [];
  const cancelled: string[] = [];
  const service = new KookService({
    createSession: (input: any) => {
      const session = { ...input, id: `session-${created.length}`, token: `token-${created.length}` };
      created.push(session);
      return session;
    },
    hasActiveSession: () => false,
    cancelPendingSession: (id: string) => cancelled.push(id),
  } as any, {
    getSpace: (_platform: string, id: string) => ({
      serverId: id, bound: 1, status: 'active', allowedQualities: '[]', triggerWords: '屏幕共享',
    }),
    getGlobalConfig: () => ({ publicDomain: 'https://cast.example' }),
  } as any, {} as any, {} as any);
  const bot = {
    getBotId: () => 'bot',
    isOwnMessage: () => false,
    getChannelInfo: async () => ({ guild_id: 'guild' }),
    sendTempCardMessage: async (_channel: string, _card: unknown, user: string) => { cards.push(user); },
    sendTempTextMessage: async (_channel: string, text: string) => { notices.push(text); },
  };
  (service as any).bot = bot;
  return { service, router: new KookEventRouter(service), bot, created, cards, notices, cancelled };
}

let eventId = 0;
function envelope(kind: 'message' | 'button', user = 'user', channel = 'channel'): KookWebhookEnvelope {
  return {
    s: 0,
    d: kind === 'message' ? {
      type: 9, msg_id: `event-${eventId++}`, content: '屏幕共享', author_id: user,
      target_id: channel, extra: { guild_id: 'guild', author: { username: user } },
    } : {
      type: 255, msg_id: `event-${eventId++}`, extra: {
        type: 'message_btn_click', guild_id: 'guild',
        body: { user_id: user, target_id: channel, value: 'reshare', user_info: { username: user } },
      },
    },
  };
}

test('buttons and messages share one user CD, silently ignoring repeats across channels', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  await h.router.route(envelope('message'));
  for (let i = 1; i <= 9; i++) {
    now += 1_000;
    await h.router.route(envelope(i % 2 ? 'button' : 'message', 'user', `channel-${i}`));
  }
  assert.equal(h.created.length, 1);
  assert.equal(h.cards.length, 1);
  assert.equal(h.notices.length, 0);
  await h.router.route(envelope('button', 'other-user'));
  assert.equal(h.cards.length, 2, 'different users do not share CD');
  now = 110_000;
  await h.router.route(envelope('button'));
  assert.equal(h.created.length, 3, 'a new request is accepted exactly ten seconds after the first');
});

test('CD starts before sending, not after the response; old queued requests remain ignored', async (t) => {
  let now = 200_000;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const send = h.bot.sendTempCardMessage;
  h.bot.sendTempCardMessage = async (...args) => {
    await send(...args);
    if (h.cards.length === 1) now += 10_000;
  };
  await h.router.route(envelope('button'), 200_000);
  await h.router.route(envelope('message'), 201_000);
  assert.equal(h.cards.length, 1);
  assert.equal(h.notices.length, 0);
  await h.router.route(envelope('message'), 210_000);
  assert.equal(h.cards.length, 2, 'the new request does not wait another CD after the slow response');
});

test('failed delivery keeps CD; later fresh requests are allowed without an extra wait', async (t) => {
  let now = 300_000;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const send = h.bot.sendTempCardMessage;
  h.bot.sendTempCardMessage = async (...args) => {
    await send(...args);
    if (h.cards.length === 1) throw new Error('network failure');
  };
  await h.router.route(envelope('message'));
  now += 1_000;
  await h.router.route(envelope('button'));
  assert.equal(h.cards.length, 1);
  assert.equal(h.notices.length, 1, 'only the original failure notice is sent, no CD notices');
  now = 310_000;
  await h.router.route(envelope('button'));
  assert.equal(h.cards.length, 2);
});

test('persisted inbox arrival time survives queue delay and overrides timestamps in the payload', async (t) => {
  let now = 400_000;
  t.mock.method(Date, 'now', () => now);
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'xgoat-kook-cooldown-'));
  process.chdir(root);
  let db: DatabaseService | undefined;
  try {
    db = new DatabaseService();
    const repository = new KookWebhookRepository(db);
    const h = harness();
    const worker = new KookWebhookWorker(repository, h.router, h.service);
    repository.enqueue(envelope('message'));
    now = 401_000;
    const repeated = envelope('button');
    repeated.d.receivedAt = 999_999;
    repository.enqueue(repeated);
    now = 402_000;
    const first = repository.claim()!;
    assert.equal(first.receivedAt, 400_000);
    await (worker as any).processEvent(first);
    now = 430_000;
    const second = repository.claim()!;
    assert.equal(second.receivedAt, 401_000);
    await (worker as any).processEvent(second);
    assert.equal(h.created.length, 1, 'the old click must not become eligible after waiting in the queue');
    assert.equal(h.notices.length, 0);
    repository.enqueue(envelope('message'));
    await (worker as any).processEvent(repository.claim()!);
    assert.equal(h.created.length, 2, 'a genuinely new request is accepted');
  } finally {
    db?.onModuleDestroy();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
