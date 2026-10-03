// Windows-only anonymous connectivity checks. Never register a protocol or join a room.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
assert.equal(process.platform, 'win32');
const exe = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
fs.mkdirSync(output, {recursive: true});
let mode = 'sequence', requests = 0;
const healthy = {canonicalPlatform: 'kook', legacyAdminSunsetAt: 0};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  assert.equal(url.pathname, '/api/meta/admin-migration');
  assert.equal(url.searchParams.has('t'), false);
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers['cache-control'], 'no-cache');
  requests++;
  let status = 200, body = healthy;
  if (mode === 'sequence') {
    if (requests === 2) status = 503;
    if (requests === 3) body = {unrelated: true};
  } else if (mode === 'unavailable') status = 503;
  else if (mode === 'unauthorized') status = 401;
  else if (mode === 'wrong-site') body = {ok: true};
  else if (mode === 'bad-shape') body = {canonicalPlatform: 'kook', legacyAdminSunsetAt: 'not-a-number'};
  else if (mode === 'html') body = '<html>Cached homepage</html>';
  else if (mode === 'redirect') {status = 302; res.setHeader('Location', '/');}
  const send = () => {res.writeHead(status, {'Content-Type': 'application/json'});res.end(typeof body === 'string' ? body : JSON.stringify(body));};
  if (mode === 'sequence' && requests >= 5) setTimeout(send, 220);
  else send();
});
function run(args, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {windowsHide: true});
    const timer = setTimeout(() => {child.kill();reject(Error('Connectivity test timed out'));}, 10000);
    child.once('error', reject);
    child.once('exit', code => {clearTimeout(timer);try {assert.equal(code, expected);resolve();} catch (error) {reject(error);}});
  });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const report = path.join(output, 'server-monitor.json');
    await run(['--server-test', origin, report], 0);
    const transitions = JSON.parse(fs.readFileSync(report, 'utf8'));
    for (const value of Object.values(transitions)) assert.equal(value, true);
    for (const scenario of ['valid', 'unavailable', 'unauthorized', 'wrong-site', 'bad-shape', 'html', 'redirect']) {
      mode = scenario;
      await run(['--server-probe', origin, path.join(output, scenario+'.json')], scenario === 'valid' ? 0 : 1);
    }
    const results = {transitions, rejectsErrorsAndInvalidResponses: true, anonymous: true, localFixture: true};
    fs.writeFileSync(path.join(output, 'connectivity-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {server.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
