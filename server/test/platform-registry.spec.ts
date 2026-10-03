import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEndedEvent, SessionStartedEvent } from '../src/modules/events/events.service';
import type { PlatformSessionAdapter } from '../src/modules/platform/platform-session.adapter';
import { PlatformRegistryService } from '../src/modules/platform/platform-registry.service';

function started(platform: 'kook' | 'heychat'): SessionStartedEvent {
  return {
    platform,
    spaceId: `${platform}:internal`,
    externalSpaceId: `${platform}:space`,
    externalChannelId: `${platform}:channel`,
    sessionId: `${platform}:session`,
    token: 'test-token',
    sharerUsername: 'tester',
  };
}

function ended(platform: 'kook' | 'heychat'): SessionEndedEvent {
  return {
    ...started(platform),
    reason: 'test',
    platformMessageId: `${platform}:message`,
  };
}

test('registry routes lifecycle events only to the owning platform adapter', async () => {
  const registry = new PlatformRegistryService();
  const calls: string[] = [];
  const adapter = (platform: 'kook' | 'heychat'): PlatformSessionAdapter => ({
    platform,
    async onSessionStarted(event) {
      calls.push(`${platform}:started:${event.platform}`);
    },
    async onSessionEnded(event) {
      calls.push(`${platform}:ended:${event.platform}`);
    },
  });

  const kook = adapter('kook');
  const heychat = adapter('heychat');
  registry.register(kook);
  registry.register(heychat);

  assert.equal(await registry.dispatchSessionStarted(started('kook')), true);
  assert.equal(await registry.dispatchSessionEnded(ended('heychat')), true);
  assert.deepEqual(calls, ['kook:started:kook', 'heychat:ended:heychat']);
});

test('registry rejects duplicate adapters and stops routing after unregister', async () => {
  const registry = new PlatformRegistryService();
  const kook: PlatformSessionAdapter = {
    platform: 'kook',
    async onSessionStarted() {},
    async onSessionEnded() {},
  };

  registry.register(kook);
  assert.throws(
    () => registry.register({ ...kook }),
    /Platform adapter already registered: kook/,
  );
  registry.unregister(kook);
  assert.equal(await registry.dispatchSessionStarted(started('kook')), false);
});
