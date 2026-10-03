import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseService } from '../src/modules/database/database.service';
import { KookApiClient, KookApiError } from '../src/modules/kook/kook-api.client';
import { KookService } from '../src/modules/kook/kook.service';

function apiOk(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSpace(id: string) {
  return {
    serverId: id,
    platform: 'kook',
    externalId: id,
    guildName: `guild-${id}`,
    status: 'active',
    bound: 1,
    passwordHash: `password-${id}`,
    agoraAppId: `app-${id}`,
    agoraAppCertificate: `certificate-${id}`,
  } as any;
}

function makeSyncHarness(options: {
  present: string[];
  spaces: any[];
  probe: (guildId: string) => Promise<any>;
}) {
  const spaces = new Map(options.spaces.map((space) => [space.externalId, space]));
  const marked: string[] = [];
  const serverEvents: any[] = [];
  const analyticsEvents: any[] = [];
  let probeCount = 0;
  const db = {
    getSpace: (_platform: string, externalId: string) => spaces.get(externalId),
    listSpaces: () => [...spaces.values()],
    createSpace: () => { throw new Error('unexpected createSpace'); },
    markServerAbsentPreservingBinding: (serverId: string) => {
      const space = spaces.get(serverId);
      if (!space || space.status !== 'active') return false;
      space.status = 'kicked';
      marked.push(serverId);
      return true;
    },
    addServerEvent: (...args: any[]) => serverEvents.push(args),
  };
  const analytics = {
    recordServerEvent: (event: any) => analyticsEvents.push(event),
  };
  const service = new KookService(
    {} as any,
    db as any,
    {} as any,
    analytics as any,
  );
  (service as any).bot = {
    getGuildList: async () => options.present.map((id) => ({ id, name: `guild-${id}` })),
    getGuild: async (guildId: string) => {
      probeCount += 1;
      return options.probe(guildId);
    },
  };
  return {
    service,
    spaces,
    marked,
    serverEvents,
    analyticsEvents,
    get probeCount() { return probeCount; },
  };
}

function consumeScheduledGuildRetry(service: KookService): void {
  const timer = (service as any).staleGuildConfirmationTimer;
  assert.ok(timer, 'expected a bounded KOOK stale-guild retry to be scheduled');
  clearTimeout(timer);
  (service as any).staleGuildConfirmationTimer = null;
}

test('KOOK guild list rejects an incomplete paginated snapshot', async () => {
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    return apiOk({
      items: page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }],
      meta: { page, page_total: 2, total: 4 },
    });
  }) as typeof fetch;
  const client = new KookApiClient('fixture-token', fakeFetch);

  await assert.rejects(
    client.getGuildList(),
    (error: unknown) => error instanceof KookApiError && error.retryable,
  );
});

test('KOOK guild list accepts a complete multi-page snapshot', async () => {
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    return apiOk({
      items: page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }],
      meta: { page, page_total: 2, total: 3 },
    });
  }) as typeof fetch;
  const client = new KookApiClient('fixture-token', fakeFetch);

  assert.deepEqual((await client.getGuildList()).map((guild) => guild.id), ['1', '2', '3']);
});

test('KOOK guild list rejects pagination without a verifiable total', async () => {
  const fakeFetch = (async () => apiOk({
    items: [{ id: '1' }],
    meta: { page: 1, page_total: 1 },
  })) as typeof fetch;
  const client = new KookApiClient('fixture-token', fakeFetch);

  await assert.rejects(
    client.getGuildList(),
    (error: unknown) => error instanceof KookApiError && error.retryable,
  );
});

test('two confirmed 183-of-187 snapshots reclaim only four stale active rows', async () => {
  const allIds = Array.from({ length: 187 }, (_, index) => String(index + 1));
  const present = allIds.slice(0, 183);
  const stale = new Set(allIds.slice(183));
  const harness = makeSyncHarness({
    present,
    spaces: allIds.map(makeSpace),
    probe: async (guildId) => {
      if (stale.has(guildId)) {
        throw new KookApiError(
          'KOOK API /guild/view failed',
          false,
          200,
          40000,
          undefined,
          'The server does not exist or has been deleted.',
        );
      }
      return { id: guildId };
    },
  });

  await (harness.service as any).syncGuilds(false);
  assert.deepEqual(harness.marked, []);
  await (harness.service as any).syncGuilds(false);

  assert.deepEqual(new Set(harness.marked), stale);
  assert.equal([...harness.spaces.values()].filter((space) => space.status === 'active').length, 183);
  assert.equal([...harness.spaces.values()].filter((space) => space.bound === 1).length, 187);
  for (const id of stale) {
    const space = harness.spaces.get(id)!;
    assert.equal(space.passwordHash, `password-${id}`);
    assert.equal(space.agoraAppId, `app-${id}`);
    assert.equal(space.agoraAppCertificate, `certificate-${id}`);
  }
  assert.equal(harness.serverEvents.length, 4);
  assert.equal(harness.analyticsEvents.length, 4);
});

test('partial snapshots and retryable detail failures never bulk-reclaim spaces', async () => {
  const allIds = Array.from({ length: 100 }, (_, index) => String(index + 1));
  const partial = makeSyncHarness({
    present: allIds.slice(0, 50),
    spaces: allIds.map(makeSpace),
    probe: async () => { throw new Error('probe should not run'); },
  });
  await (partial.service as any).syncGuilds(false);
  await (partial.service as any).syncGuilds(false);
  assert.deepEqual(partial.marked, []);
  assert.equal(partial.probeCount, 0);

  const transient = makeSyncHarness({
    present: allIds.slice(0, 95),
    spaces: allIds.map(makeSpace),
    probe: async () => { throw new KookApiError('temporary outage', true, 503); },
  });
  await (transient.service as any).syncGuilds(false);
  await (transient.service as any).syncGuilds(false);
  assert.deepEqual(transient.marked, []);
  assert.equal(transient.probeCount, 10);

  const ambiguousBusinessError = makeSyncHarness({
    present: allIds.slice(0, 95),
    spaces: allIds.map(makeSpace),
    probe: async () => {
      throw new KookApiError(
        'KOOK API /guild/view failed',
        false,
        403,
        40300,
        undefined,
        'Forbidden',
      );
    },
  });
  await (ambiguousBusinessError.service as any).syncGuilds(false);
  await (ambiguousBusinessError.service as any).syncGuilds(false);
  assert.deepEqual(ambiguousBusinessError.marked, []);
  assert.equal(ambiguousBusinessError.probeCount, 10);
});

test('successful guild detail lookup overrides a list omission', async () => {
  const allIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  const harness = makeSyncHarness({
    present: allIds.slice(0, 19),
    spaces: allIds.map(makeSpace),
    probe: async (guildId) => ({ id: guildId }),
  });

  await (harness.service as any).syncGuilds(false);
  await (harness.service as any).syncGuilds(false);
  assert.deepEqual(harness.marked, []);
  assert.equal(harness.probeCount, 2);
});

test('HTTP 403/404 never confirm absence even with definitive-looking KOOK body', async () => {
  const allIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  for (const status of [403, 404]) {
    const harness = makeSyncHarness({
      present: allIds.slice(0, 19),
      spaces: allIds.map(makeSpace),
      probe: async () => {
        throw new KookApiError(
          'KOOK API /guild/view failed',
          false,
          status,
          40000,
          undefined,
          'The server does not exist or has been deleted.',
        );
      },
    });

    await (harness.service as any).syncGuilds(false);
    await (harness.service as any).syncGuilds(false);
    assert.deepEqual(harness.marked, [], `HTTP ${status} must remain inconclusive`);
    assert.equal(harness.probeCount, 2);
  }
});

test('a failed guild-list sync breaks the consecutive absence chain', async () => {
  const allIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  const harness = makeSyncHarness({
    present: allIds.slice(0, 19),
    spaces: allIds.map(makeSpace),
    probe: async () => {
      throw new KookApiError(
        'KOOK API /guild/view failed',
        false,
        200,
        40000,
        undefined,
        'The server does not exist or has been deleted.',
      );
    },
  });
  const bot = (harness.service as any).bot;
  const completeList = bot.getGuildList;

  await (harness.service as any).syncGuilds(false);
  bot.getGuildList = async () => { throw new KookApiError('temporary outage', true, 503); };
  await (harness.service as any).syncGuilds(false);
  bot.getGuildList = completeList;
  await (harness.service as any).syncGuilds(false);
  assert.deepEqual(harness.marked, []);

  await (harness.service as any).syncGuilds(false);
  assert.deepEqual(harness.marked, ['20']);
});

test('a transient detail failure is retried and two later definitive probes reclaim the row', async () => {
  const allIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  let attempt = 0;
  const harness = makeSyncHarness({
    present: allIds.slice(0, 19),
    spaces: allIds.map(makeSpace),
    probe: async () => {
      attempt += 1;
      if (attempt === 1) throw new KookApiError('temporary outage', true, 429);
      throw new KookApiError(
        'KOOK API /guild/view failed',
        false,
        200,
        40000,
        undefined,
        'The server does not exist or has been deleted.',
      );
    },
  });

  await (harness.service as any).syncGuilds(true);
  assert.deepEqual(harness.marked, []);
  consumeScheduledGuildRetry(harness.service);

  await (harness.service as any).syncGuilds(true);
  assert.deepEqual(harness.marked, []);
  consumeScheduledGuildRetry(harness.service);

  await (harness.service as any).syncGuilds(true);
  assert.deepEqual(harness.marked, ['20']);
  assert.equal(harness.probeCount, 3);
  assert.equal((harness.service as any).staleGuildConfirmationTimer, null);
});

test('persistent inconclusive detail probes stop at the bounded retry limit without reclaiming', async () => {
  const allIds = Array.from({ length: 20 }, (_, index) => String(index + 1));
  const harness = makeSyncHarness({
    present: allIds.slice(0, 19),
    spaces: allIds.map(makeSpace),
    probe: async () => { throw new KookApiError('temporary outage', true, 503); },
  });

  await (harness.service as any).syncGuilds(true);
  consumeScheduledGuildRetry(harness.service);
  await (harness.service as any).syncGuilds(true);
  consumeScheduledGuildRetry(harness.service);
  await (harness.service as any).syncGuilds(true);

  assert.deepEqual(harness.marked, []);
  assert.equal(harness.probeCount, 3);
  assert.equal((harness.service as any).staleGuildConfirmationTimer, null);

  await (harness.service as any).syncGuilds(true);
  assert.deepEqual(harness.marked, []);
  assert.equal(harness.probeCount, 3, 'an exhausted candidate must not poll forever');
  assert.equal((harness.service as any).staleGuildConfirmationTimer, null);
});

test('database stale reconciliation preserves binding and Agora configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xgoatcast-kook-sync-'));
  const previousCwd = process.cwd();
  let db: DatabaseService | undefined;
  try {
    process.chdir(directory);
    db = new DatabaseService();
    db.createSpace({
      platform: 'kook',
      externalId: 'guild-1',
      spaceId: 'guild-1',
      displayName: 'Fixture guild',
      ownerId: 'owner-1',
    });
    db.updateServer('guild-1', {
      bound: 1,
      passwordHash: 'fixture-password-hash',
      agoraAppId: 'fixture-app-id',
      agoraAppCertificate: 'fixture-certificate',
    });

    assert.equal(db.markServerAbsentPreservingBinding('guild-1'), true);
    const reconciled = db.getServer('guild-1')!;
    assert.equal(reconciled.status, 'kicked');
    assert.equal(reconciled.bound, 1);
    assert.equal(reconciled.passwordHash, 'fixture-password-hash');
    assert.equal(reconciled.agoraAppId, 'fixture-app-id');
    assert.equal(reconciled.agoraAppCertificate, 'fixture-certificate');
    assert.equal(db.markServerAbsentPreservingBinding('guild-1'), false);
  } finally {
    db?.onModuleDestroy();
    process.chdir(previousCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});
