// Windows-only UI checks. Synthetic fixtures never register protocols or join a room.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
assert.equal(process.platform, 'win32', 'Run with Windows Node.js');
const exe = path.resolve(process.argv[2] || path.join(__dirname, 'out/XgoatCast-win-x64/XgoatCast.exe'));
const output = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'xgoatcast-ui-console-'));
fs.mkdirSync(output, {recursive: true});
function run(args) {
  const result = spawnSync(exe, args, {timeout: 30000, windowsHide: true});
  assert.equal(result.status, 0, `${args[0]} failed: ${result.error || ''}`);
}
const renders = [
  ['--render-test', 'expanded', 1000, 820],
  ['--render-registration', 'dpi150', 1500, 1230],
  ['--render-audio', 'waiting', 480, 260],
  ['--render-sharing', 'sharing', 560, 480],
  ['--render-ready', 'ready', 1000, 820],
  ['--render-countdown', 'countdown', 560, 480],
];
for (const [flag, name, width, height] of renders) {
  const filename = path.join(output, name + '.png');
  run([flag, filename]);
  const png = fs.readFileSync(filename);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), width, `${name} width`);
  assert.equal(png.readUInt32BE(20), height, `${name} height`);
}
const report = path.join(output, 'interaction.json');
run(['--ui-test', report]);
const interactions = JSON.parse(fs.readFileSync(report, 'utf8'));
for (const key of [
  'aboutDialog', 'trayHoverRendering', 'updatePrompt', 'microphoneSelection', 'sharedStatusFooter', 'inlineAutoStop', 'framelessWindow', 'dpiIcons', 'waitingConnection', 'connectionPriority', 'trayMenuPlacement', 'blockedSmallPanel', 'customMenus', 'selectionPreview', 'qualityMenuPolicy', 'pointerCancellation', 'sourceSelection', 'compactHitTargets', 'waitingGuard',
  'reducedMotion', 'immediateExpansion', 'countdownSemantics', 'hoverHints',
  'independentSoundPanel', 'compactControlsHidden', 'layoutBounds', 'scrollRegions',
  'titlebarHitTargets', 'automaticLayout', 'compactAudioInteraction',
  'previewPresentation', 'waitingHasNoTimer', 'noManualLayout', 'audioRefreshCancellation',
]) assert.equal(interactions[key], true, key);
const policyReport = path.join(output, 'policy.txt');
run(['--self-test', policyReport]);
assert.match(fs.readFileSync(policyReport, 'utf8'), /tests passed/);
run(['--smoke']);
const result = {renders: renders.map(([,name,width,height]) => ({name,width,height})), interactions, policy: true, startup: true};
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({output, ...result}, null, 2));
