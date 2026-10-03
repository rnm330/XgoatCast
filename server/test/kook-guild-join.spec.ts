import assert from 'node:assert/strict';
import test from 'node:test';
import { KookEventRouter } from '../src/modules/kook/kook-event.router';
import { KookService } from '../src/modules/kook/kook.service';

test('self_joined_guild forwards the permission-based invite operator', async () => {
  const calls: any[][] = [];
  const router = new KookEventRouter({
    handleGuildJoin: async (...args: any[]) => { calls.push(args); },
  } as any);

  const handled = await router.route({
    s: 0,
    d: {
      type: 255,
      author_id: '1',
      extra: {
        type: 'self_joined_guild',
        body: { guild_id: 'guild-1', operator_id: 'inviter-1' },
      },
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [['guild-1', '', 'inviter-1']]);
});

test('self_joined_guild accepts compatible inviter fields but rejects the system author', async () => {
  const inviterIds: string[] = [];
  const router = new KookEventRouter({
    handleGuildJoin: async (_guildId: string, _guildName: string, inviterId: string) => {
      inviterIds.push(inviterId);
    },
  } as any);

  await router.route({
    s: 0,
    d: {
      type: 255,
      author_id: '1',
      extra: {
        type: 'self_joined_guild',
        body: { guild_id: 'guild-1', inviter: { id: 'inviter-2' } },
      },
    },
  });
  await router.route({
    s: 0,
    d: {
      type: 255,
      author_id: 'inviter-3',
      extra: { type: 'self_joined_guild', body: { guild_id: 'guild-2' } },
    },
  });
  await router.route({
    s: 0,
    d: {
      type: 255,
      author_id: '1',
      extra: { type: 'self_joined_guild', body: { guild_id: 'guild-3' } },
    },
  });

  assert.deepEqual(inviterIds, ['inviter-2', 'inviter-3', '']);
});

function makeJoinHarness(options?: {
  ownerId?: string;
  botId?: string;
  failRecipient?: string;
}) {
  const ownerId = options?.ownerId ?? 'owner-1';
  const sentRecipients: string[] = [];
  const cards: unknown[] = [];
  const serverEvents: any[][] = [];
  const db = {
    createSpace: (input: any) => ({ guildName: input.displayName }),
    addServerEvent: (...args: any[]) => serverEvents.push(args),
    getGlobalConfig: () => ({ publicDomain: 'https://cast.example' }),
    generateBindToken: () => 'bind-token',
  };
  const service = new KookService(
    {} as any,
    db as any,
    {} as any,
    { recordServerEvent: () => undefined } as any,
  );
  (service as any).delay = async () => undefined;
  (service as any).bot = {
    getBotId: () => options?.botId || 'bot-1',
    getGuild: async () => ({
      id: 'guild-1',
      user_id: ownerId,
      open_id: 'public-1',
      name: '测试服务器',
    }),
    getGuildChannels: async () => [{ id: 'text-1', type: 1 }],
    sendTempCardMessage: async (_channelId: string, card: unknown, recipientId: string) => {
      sentRecipients.push(recipientId);
      cards.push(card);
      if (recipientId === options?.failRecipient) throw new Error('fixture delivery failure');
    },
  };
  return { service, sentRecipients, cards, serverEvents };
}

test('guild join sends separate private cards to inviter and owner', async () => {
  const harness = makeJoinHarness({ failRecipient: 'inviter-1' });

  await harness.service.handleGuildJoin('guild-1', '', 'inviter-1');

  assert.deepEqual(harness.sentRecipients, ['inviter-1', 'owner-1']);
  assert.equal(harness.cards.length, 2);
  assert.match(JSON.stringify(harness.cards[0]), /本次机器人邀请人或服务器主/);
  assert.match(JSON.stringify(harness.cards[0]), /https:\/\/cast\.example\/kook\/guild-1\?t=bind-token/);
  assert.equal(harness.serverEvents[0][2], 'inviter-1');
});

test('guild join de-duplicates the card when inviter is the owner', async () => {
  const harness = makeJoinHarness({ ownerId: 'owner-1' });

  await harness.service.handleGuildJoin('guild-1', '测试服务器', 'owner-1');

  assert.deepEqual(harness.sentRecipients, ['owner-1']);
});
