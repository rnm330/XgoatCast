import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const serverRoot = join(__dirname, '..');
const srcRoot = join(serverRoot, 'src');

function source(path: string): string {
  return readFileSync(join(serverRoot, path), 'utf8');
}

function allTypeScriptFiles(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? allTypeScriptFiles(child) : [child];
  }).filter((path) => path.endsWith('.ts'));
}

test('KOOK owns its API, card, and event implementation behind one module import', () => {
  const illegalImports = allTypeScriptFiles(srcRoot)
    .filter((path) => !path.includes('/modules/kook/'))
    .filter((path) => relative(srcRoot, path) !== 'app.module.ts')
    .filter((path) => /from\s+['"][^'"]*\/kook(?:\/|['"])/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(srcRoot, path));

  assert.deepEqual(illegalImports, []);
  assert.match(source('src/app.module.ts'), /import \{ KookModule \} from '\.\/modules\/kook\/kook\.module'/);
});

test('KOOK lifecycle delivery uses the platform adapter, never the global event bus', () => {
  const kook = source('src/modules/kook/kook.service.ts');
  assert.doesNotMatch(kook, /EventBusService/);
  assert.match(kook, /implements OnModuleInit, OnModuleDestroy, PlatformSessionAdapter/);
  assert.match(kook, /readonly platform = 'kook' as const/);
  assert.match(kook, /platformRegistry\.register\(this\)/);
  assert.match(kook, /async onSessionStarted\(event: SessionStartedEvent\)/);
  assert.match(kook, /async onSessionEnded\(event: SessionEndedEvent\)/);
});

test('core lifecycle events expose platform-neutral identifiers', () => {
  const events = source('src/modules/events/events.service.ts');
  assert.match(events, /extends PlatformSessionContext/);
  assert.doesNotMatch(events, /targetChannelId:/);
  assert.doesNotMatch(events, /guildId:/);
  assert.doesNotMatch(events, /cardMessageId\??:/);

  const session = source('src/modules/session/session.service.ts');
  assert.match(session, /\.\.\.this\.getPlatformContext\(session\)/);
  assert.match(session, /platformMessageId: session\.platformMessageId/);

  const sessionModel = source('src/modules/session/session.types.ts');
  assert.doesNotMatch(sessionModel, /guildId:/);
  assert.doesNotMatch(sessionModel, /targetChannelId:/);
  assert.doesNotMatch(sessionModel, /cardMessageId\??:/);

  const shareController = source('src/modules/share/share.controller.ts');
  assert.match(shareController, /req\.session\.spaceId/);
  assert.doesNotMatch(shareController, /req\.session\.guildId/);
});
