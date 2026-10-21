'use strict';

// Entry point: app lifecycle, the window and the IPC surface. The work lives
// in main/ (ffmpeg, outputs, media, netinputs, session, system, updates).

const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const context = require('./main/context');
const logger = require('./main/log');
const ffmpeg = require('./main/ffmpeg');
const media = require('./main/media');
const outputs = require('./main/outputs');
const netinputs = require('./main/netinputs');
const projects = require('./main/session');
const system = require('./main/system');
const updates = require('./main/updates');
const screens = require('./main/screens');
const stingers = require('./main/stingers');
const gpu = require('./main/gpu');
const { RemoteServer, lanAddresses } = require('./main/remote');
const { GuestServer } = require('./main/guests');

const log = logger.scope('main');
const rendererLog = logger.scope('renderer');

let remote = null;
let guests = null;
let pendingDisplaySource = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep canvas, video decode and compositing on the GPU, and never throttle the renderer.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// A window covered by another app must keep decoding video and rendering at full rate.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Phones on the LAN can't always resolve WebRTC's .local names, so share real IPs.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization,WebRtcHideLocalIpsWithMdns');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function registerIpc() {
  const win = () => context.window;

  // --- dialogs and files ---
  ipcMain.handle('dialog:open-media', async (_event, kind) => {
    const filters = media.MEDIA_FILTERS[kind];
    if (!filters) return [];
    const result = await dialog.showOpenDialog(win(), { properties: ['openFile', 'multiSelections'], filters });
    return result.canceled ? [] : result.filePaths.map(media.mediaDescriptor);
  });

  ipcMain.handle('dialog:choose-folder', async () => {
    const result = await dialog.showOpenDialog(win(), { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open-folder', async (_event, folder) => {
    const target = folder ? path.resolve(folder) : media.defaultRecordFolder();
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });

  ipcMain.handle('dialog:open-text', async () => {
    const result = await dialog.showOpenDialog(win(), {
      properties: ['openFile'],
      filters: [{ name: 'Lista (CSV o texto)', extensions: ['csv', 'txt', 'tsv'] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if ((await fs.promises.stat(file)).size > 2 * 1024 * 1024) throw new Error('El archivo es demasiado grande');
    return fs.promises.readFile(file, 'utf8');
  });

  ipcMain.handle('dialog:open-lut', async () => {
    const result = await dialog.showOpenDialog(win(), {
      properties: ['openFile'],
      filters: [{ name: 'LUT (.cube)', extensions: ['cube'] }],
    });
    return result.canceled ? null : path.resolve(result.filePaths[0]);
  });

  // Only .cube text files, so this can't be used to read arbitrary files.
  ipcMain.handle('file:read-lut', async (_event, file) => {
    const resolved = path.resolve(String(file));
    if (path.extname(resolved).toLowerCase() !== '.cube') throw new Error('Solo se admiten archivos .cube');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 32 * 1024 * 1024) throw new Error('El archivo .cube es demasiado grande');
    return fs.promises.readFile(resolved, 'utf8');
  });

  ipcMain.handle('snapshot:save', async (_event, bytes, folder) => {
    const dir = path.join(folder ? path.resolve(folder) : media.defaultRecordFolder(), 'Capturas');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `StudioMix_${ffmpeg.timestamp()}.png`);
    await fs.promises.writeFile(file, Buffer.from(bytes));
    return file;
  });

  // --- app ---
  ipcMain.handle('app:info', () => ({
    defaultRecordFolder: media.defaultRecordFolder(),
    ffmpeg: ffmpeg.FFMPEG === 'ffmpeg' ? 'ffmpeg (PATH)' : 'ffmpeg integrado',
    version: app.getVersion(),
    updates: updates.updatesEnabled(),
    logFile: logger.file(),
  }));
  ipcMain.handle('app:encoders', () => ffmpeg.probeEncoders());
  ipcMain.handle('app:metrics', () => system.appMetrics());
  // Restart into a downloaded update, but never while anything is being sent or recorded.
  ipcMain.handle('app:install-update', () => updates.installUpdate(outputs.outputs.size > 0));
  ipcMain.on('log:renderer', (_event, level, message) => {
    const text = String(message).slice(0, 4000);
    if (level === 'error') rendererLog.error(text);
    else rendererLog.warn(text);
  });

  // --- screen capture ---
  ipcMain.handle('display:list-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith('screen:'),
    }));
  });
  ipcMain.handle('display:select-source', (_event, id) => {
    pendingDisplaySource = typeof id === 'string' ? id : null;
  });

  // --- outputs ---
  ipcMain.handle('output:start', async (_event, opts) => {
    try {
      return await outputs.startOutput(opts || {});
    } catch (err) {
      log.warn('No se pudo iniciar la salida:', err.message);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('output:chunk', (_event, id, data) => outputs.writeChunk(id, data));
  ipcMain.handle('output:stop', (_event, id) => outputs.stopOutput(id));
  ipcMain.handle('replay:save', (_event, id, seconds, folder) => outputs.saveReplay(id, Number(seconds) || 20, folder));

  // --- media ---
  ipcMain.handle('media:probe', (_event, file) => media.probeMedia(file));
  ipcMain.handle('media:optimize', (_event, file) => media.optimizeMedia(file));
  ipcMain.handle('stinger:prepare', (_event, file, opts) => stingers.prepareStinger(file, opts || {}));
  ipcMain.handle('model:ensure', (_event, name) => media.ensureModel(String(name)));

  // --- projects ---
  ipcMain.handle('project:save', async (_event, json, currentPath) => {
    let file = currentPath;
    if (!file) {
      const result = await dialog.showSaveDialog(win(), {
        defaultPath: path.join(app.getPath('documents'), 'proyecto.studiomix'),
        filters: [{ name: 'Proyecto StudioMix', extensions: ['studiomix'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
    }
    await fs.promises.writeFile(file, String(json), 'utf8');
    return file;
  });
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(win(), {
      properties: ['openFile'],
      filters: [{ name: 'Proyecto StudioMix', extensions: ['studiomix'] }],
    });
    if (result.canceled) return null;
    return projects.readProjectFile(result.filePaths[0]);
  });
  ipcMain.handle('autosave:write', (_event, json) => projects.writeAutosave(json));
  ipcMain.handle('autosave:check', () => projects.checkRecovery());
  ipcMain.handle('autosave:load', () => projects.loadRecovery());
  ipcMain.handle('autosave:discard', () => projects.discardRecovery());

  // --- network ---
  ipcMain.handle('net:upload-test', () => system.uploadTest());
  ipcMain.handle('net:lan-addresses', () => lanAddresses());
  ipcMain.handle('netinput:start', (_event, id, url) => netinputs.startNetInput(String(id), String(url)));
  ipcMain.handle('netinput:stop', (_event, id) => netinputs.stopNetInput(String(id)));

  // --- guests and remote control ---
  ipcMain.handle('guests:info', () => guests.info());
  ipcMain.handle('guests:enable', (_event, enabled, opts) => guests.setEnabled(!!enabled, opts || {}));
  ipcMain.on('guest:signal', (_event, guestId, data) => guests.signal(String(guestId), data));
  ipcMain.handle('guest:kick', (_event, guestId) => guests.kick(String(guestId)));

  ipcMain.handle('remote:info', () => remote.info());
  ipcMain.handle('remote:configure', (_event, opts) => remote.configure(opts || {}));
  ipcMain.on('api:state', (_event, state) => remote?.setState(state));
  ipcMain.on('api:thumbs', (_event, thumbs) => remote?.setThumbs(thumbs));
  ipcMain.on('monitor:signal', (_event, clientId, data) => remote?.monitorSignal(String(clientId), data));

  // --- output screens ---
  ipcMain.handle('screens:list', () => screens.listDisplays());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    title: 'StudioMix',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the program output rendering while the window is in the background.
      backgroundThrottling: false,
    },
  });
  context.window = win;
  win.webContents.setWindowOpenHandler(screens.handleWindowOpen);
  win.webContents.on('did-create-window', screens.adopt);
  // Output windows belong to the main window; they must not keep the app open.
  win.on('close', screens.closeAll);
  // Network inputs belong to the page that created them: if it reloads or
  // crashes, stop their FFmpeg receivers so the ports are freed.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      netinputs.stopAllNetInputs();
      // Their video comes from this page; the new page reopens the remembered ones.
      screens.closeAll();
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('El proceso de la interfaz se cerró:', details.reason, `(código ${details.exitCode})`);
    netinputs.stopAllNetInputs();
  });
  win.loadURL(`${media.APP_ORIGIN}/index.html`);
  win.on('closed', () => {
    if (context.window === win) context.window = null;
  });
}

process.on('uncaughtException', (err) => log.error('Excepción no controlada:', err));
process.on('unhandledRejection', (reason) => log.error('Promesa rechazada sin controlar:', reason));

app.whenReady().then(() => {
  logger.init(path.join(app.getPath('userData'), 'logs'));
  log.info(`StudioMix ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform})`);
  protocol.handle('app', media.handleAppProtocol);

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find((s) => s.id === pendingDisplaySource);
      pendingDisplaySource = null;
      if (!chosen) return callback({});
      const loopback = process.platform === 'win32' && chosen.id.startsWith('screen:');
      callback(loopback ? { video: chosen, audio: 'loopback' } : { video: chosen });
    } catch (err) {
      log.warn('No se pudo capturar la pantalla:', err.message);
      callback({});
    }
  });

  projects.startSessionLock();
  remote = new RemoteServer({
    configFile: path.join(app.getPath('userData'), 'remote.json'),
    send: (channel, payload) => context.send(channel, payload),
  });
  guests = new GuestServer({
    dir: app.getPath('userData'),
    send: (channel, payload) => context.send(channel, payload),
  });
  registerIpc();
  createWindow();
  screens.watchDisplays();
  ffmpeg.probeEncoders().then((found) => log.info('Codificadores:', found.join(', ')));
  if (remote.config.enabled) remote.start();
  updates.setupUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Let running recordings finalize their files before quitting.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || outputs.outputs.size === 0) return;
  event.preventDefault();
  quitting = true;
  outputs.stopAll().finally(() => app.quit());
});

app.on('will-quit', () => {
  netinputs.stopAllNetInputs();
  gpu.monitor.stop();
  // A clean exit removes the lock, so the autosave isn't offered as a recovery.
  projects.endSessionLock();
  log.info('Cierre normal');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
