// Integration check using the real Windows Electron runtime and isolated localhost fixture.
// Captures only a generated test window, never joins Agora or transmits a desktop stream.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const path = require('node:path');
const packageRoot = process.argv.find(value => value.startsWith('--package-root='))?.slice('--package-root='.length);
const fixture = http.createServer((req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/api/share/info')) res.end(JSON.stringify({ sharerUsername:'本机原型测试', status:'pending', allowedQualities:['1080p_2'], allowLowLatency:false, allowQualityPreference:true, qualityBitrates:{} }));
  else if(req.url.startsWith('/api/share/token')) res.end(JSON.stringify({appId:'local-test-only',channel:'local-test',token:'',uid:1}));
  else res.end(JSON.stringify({ok:true}));
});
fixture.listen(0,'127.0.0.1',()=>{
  process.argv.push('xgoatcast://share?'+new URLSearchParams({server:'http://127.0.0.1:'+fixture.address().port,t:'a'.repeat(64),cid:'b'.repeat(36),quality:'1080p_2'}));
  require(packageRoot ? path.join(packageRoot, 'resources/app.asar/main.cjs') : '../main.cjs');
  app.whenReady().then(async()=>{
    let target;
    const watchdog=setTimeout(()=>{ console.error('Electron smoke timeout'); app.exit(1); },30000);
    try {
      while(!(target=BrowserWindow.getAllWindows()[0]) || target.webContents.isLoading()) await new Promise(r=>setTimeout(r,200));
      await new Promise(r=>setTimeout(r,1500));
      const bootstrap=await target.webContents.executeJavaScript('window.desktop.bootstrap()');
      assert.equal(bootstrap.platform,'win32');
      const audio=await target.webContents.executeJavaScript('window.desktop.audioApps()');
      assert.equal(audio.supported,true);
      const audioPipeline=await target.webContents.executeJavaScript(`(async()=>{
        const context=new AudioContext({sampleRate:48000});
        await context.audioWorklet.addModule('pcm-worklet.js');
        const node=new AudioWorkletNode(context,'filtered-pcm',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
        const analyser=context.createAnalyser(); analyser.fftSize=256;
        const destination=context.createMediaStreamDestination(); node.connect(analyser); analyser.connect(destination);
        await context.resume();
        const feed=setInterval(()=>node.port.postMessage(new Float32Array(960).fill(.125).buffer),10);
        await new Promise(resolve=>setTimeout(resolve,250));
        const samples=new Float32Array(256); analyser.getFloatTimeDomainData(samples);
        clearInterval(feed);
        const result={state:context.state,track:destination.stream.getAudioTracks()[0].readyState,peak:Math.max(...samples)};
        await context.close(); return result;
      })()`);
      assert.equal(audioPipeline.state,'running'); assert.equal(audioPipeline.track,'live'); assert(audioPipeline.peak>.1);
      console.log('PASS isolated PCM worklet → custom MediaStream audio pipeline:',JSON.stringify(audioPipeline));
      const toneWindow=new BrowserWindow({width:640,height:400,title:'XgoatCast Synthetic Capture Test',webPreferences:{sandbox:true}});
      await toneWindow.loadURL('data:text/html,<title>XgoatCast Synthetic Capture Test</title><body style="background:%2365dfb5;font:32px sans-serif">XgoatCast local capture test</body>');
      const result=await target.webContents.executeJavaScript(`(async()=>{
        await window.desktop.info();
        const sources=await window.desktop.sources();
        const source=sources.find(s=>s.name==='XgoatCast Synthetic Capture Test');
        if(!source) throw new Error('Synthetic window missing from desktop sources');
        await window.desktop.begin({sourceId:source.id,audio:false,presets:[],executables:[]});
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:source.id,maxWidth:640,maxHeight:400,maxFrameRate:15}}});
        const track=stream.getVideoTracks()[0];
        const result={screenCount:sources.filter(s=>s.kind==='screen').length,windowCount:sources.filter(s=>s.kind==='window').length,trackState:track.readyState,settings:track.getSettings()};
        const preview=document.createElement('video'); preview.muted=true; preview.srcObject=stream; await preview.play();
        const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=400;
        const ctx=canvas.getContext('2d');
        for(let attempt=0;attempt<30;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,100));
          ctx.drawImage(preview,0,0,640,400);
          result.testPixel=[...ctx.getImageData(320,200,1,1).data];
          if(result.testPixel[1]>150 && result.testPixel[0]<150) break;
        }
        track.stop(); await window.desktop.stop(); return result;
      })()`);
      assert.equal(result.trackState,'live'); assert(result.screenCount>0); assert(result.windowCount>0);
      assert(result.testPixel[1]>150 && result.testPixel[0]<150, 'Synthetic window frame did not contain the expected green content: '+JSON.stringify(result));
      console.log('PASS Electron source picker, isolated IPC, server handoff, real Windows window capture:',JSON.stringify(result));
      clearTimeout(watchdog); toneWindow.destroy(); fixture.close(); app.exit(0);
    } catch(e) { console.error(e); clearTimeout(watchdog); fixture.close(); app.exit(1); }
  });
});
