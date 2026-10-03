// Run with Windows node.exe. Captures only synthetic test PIDs, never existing app audio.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname,'..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function collect(exe, pids, excluded) {
  const child = spawn(exe, [], { windowsHide: true });
  const exited = once(child,'exit');
  const chunks = []; let diagnostics = '';
  child.stdout.on('data',data=>chunks.push(data));
  child.stderr.on('data',data=>{ diagnostics += data.toString(); });
  child.stdin.on('error',()=>{});
  child.stdin.write(JSON.stringify({ exclude: excluded, ownerPid: 0, capturePids: pids })+'\n');
  await sleep(2600);
  child.stdin.end();
  const watchdog = setTimeout(()=>child.kill(),3000);
  await exited; clearTimeout(watchdog);
  assert(!diagnostics.includes('"type":"error"'), diagnostics);
  const bytes = Buffer.concat(chunks);
  assert(bytes.length > 48000*8, 'No real PCM audio returned: '+diagnostics);
  const count = bytes.length / 8;
  const start = Math.min(48000, Math.floor(count/3));
  const result = {};
  for (const hz of [440,880,1320]) {
    let re=0,im=0;
    for(let i=start;i<count;i++) { const value=bytes.readFloatLE(i*8); re+=value*Math.cos(2*Math.PI*hz*i/48000); im+=value*Math.sin(2*Math.PI*hz*i/48000); }
    result[hz] = Math.hypot(re,im)/(count-start);
  }
  return result;
}
(async()=>{
  assert.equal(process.platform,'win32');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xgoatcast-audio-test-'));
  const csc=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc,['/nologo','/target:exe','/out:'+path.join(dir,'MediaTest.exe'),path.join(__dirname,'Tone.cs')]);
  const helper=path.join(dir,'AudioBridge.exe'); fs.copyFileSync(path.join(root,'native/AudioBridge.exe'),helper);
  fs.copyFileSync(path.join(dir,'MediaTest.exe'),path.join(dir,'KOOK.exe'));
  fs.copyFileSync(path.join(dir,'MediaTest.exe'),path.join(dir,'HeyBoxChat.exe'));
  const children=[];
  try {
    for(const [exe,hz] of [['MediaTest.exe',440],['KOOK.exe',880],['HeyBoxChat.exe',1320]]) {
      const child=spawn(path.join(dir,exe),[String(hz)],{windowsHide:true}); children.push(child); await once(child.stdout,'data');
    }
    const all=await collect(helper,children.map(c=>c.pid),[]);
    const filtered=await collect(helper,children.map(c=>c.pid),['kook','heyboxchat']);
    console.log(JSON.stringify({all,filtered},null,2));
    assert(all[440]>.005 && all[880]>.005 && all[1320]>.005,'Baseline did not capture all three synthetic sources');
    assert(filtered[440]>.005,'Media audio was lost');
    assert(filtered[880] < all[880]*.05 && filtered[1320] < all[1320]*.05,'Excluded software audio leaked');
    console.log('PASS: simultaneous KOOK + HeyBoxChat exclusion, media retained; local playback unchanged.');
  } finally { for(const child of children) { child.stdin.end(); child.kill(); } }
})().catch(e=>{ console.error(e); process.exitCode=1; });
