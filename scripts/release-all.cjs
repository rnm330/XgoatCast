#!/usr/bin/env node
// Build, validate, upload, then deploy the website and server as one release.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parseArgs} = require('node:util');
const {compareVersions} = require('./release-client.cjs');
const root = path.resolve(__dirname, '..');
const {values} = parseArgs({options: {
  stage: {type: 'string'}, toolchain: {type: 'string'}, compiler: {type: 'string'},
  'notes-file': {type: 'string'}, 'env-file': {type: 'string'},
}});
const native = path.join(root, 'desktop/native-client');
const version = fs.readFileSync(path.join(native, 'version.h'), 'utf8').match(/AppVersion\[\]\s*=\s*"([^"]+)"/)?.[1];
compareVersions(version, version);
const notesFile = path.resolve(values['notes-file'] || path.join(root, 'docs/releases', version + '.md'));
if (!fs.readFileSync(notesFile, 'utf8').trim()) throw Error('发布说明不能为空');
const latestFile = path.join(root, 'web/public/downloads/windows/latest.json');
if (fs.existsSync(latestFile)) {
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  if (compareVersions(version, latest.version) <= 0 && latest.sha256) throw Error('请先递增客户端版本；已发布版本不可覆盖');
}
const stage = values.stage ? path.resolve(values.stage) : native;
if (process.platform !== 'win32' && stage === native) throw Error('WSL 发版需要 --stage 指向 Windows 磁盘');
const windows = file => process.platform === 'win32' ? file : execFileSync('wslpath', ['-w', file], {encoding: 'utf8'}).trim();
function run(command, args) { execFileSync(command, args, {cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd')}); }
function node(script, args = []) { run(process.execPath, [path.join(root, script), ...args]); }
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// deploy.sh requires Bash and OpenSSH, also available through Git Bash on Windows.
const shell = process.env.XGOAT_RELEASE_BASH || 'bash';
run(shell, ['-c', 'command -v ssh >/dev/null && command -v scp >/dev/null']);
const windowsNode = process.platform === 'win32' ? process.execPath : process.env.XGOAT_WINDOWS_NODE || '/mnt/c/Program Files/nodejs/node.exe';
if (!fs.existsSync(windowsNode)) throw Error('找不到 Windows Node.js；请设置 XGOAT_WINDOWS_NODE');
console.log('[1/5] 原生客户端构建');
node('desktop/native-client/build.cjs', [`--stage=${stage}`, ...(values.toolchain ? [`--toolchain=${values.toolchain}`] : [])]);
console.log('[2/5] 原生界面、启动、策略和服务端验证');
if (stage !== native) {
  fs.cpSync(path.join(native, 'out/XgoatCast-win-x64'), path.join(stage, 'out/XgoatCast-win-x64'), {recursive: true});
  fs.copyFileSync(path.join(native, 'test-ui.cjs'), path.join(stage, 'test-ui.cjs'));
}
run(windowsNode, [windows(path.join(stage, 'test-ui.cjs')), windows(path.join(stage, 'out/XgoatCast-win-x64/XgoatCast.exe')), windows(path.join(stage, 'release-ui-test'))]);
run(npm, ['test']);
run(npm, ['run', 'test:release']);
console.log('[3/5] 打包 Windows 安装器');
node('desktop/native-client/build-installer.cjs', [`--stage=${path.join(stage, 'installer-package')}`, ...(values.compiler ? [`--compiler=${values.compiler}`] : [])]);
console.log('[4/5] 上传安装器并生成版本清单');
node('scripts/release-client.cjs', ['--notes-file', notesFile, ...(values['env-file'] ? ['--env-file', values['env-file']] : [])]);
console.log('[5/5] 构建并部署网站及服务端');
run(shell, [path.join(root, 'deploy.sh')]);
