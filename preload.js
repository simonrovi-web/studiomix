'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openMedia: (kind) => ipcRenderer.invoke('dialog:open-media', kind),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  openFolder: (folder) => ipcRenderer.invoke('shell:open-folder', folder),
  info: () => ipcRenderer.invoke('app:info'),
  log: (level, message) => ipcRenderer.send('log:renderer', level, message),
  listDisplaySources: () => ipcRenderer.invoke('display:list-sources'),
  selectDisplaySource: (id) => ipcRenderer.invoke('display:select-source', id),
  startOutput: (opts) => ipcRenderer.invoke('output:start', opts),
  writeOutput: (id, bytes) => ipcRenderer.send('output:chunk', id, bytes),
  stopOutput: (id) => ipcRenderer.invoke('output:stop', id),
  encoders: () => ipcRenderer.invoke('app:encoders'),
  openLut: () => ipcRenderer.invoke('dialog:open-lut'),
  openText: () => ipcRenderer.invoke('dialog:open-text'),
  saveReplay: (id, seconds, folder) => ipcRenderer.invoke('replay:save', id, seconds, folder),
  autosave: (json) => ipcRenderer.invoke('autosave:write', json),
  checkRecovery: () => ipcRenderer.invoke('autosave:check'),
  loadRecovery: () => ipcRenderer.invoke('autosave:load'),
  discardRecovery: () => ipcRenderer.invoke('autosave:discard'),
  uploadTest: () => ipcRenderer.invoke('net:upload-test'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  updateStatus: () => ipcRenderer.invoke('app:update-status'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('app:update-status', (_event, status) => callback(status)),
  ensureModel: (name) => ipcRenderer.invoke('model:ensure', name),
  startNetInput:(id, url) => ipcRenderer.invoke('netinput:start', id, url),
  stopNetInput: (id) => ipcRenderer.invoke('netinput:stop', id),
  lanAddresses: () => ipcRenderer.invoke('net:lan-addresses'),
  startWebInput: (id, url, opts) => ipcRenderer.invoke('webinput:start', id, url, opts),
  stopWebInput: (id) => ipcRenderer.invoke('webinput:stop', id),
  reloadWebInput: (id) => ipcRenderer.invoke('webinput:reload', id),
  openWebWindow: (id, kind, url) => ipcRenderer.invoke('webinput:open', id, kind, url),
  ackWebInput: (id) => ipcRenderer.send('webinput:ack', id),
  setWebInputFps: (id, fps) => ipcRenderer.send('webinput:fps', id, fps),
  onWebInput: (onFrame, onStatus) => {
    ipcRenderer.on('webinput:frame', (_event, id, rect, pixels) => onFrame(id, rect, pixels));
    ipcRenderer.on('webinput:status', (_event, s) => onStatus(s));
  },
  onNetInput: (onData, onStatus) => {
    const data = (_event, id, chunk) => onData(id, chunk);
    const status = (_event, s) => onStatus(s);
    ipcRenderer.on('netinput:data', data);
    ipcRenderer.on('netinput:status', status);
  },
  guestsInfo: () => ipcRenderer.invoke('guests:info'),
  guestsEnable: (enabled, opts) => ipcRenderer.invoke('guests:enable', enabled, opts),
  guestSignal: (guestId, data) => ipcRenderer.send('guest:signal', guestId, data),
  guestKick: (guestId) => ipcRenderer.invoke('guest:kick', guestId),
  onGuests: (handlers) => {
    ipcRenderer.on('guest:join', (_event, p) => handlers.join(p));
    ipcRenderer.on('guest:leave', (_event, p) => handlers.leave(p));
    ipcRenderer.on('guest:signal', (_event, p) => handlers.signal(p));
  },
  listDisplays: () => ipcRenderer.invoke('screens:list'),
  onDisplaysChanged: (callback) => ipcRenderer.on('screens:changed', (_event, list) => callback(list)),
  monitorSignal: (clientId, data) => ipcRenderer.send('monitor:signal', clientId, data),
  onMonitorSignal: (callback) => ipcRenderer.on('monitor:signal', (_event, msg) => callback(msg)),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  remoteConfigure: (opts) => ipcRenderer.invoke('remote:configure', opts),
  publishState: (state) => ipcRenderer.send('api:state', state),
  publishThumbs: (thumbs) => ipcRenderer.send('api:thumbs', thumbs),
  onApiCommand: (callback) => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on('api:command', handler);
    return () => ipcRenderer.removeListener('api:command', handler);
  },
  onApiClients: (callback) => {
    const handler = (_event, count) => callback(count);
    ipcRenderer.on('api:clients', handler);
    return () => ipcRenderer.removeListener('api:clients', handler);
  },
  prepareStinger: (file, opts) => ipcRenderer.invoke('stinger:prepare', file, opts),
  onStingerProgress: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('stinger:progress', handler);
    return () => ipcRenderer.removeListener('stinger:progress', handler);
  },
  probeMedia: (file) => ipcRenderer.invoke('media:probe', file),
  optimizeMedia: (file) => ipcRenderer.invoke('media:optimize', file),
  onOptimizeProgress: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('media:optimize-progress', handler);
    return () => ipcRenderer.removeListener('media:optimize-progress', handler);
  },
  readLut: (file) => ipcRenderer.invoke('file:read-lut', file),
  metrics: () => ipcRenderer.invoke('app:metrics'),
  saveSnapshot: (bytes, folder) => ipcRenderer.invoke('snapshot:save', bytes, folder),
  saveProject: (json, currentPath) => ipcRenderer.invoke('project:save', json, currentPath),
  openProject: () => ipcRenderer.invoke('project:open'),
  onOutputStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('output:status', handler);
    return () => ipcRenderer.removeListener('output:status', handler);
  },
});
