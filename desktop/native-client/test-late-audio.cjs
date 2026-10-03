// Captures only this fixture's parent PID and its late child. Does not join a room.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
assert.equal(process.platform, 'win32');
const exe = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const baseline = process.argv[4] === '--baseline';
const fixture = path.join(output, 'fixtures', 'QQMusic');
fs.mkdirSync(path.join(fixture, 'qmbrowser'), {recursive: true});
const parent = path.join(fixture, 'QQMusic.exe'), helper = path.join(fixture, 'qmbrowser', 'qmbrowser.exe');
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
execFileSync(compiler, ['/nologo','/target:exe','/out:'+parent,path.join(__dirname,'ToneDynamic.cs')]);
fs.copyFileSync(parent, helper);
function amplitude(data, hz, start, end) {
  let sum=0, windows=0;
  for(let offset=start*48000;offset+4800<=Math.min(end*48000,data.length/4);offset+=4800){
    let re=0,im=0;
    for(let i=offset;i<offset+4800;i++){
      const value=data.readInt16LE(i*4)/32768,phase=2*Math.PI*hz*i/48000;
      re+=value*Math.cos(phase);im+=value*Math.sin(phase);
    }
    sum+=Math.hypot(re,im)/4800;windows++;
  }
  assert(windows>0);return sum/windows;
}
(async()=>{
  const tone=spawn(parent,['440',helper],{windowsHide:true,stdio:['pipe','pipe','inherit']});
  try{
    await once(tone.stdout,'data');
    const pcm=path.join(output,'late-audio.pcm'), config=path.join(output,'late-audio.json');
    fs.writeFileSync(config,JSON.stringify({pids:[tone.pid],excluded:[],included:baseline?['qqmusic']:[],toggleOn:!baseline,includedAfter:['qqmusic'],captureMs:5500}));
    const capture=spawn(exe,['--audio-test',config,pcm],{windowsHide:true});
    const timer=setTimeout(()=>capture.kill(),20000);
    const [code]=await once(capture,'exit');clearTimeout(timer);assert.equal(code,0);
    const data=fs.readFileSync(pcm);
    const measurements={muted:amplitude(data,440,.2,.8),enabledParent:amplitude(data,440,1.6,2.1),lateParent:amplitude(data,440,baseline?2.85:3.5,baseline?3.15:4.5),lateHelper:amplitude(data,880,baseline?2.85:3.5,baseline?3.15:4.5)};
    assert(measurements.enabledParent>.002,'Toggle on did not create capture');
    if (baseline) {
      assert(measurements.lateParent<measurements.enabledParent*.1,'Old client did not reproduce the late-helper mute');
      const report={oldBugReproduced:true,measurements};
      fs.writeFileSync(path.join(output,'late-audio-baseline.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return;
    }
    assert(measurements.muted<measurements.enabledParent*.1,'Audio was captured before enabling');
    assert(measurements.lateParent>measurements.enabledParent*.5,'Late helper muted the selected parent');
    assert(measurements.lateHelper>.002,'Late helper was not captured');
    const report={toggleDuringCapture:true,lateProcessCaptured:true,parentKeepsPlaying:true,fixtureOnly:true,measurements};
    fs.writeFileSync(path.join(output,'late-audio-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{
    tone.stdin.end('\n');
    if(tone.exitCode===null)await once(tone,'exit');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
