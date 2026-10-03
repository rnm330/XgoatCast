// Run using Windows Node.js; only the synthetic tone processes are captured.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const exe = path.resolve(process.argv[2] || path.join(__dirname, 'out/XgoatCast-win-x64/XgoatCast.exe'));
const tone = path.resolve(process.argv[3] || path.join(__dirname, '../test/Tone.cs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(args) {
  const child = spawn(exe, args, {windowsHide: true});
  const timer = setTimeout(() => child.kill(), 30000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, 'Native test failed: '+args.join(' ')); }
  finally { clearTimeout(timer); }
}
async function capture(dir, name, pids, excluded, included, toggleOff) {
  const config = path.join(dir, name+'.json'), output = path.join(dir, name+'.pcm');
  fs.writeFileSync(config, JSON.stringify({pids, excluded, included, toggleOff}));
  await run(['--audio-test', config, output]);
  const data = fs.readFileSync(output), count = data.length/4;
  assert(count > 96000, 'Insufficient PCM data');
  const result = {};
  for (const hz of [440, 880, 1320]) {
    // Average short-window magnitudes: loopback packet boundaries can shift
    // phase, so a single multi-second coherent sum would cancel real audio.
    let amplitude=0, windows=0;
    for(let start=48000;start+4800<=count;start+=4800){
      let re=0,im=0;
      for(let i=start;i<start+4800;i++){
        const v=data.readInt16LE(i*4)/32768,phase=2*Math.PI*hz*i/48000;
        re+=v*Math.cos(phase);im+=v*Math.sin(phase);
      }
      amplitude+=Math.hypot(re,im)/4800;windows++;
    }
    result[hz]=amplitude/windows;
  }
  return result;
}
(async () => {
  assert.equal(process.platform, 'win32');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'xgoatcast-cpp-test-'));
  const report=path.join(dir, 'self-test.txt');
  await run(['--self-test', report]);
  assert.match(fs.readFileSync(report, 'utf8'), /tests passed/);
  for(const name of ['screen','registration','audio']){
    const png=path.join(dir,name+'.png');await run([name==='screen'?'--render-test':'--render-'+name,png]);
    const data=fs.readFileSync(png);assert.equal(data.subarray(1,4).toString(),'PNG');
    assert.equal(data.readUInt32BE(16),name==='audio'?480:name==='registration'?1800:1200);assert.equal(data.readUInt32BE(20),name==='audio'?320:name==='registration'?1230:820);
  }
  const sdkReport=path.join(dir,'sdk-test.txt');await run(['--sdk-test',sdkReport]);
  assert.match(fs.readFileSync(sdkReport,'utf8'),/enumeration passed/);
  await run(['--smoke']);
  const csc=path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/out:'+path.join(dir, 'MediaTest.exe'), tone]);
  for (const name of ['KOOK.exe', 'HeyBoxChat.exe']) fs.copyFileSync(path.join(dir, 'MediaTest.exe'), path.join(dir, name));
  const children=[];
  try {
    for (const [name, hz] of [['MediaTest.exe',440], ['KOOK.exe',880], ['HeyBoxChat.exe',1320]]) {
      const child=spawn(path.join(dir,name), [String(hz)], {windowsHide:true});
      children.push(child); await Promise.race([once(child.stdout,'data'),delay(5000).then(()=>{throw Error('Tone startup timeout');})]);
    }
    const pids=children.map(child=>child.pid);
    const baseline=await capture(dir,'baseline',pids,[]);
    const filtered=await capture(dir,'filtered',pids,['kook','heyboxchat']);
    assert([440,880,1320].every(hz=>baseline[hz]>.005), 'Baseline missing synthetic audio');
    assert(filtered[440]>.005, 'Allowed media audio missing');
    assert(filtered[880]<baseline[880]*.05 && filtered[1320]<baseline[1320]*.05, 'Excluded synthetic audio leaked');
    const muted=await capture(dir,'muted',pids,[],[]);
    assert([440,880,1320].every(hz=>muted[hz]<.0001),'Default-off audio leaked');
    const selected=await capture(dir,'selected',pids,[],['mediatest']);
    assert(selected[440]>.005 && selected[880]<baseline[880]*.05 && selected[1320]<baseline[1320]*.05,'Explicit inclusion failed');
    await capture(dir,'toggle',pids,[],['mediatest'],true);
    const toggled=fs.readFileSync(path.join(dir,'toggle.pcm'));
    let early=0,late=0;
    for(let i=24000;i<48000;i++)early+=Math.abs(toggled.readInt16LE(i*4));
    for(let i=110000;i<134000;i++)late+=Math.abs(toggled.readInt16LE(i*4));
    assert(early>24000*50 && late<early*.01,'Turning program audio off did not silence capture');
    const results={passed:true,baseline,filtered,muted,selected,liveToggle:true,checks:['URI validation','audio process-tree policy','waiting window and shared-source/audio setup at 100%/150% DPI','window/tray startup and shutdown','SDK initialization/custom audio track/source handles (no images)','real WASAPI synthetic audio filtering'],note:'No real RTC publish or real voice-app compatibility test.'};
    fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results,null,2));console.log('Reports: '+dir);
  } finally { for(const child of children){child.stdin.end();child.kill();} }
})().catch(error=>{console.error(error);process.exitCode=1;});
