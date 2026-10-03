const { contextBridge, ipcRenderer } = require('electron');
const on = (name, callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on(name, listener); return () => ipcRenderer.removeListener(name, listener); };
contextBridge.exposeInMainWorld('desktop', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  sources: () => ipcRenderer.invoke('sources'), audioApps: () => ipcRenderer.invoke('audio-apps'),
  info: () => ipcRenderer.invoke('info'), begin: options => ipcRenderer.invoke('begin', options),
  published: () => ipcRenderer.invoke('published'), pulse: () => ipcRenderer.invoke('pulse'),
  stop: () => ipcRenderer.invoke('stop'), hide: () => ipcRenderer.invoke('hide'), openPage: () => ipcRenderer.invoke('open-page'),
  onLaunch: callback => on('launch',callback), onStatus: callback => on('status',callback),
  onPCM: callback => on('pcm',callback), onAudioStatus: callback => on('audio-status',callback),
  onStop: callback => on('stop',callback), onFatal: callback => on('fatal',callback), onSession: callback => on('session-state',callback),
});
