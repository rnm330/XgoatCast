import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/modules/database/database.service';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';

test('platform coverage separates members, unknown counts and removed spaces; records retain platform labels', async () => {
  const cwd = process.cwd(); const dir = mkdtempSync(join(tmpdir(), 'platform-analytics-'));
  process.chdir(dir); const db = new DatabaseService(); const analytics = new AnalyticsService(db);
  try {
    const spaces = ['kook','heychat','qq'].map(platform => db.createSpace({ platform, externalId: 'same-id', displayName: 'Same name', ownerId: '' }));
    analytics.upsertServerMemberCount(spaces[0].serverId, 100);
    analytics.upsertServerMemberCount(spaces[1].serverId, 20);
    assert.equal(analytics.platformCoverage('kook').memberCount, 100);
    assert.equal(analytics.platformCoverage('heychat').memberCount, 20);
    assert.equal(analytics.platformCoverage('qq').memberCount, null);
    analytics.recordOtherPlatformCoverage();
    await new Promise(resolve => setTimeout(resolve, 3));
    const series = analytics.getOverview({ range: '24h' }).coverageSeriesByPlatform;
    assert.equal(series.heychat.at(-1).memberCount, 20);
    assert.equal(series.qq.at(-1).memberCount, null);
    analytics.upsertServerMemberCount(spaces[2].serverId, 8);
    assert.equal(analytics.platformCoverage('qq').memberCount, 8);
    for (const space of spaces) analytics.recordServerEvent({ serverSnowflakeId: space.serverId, eventType: 'bot_joined', occurredAt: Date.now() - 1000 });
    for (const platform of ['kook','heychat','qq']) {
      const state = analytics.getRecords({ type: 'server', platform, range: 'all' });
      assert.equal(state.total, 1); assert.equal((state.items[0] as any).platform, platform);
      const events = analytics.getRecords({ type: 'server-event', platform, range: 'all' });
      assert.equal(events.total, 1); assert.equal((events.items[0] as any).platform, platform);
    }
    db.kickServer(spaces[2].serverId);
    assert.equal(analytics.platformCoverage('qq').memberCount, 0);
    const realtime = analytics.getRealtime();
    assert.deepEqual(realtime.platformSpaces.qq, { total: 1, active: 0, removed: 1 });
    assert.equal(realtime.coverageByPlatform.heychat.memberCount, 20);
    db.deleteServer(spaces[2].serverId);
    const historical = analytics.getRecords({ type: 'server-event', platform: 'qq', range: 'all' });
    assert.equal((historical.items[0] as any).platform, 'qq');
  } finally { db.onModuleDestroy(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});
