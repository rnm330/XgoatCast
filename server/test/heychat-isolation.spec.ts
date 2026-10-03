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

test('Heychat implementation is reachable only through its root module import', () => {
  const illegalImports = allTypeScriptFiles(srcRoot)
    .filter((path) => !path.includes('/modules/heychat/'))
    .filter((path) => relative(srcRoot, path) !== 'app.module.ts')
    .filter((path) => /from\s+['"][^'"]*\/heychat(?:\/|['"])/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(srcRoot, path));

  assert.deepEqual(illegalImports, []);
  assert.match(source('src/app.module.ts'), /import \{ HeychatModule \} from '\.\/modules\/heychat\/heychat\.module'/);
  assert.doesNotMatch(source('src/modules/heychat/heychat.module.ts'), /exports\s*:/);
});

test('Heychat owns its transport, cards, commands, and lifecycle adapter', () => {
  const service = source('src/modules/heychat/heychat.service.ts');
  const api = source('src/modules/heychat/heychat-api.client.ts');
  const gateway = source('src/modules/heychat/heychat-gateway.service.ts');

  assert.match(service, /implements OnModuleInit, OnModuleDestroy, PlatformSessionAdapter/);
  assert.match(service, /readonly platform = 'heychat' as const/);
  assert.match(service, /platformRegistry\.register\(this\)/);
  assert.doesNotMatch(service, /EventBusService/);
  assert.match(api, /PRIVATE_MESSAGE_GAP_MS = 7_000/);
  assert.match(api, /\/chatroom\/v2\/channel_msg\/update/);
  assert.match(api, /\/chatroom\/v3\/msg\/user/);
  assert.match(gateway, /wss:\/\/chat\.xiaoheihe\.cn\/chatroom\/ws\/connect/);
  assert.match(gateway, /socket\.send\('PING'/);
});

test('platform-neutral core has no Heychat protocol knowledge', () => {
  for (const file of [
    'src/modules/session/session.service.ts',
    'src/modules/session/session.types.ts',
    'src/modules/events/events.service.ts',
    'src/modules/share/share.controller.ts',
    'src/modules/platform/platform-session.adapter.ts',
  ]) {
    assert.doesNotMatch(source(file), /xiaoheihe|chatroom\/v[23]|card_message_btn_click/i, file);
  }
});
