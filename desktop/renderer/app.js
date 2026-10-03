import AgoraRTC from 'agora-rtc-sdk-ng';
import { PRESETS } from '../lib/protocol.cjs';
AgoraRTC.setLogLevel(3);
const bridge = window.desktop;
const el = id => document.getElementById(id);
let launch, info, sources = [], selected, kind = 'screen', busy = false, sharing = false, bootPending = false;
let rtc, video, audio, stream, context, pcm, pulse, generation = 0;
let audioSupported = false;
function error(message) { el('error').hidden = !message; el('error').textContent = message; }
function controls() {
  el('start').disabled = busy || sharing || bootPending || !launch || !info || !selected;
  el('start').textContent = busy ? '正在启动…' : '开始共享';
  el('start').hidden = sharing; el('stop').hidden = !sharing && !busy;
  for (const node of document.querySelectorAll('main input, #refresh, .tabs button, .source')) node.disabled = busy || sharing || bootPending;
  el('audio').disabled = el('audio').disabled || !audioSupported;
}
function renderSources() {
  el('sources').replaceChildren();
  for (const source of sources.filter(s => s.kind === kind)) {
    const button = document.createElement('button'); button.className = 'source'; button.setAttribute('aria-pressed', String(selected === source.id));
    const image = document.createElement('img'); image.src = source.thumbnail; image.alt = '';
    const title = document.createElement('span'); title.textContent = source.name; button.title = source.name;
    button.append(image,title); button.onclick = () => { selected = source.id; renderSources(); controls(); };
    el('sources').append(button);
  }
  if (!el('sources').children.length) el('sources').textContent = '没有可用画面，请打开目标窗口后刷新。';
}
async function refresh() {
  try {
    sources = await bridge.sources();
    if (!sources.some(s => s.id === selected)) selected = null;
    renderSources();
    const result = await bridge.audioApps();
    audioSupported = result.supported;
    el('audio').checked = result.supported && el('audio').checked;
    el('audio-status').textContent = result.supported ? '按软件过滤可用 · 共享期间自动发现新的音频进程 · 列表勾选仅用于排除' : '此系统无法按软件过滤音频，请使用仅画面共享（需要 Windows 11）。';
    const previous = new Set([...el('apps').querySelectorAll('input:checked')].map(i => i.value));
    el('apps').replaceChildren();
    for (const name of [...new Set(result.apps.map(a => a.name))]) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = name; input.checked = previous.has(name);
      label.append(input, document.createTextNode(name)); el('apps').append(label);
    }
  } catch (e) { audioSupported = false; el('audio').checked = false; error('音频检查失败，可先仅共享画面：' + e.message); }
  controls();
}
async function load(next) {
  launch = next; info = null; error(''); controls();
  if (!launch) return;
  el('room').textContent = '正在读取共享会话 · ' + launch.server;
  try { info = await bridge.info(); el('room').textContent = `${info.sharerUsername} · ${launch.server} · ${launch.quality} · 无需登录`; }
  catch (e) { error(e.message); }
  controls();
}
async function cleanup() {
  generation++;
  const oldRtc = rtc, oldVideo = video, oldAudio = audio, oldContext = context, oldStream = stream;
  rtc = video = audio = context = pcm = null;
  stream = null;
  clearInterval(pulse);
  oldStream?.getTracks().forEach(t => t.stop());
  oldVideo?.close(); oldAudio?.close();
  if (oldContext) await oldContext.close().catch(() => {});
  if (oldRtc) await oldRtc.leave().catch(() => {});
  sharing = false; busy = false; el('preview').srcObject = null; el('preview').hidden = true; el('sources').hidden = false; el('level').style.width = '0%'; controls();
}
el('start').onclick = async () => {
  if (busy || sharing || bootPending) return;
  busy = true; bootPending = true; controls(); error(''); const run = ++generation;
  const ensure = () => { if (run !== generation) throw new Error('启动已取消'); };
  try {
    pulse = setInterval(() => bridge.pulse(),2000);
    const useAudio = el('audio').checked;
    if (useAudio) {
      context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await context.audioWorklet.addModule('pcm-worklet.js'); ensure();
      pcm = new AudioWorkletNode(context, 'filtered-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      const destination = context.createMediaStreamDestination(); pcm.connect(destination);
      audio = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: destination.stream.getAudioTracks()[0], encoderConfig: 'music_standard_stereo' });
      await context.resume(); ensure();
    }
    const response = await bridge.begin({ sourceId: selected, audio: useAudio, presets: [...el('presets').querySelectorAll('input:checked')].map(i=>i.value), executables: [...el('apps').querySelectorAll('input:checked')].map(i=>i.value).concat(el('custom').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)) });
    ensure(); launch = response.launch;
    const [width,height,frameRate] = PRESETS[launch.quality];
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: response.sourceId, maxWidth: width, maxHeight: height, maxFrameRate: frameRate } } });
    ensure();
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack.addEventListener('ended', () => bridge.stop(), { once: true });
    video = AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: videoTrack, encoderConfig: { width,height,frameRate,...response.info.qualityBitrates?.[launch.quality] }, optimizationMode: launch.optimizationMode });
    el('preview').srcObject = stream; el('preview').hidden = false; el('sources').hidden = true;
    rtc = AgoraRTC.createClient({ mode: launch.lowLatency ? 'rtc' : 'live', codec: 'h264' });
    if (!launch.lowLatency) await rtc.setClientRole('host'); ensure();
    const { appId,channel,token,uid } = response.credentials;
    await rtc.join(appId,channel,token || null,uid); ensure();
    rtc.on('token-privilege-will-expire', () => { error('本次推流凭证即将到期，请停止后重新开始共享。'); void bridge.stop(); });
    rtc.on('connection-state-change', state => { if (state === 'DISCONNECTED' && sharing) void bridge.stop(); });
    await rtc.publish(audio ? [video,audio] : [video]); ensure();
    await bridge.published(); ensure();
    sharing = true; busy = false; el('status').textContent = '正在共享 · 可收起到托盘'; controls();
  } catch (e) { await bridge.stop(); await cleanup(); error(e.message); }
  finally { bootPending = false; controls(); }
};
el('stop').onclick = () => bridge.stop();
el('hide').onclick = () => bridge.hide();
el('refresh').onclick = refresh;
for (const [id,value] of [['screens','screen'],['windows','window']]) el(id).onclick = () => { kind = value; el('screens').setAttribute('aria-pressed',String(kind==='screen')); el('windows').setAttribute('aria-pressed',String(kind==='window')); renderSources(); };
bridge.onLaunch(load); bridge.onStatus(text => { el('status').textContent = text; });
bridge.onStop(() => {
  if (bootPending) {
    generation++;
    stream?.getTracks().forEach(t => t.stop());
    // Startup owns its pending SDK promises and performs final cleanup when they settle.
  } else { void cleanup(); }
});
bridge.onFatal(message => { error(message); });
bridge.onSession(data => { el('status').textContent = `正在共享 · ${data.viewerCount} 人观看`; });
bridge.onAudioStatus(data => { el('audio-status').textContent = `正在采集 ${data.included.length} 个音频进程树 · 已排除勾选的软件及其子进程`; });
bridge.onPCM(bytes => {
  if (!pcm) return;
  const copy = new Uint8Array(bytes).buffer;
  const floats = new Float32Array(copy);
  let peak = 0; for (const f of floats) peak = Math.max(peak, Math.abs(f));
  el('level').style.width = `${Math.min(100, peak * 100)}%`;
  pcm.port.postMessage(copy, [copy]);
});
(async () => {
  const data = await bridge.bootstrap();
  for (const preset of data.exclusions) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.value = preset.id;
    label.append(input, document.createTextNode('屏蔽 ' + preset.label)); el('presets').append(label);
  }
  await load(data.launch); await refresh();
})().catch(e => error(e.message));
