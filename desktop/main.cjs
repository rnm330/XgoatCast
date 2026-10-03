const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, shell, session } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseLaunch } = require('./lib/protocol.cjs');
const { DEFAULT_EXCLUSIONS, buildExclusions } = require('./lib/audio-policy.cjs');
let win, tray, launch = null, helper = null, quitting = false, active = false, claimed = false, starting = false, stopping = false, lastPulse = 0, epoch = 0;
let selectedSource = null, sourceIds = new Set(), trustedServer = null, pollBusy = false;
const localPage = pathToFileURL(path.join(__dirname, 'renderer/index.html')).href;
const helperPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'native/AudioBridge.exe');
const send = (name, data) => { if (win && !win.isDestroyed()) win.webContents.send(name, data); };
function status(text) { send('status', text); if (tray) tray.setToolTip('XgoatCast · ' + text); }
function show() { if (win) { win.show(); win.focus(); } }
function killAudio() { const old = helper; helper = null; if (old) { old.stdin.end(); old.kill(); } }
function receive(argv) {
  const uri = argv.find(a => a.startsWith('xgoatcast:'));
  if (!uri) return;
  try {
    const next = parseLaunch(uri);
    if (active || starting || stopping) { show(); status('当前正在共享或启动中，请先停止再切换会话。'); return; }
    launch = next; trustedServer = null; selectedSource = null;
    send('launch', launch); show();
  } catch (e) { show(); status(e.message); }
}
async function request(endpoint, body, target = launch) {
  if (!target) throw new Error('请先从网页点击“使用 Windows 客户端共享”');
  const url = new URL('/api/share/' + endpoint, target.server);
  url.searchParams.set('t', target.token);
  if (endpoint === 'token') url.searchParams.set('role', 'publisher');
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '共享服务器连接失败');
  return data;
}
async function stop(notifyServer = true) {
  if (stopping) return;
  stopping = true; epoch++;
  const previous = launch;
  const shouldNotify = claimed;
  active = false; starting = false; claimed = false; selectedSource = null;
  killAudio(); send('stop'); status('共享已停止');
  if (notifyServer && shouldNotify && previous) { try { await request('stop', {}, previous); } catch { status('本地共享已停止，服务器暂时无法连接'); } }
  stopping = false;
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame?.url !== localPage) throw new Error('不允许的客户端调用');
    return fn(...args);
  });
}
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', (_event, argv) => { receive(argv); show(); });
  app.whenReady().then(() => {
    win = new BrowserWindow({ width: 1020, height: 820, minWidth: 760, minHeight: 650, show: false, title: 'XgoatCast · Windows 共享', backgroundColor: '#10151d', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('render-process-gone', () => { void stop(); });
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    // Only a locally selected source can be captured; no arbitrary remote page runs here.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === win.webContents && contents.getURL() === localPage && permission === 'media' && !!selectedSource));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === win.webContents && contents.getURL() === localPage && permission === 'media' && !!selectedSource);
    const icon = nativeImage.createFromBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="9" fill="#65dfb5"/><path d="M8 11h16v11H8z" fill="#14251f"/><path d="M13 25h6" stroke="#14251f" stroke-width="3"/></svg>'));
    // SVG is not decoded on every Windows build. Raw BGRA makes the tray deterministic.
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let i=0;i<pixels.length;i+=4) { pixels[i]=181; pixels[i+1]=223; pixels[i+2]=101; pixels[i+3]=255; }
    tray = new Tray(icon.isEmpty() ? nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }) : icon);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开共享控制', click: show },
      { label: '停止共享', click: () => { void stop(); } },
      { type: 'separator' },
      { label: '登录 Windows 后启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--tray'] }) },
      { label: '退出', click: async () => { await stop(); quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', show); status('等待共享');
    win.loadFile(path.join(__dirname, 'renderer/index.html'));
    win.webContents.once('did-finish-load', () => { receive(process.argv); if (!process.argv.includes('--tray')) show(); });

    handle('bootstrap', () => ({ launch, exclusions: DEFAULT_EXCLUSIONS, platform: process.platform }));
    handle('sources', async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      const filtered = sources.filter(s => s.name !== win.getTitle());
      sourceIds = new Set(filtered.map(s => s.id));
      return filtered.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen:') ? 'screen' : 'window' }));
    });
    handle('audio-apps', async () => {
      if (process.platform !== 'win32') return { supported: false, apps: [] };
      const { stdout } = await promisify(execFile)(helperPath, ['--list'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout.replace(/^\uFEFF/, ''));
    });
    handle('info', async () => {
      const data = await request('info');
      trustedServer = launch?.server;
      return data;
    });
    handle('begin', async options => {
      if (active || starting || stopping) throw new Error('已经在共享、启动或停止中');
      if (!launch || trustedServer !== launch.server || !sourceIds.has(options?.sourceId)) throw new Error('请先加载会话并选择一个屏幕或窗口');
      starting = true;
      const operation = ++epoch;
      const ensure = () => { if (operation !== epoch || !starting) throw new Error('启动已取消'); };
      try {
        const data = await request('info');
        ensure();
        if (data.status === 'active') throw new Error('该会话正在共享，请先停止当前共享');
        if (!data.allowedQualities?.includes(launch.quality)) throw new Error('该画质未对本服务器开放，请返回网页选择');
        if (data.publisherClientId && data.publisherClientId !== launch.clientId) throw new Error('该会话已经在其他客户端共享');
        launch.lowLatency = data.status === 'grace' ? data.lowLatency : !!(launch.lowLatency && data.allowLowLatency);
        if (!data.allowQualityPreference) launch.optimizationMode = 'motion';
        const credentials = await request('token');
        ensure();
        selectedSource = options.sourceId;
        lastPulse = Date.now();
        if (options.audio) {
          const exclude = buildExclusions(options.presets, options.executables);
          await new Promise((resolve, reject) => {
            const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
            helper = child;
            let ready = false, lines = '', pending = Buffer.alloc(0);
            const timeout = setTimeout(() => { reject(new Error('音频过滤启动超时，请重试或关闭共享音频')); killAudio(); }, 15000);
            child.stderr.on('data', data => {
              lines += data.toString('utf8');
              let end;
              while ((end = lines.indexOf('\n')) >= 0) {
                const line = lines.slice(0,end); lines = lines.slice(end+1);
                try {
                  const item = JSON.parse(line);
                  if (item.type === 'ready') { ready = true; clearTimeout(timeout); resolve(); send('audio-status', item); }
                  if (item.type === 'error') {
                    clearTimeout(timeout); reject(new Error(item.message)); send('fatal', item.message); void stop();
                  }
                } catch { /* The helper writes only bounded status lines. */ }
              }
            });
            child.stdout.on('data', data => {
              if (helper !== child) return;
              pending = Buffer.concat([pending, data]);
              while (pending.length >= 3840) { send('pcm', new Uint8Array(pending.subarray(0,3840))); pending = pending.subarray(3840); }
            });
            child.once('error', e => { clearTimeout(timeout); reject(e); });
            child.once('exit', () => {
              clearTimeout(timeout);
              if (!ready) reject(new Error('音频过滤程序无法启动'));
              if (helper === child) { helper = null; send('fatal','音频过滤已中断，共享已停止'); void stop(); }
            });
            child.stdin.on('error', () => {});
            child.stdin.write(JSON.stringify({ exclude, ownerPid: process.pid }) + '\n');
          });
        }
        ensure();
        return { launch, info: data, credentials, sourceId: selectedSource };
      } catch (e) { if (operation === epoch) { starting = false; selectedSource = null; killAudio(); } throw e; }
    });
    handle('published', async () => {
      if (!starting || !selectedSource) throw new Error('启动已取消');
      const operation = epoch, target = launch;
      const response = await request('start', { quality: launch.quality, clientId: launch.clientId, lowLatency: launch.lowLatency });
      if (operation !== epoch) { if (response.ok) await request('stop', {}, target); throw new Error('启动已取消'); }
      if (!response.ok) throw new Error('服务器拒绝开始共享');
      claimed = true; active = true; starting = false; lastPulse = Date.now();
      status('正在共享 · 托盘可随时停止');
      return { ok: true };
    });
    handle('pulse', () => { lastPulse = Date.now(); });
    handle('stop', () => stop());
    handle('hide', () => win.hide());
    handle('open-page', () => launch && shell.openExternal(launch.server + '/share?t=' + encodeURIComponent(launch.token)));
    setInterval(async () => {
      if (!(active || starting) || pollBusy) return;
      if (Date.now() - lastPulse > 15000) { await stop(); status('采集进程失去响应，共享已停止'); return; }
      if (!active) return;
      pollBusy = true;
      const operation = epoch;
      try {
        const info = await request('info');
        if (!active || epoch !== operation) return;
        if (info.status !== 'active') { await stop(false); return; }
        const heartbeat = await request('heartbeat', { clientId: launch.clientId });
        if (epoch !== operation) return;
        if (!heartbeat.ok) { await stop(false); return; }
        send('session-state', info);
      } catch (e) {
        if (epoch !== operation) return;
        // Stop immediately on lost server control; never keep transmitting indefinitely.
        send('fatal', '服务器连接中断：' + e.message); await stop(false);
      } finally { pollBusy = false; }
    }, 2000);
  });
  app.on('before-quit', () => { quitting = true; killAudio(); });
  app.on('window-all-closed', () => {});
}
