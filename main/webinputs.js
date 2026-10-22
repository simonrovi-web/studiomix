'use strict';

// Web page inputs: an HTML graphic (like OBS's browser source) rendered in a
// hidden offscreen window with a transparent background. Each paint sends only
// the rectangle that changed to the renderer as raw BGRA, so a still lower
// third costs nothing and a ticking clock sends a few hundred pixels. The
// renderer acknowledges every frame; paints that arrive meanwhile are merged.
//
// All web inputs (and the windows opened to click on them) share one
// persistent session, so pages that keep their state in localStorage — a
// score, a kill counter, a control panel — see each other's changes.

const { BrowserWindow, session } = require('electron');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const context = require('./context');
const log = require('./log').scope('webinput');

const PARTITION = 'persist:webinputs';
const HTML_EXT = new Set(['.html', '.htm']);
const ACK_TIMEOUT_MS = 1000;

const pages = new Map();
let sessionReady = false;

/**
 * Turns what the user typed (http(s) address, file:// URL or a Windows path to
 * an .html file, optionally with ?query) into a URL, or throws a message.
 */
function normalizeWebUrl(source) {
  const text = String(source ?? '').trim();
  if (!text) throw new Error('Escribe una dirección o elige un archivo .html');
  let href = text;
  if (/^[a-z]:[\\/]/i.test(text) || text.startsWith('\\\\')) {
    // A path may carry a query string (gc.html?nombre=Ana): keep it out of the path encoding.
    const [, file, rest] = /^([^?#]*)(.*)$/.exec(text);
    href = pathToFileURL(path.resolve(file)).href + rest;
  }
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new Error('La dirección no es válida');
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('Usa una dirección http(s):// o un archivo .html');
  if (url.protocol === 'file:' && !HTML_EXT.has(path.extname(fileURLToPath(url)).toLowerCase())) {
    throw new Error('El archivo tiene que ser una página .html');
  }
  return url.href;
}

/** Whether a page may navigate from `from` to `to`: same site, or the same folder for local files. */
function sameSite(from, to) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.protocol !== b.protocol) return false;
    if (a.protocol === 'file:') {
      const rel = path.relative(path.dirname(fileURLToPath(a)), fileURLToPath(b));
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    }
    return a.host === b.host;
  } catch {
    return false;
  }
}

function unionRect(a, b) {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** `rect` limited to a `size` frame, or null when nothing of it is inside. */
function clampRect(rect, size) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(size.width, Math.ceil(rect.x + rect.width)) - x;
  const height = Math.min(size.height, Math.ceil(rect.y + rect.height)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function webSession() {
  const ses = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    // Graphics need no camera, microphone, notifications or the like.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }
  return ses;
}

/** Keeps a page on its own site: no pop-ups, no navigating elsewhere. */
function confine(webContents, home) {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!sameSite(home, url)) event.preventDefault();
  });
  webContents.on('will-redirect', (event, url) => {
    if (!sameSite(home, url)) event.preventDefault();
  });
}

function pageWindow({ width, height, offscreen, title }) {
  return new BrowserWindow({
    show: !offscreen,
    width,
    height,
    useContentSize: true,
    title,
    frame: !offscreen,
    transparent: offscreen,
    backgroundColor: offscreen ? '#00000000' : '#2a2f33',
    autoHideMenuBar: true,
    webPreferences: {
      offscreen: offscreen ? { deviceScaleFactor: 1 } : false,
      session: webSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
}

function flush(page) {
  if (page.waiting || !page.dirty || !page.image || page.win.isDestroyed()) return;
  const size = page.image.getSize();
  const rect = clampRect(page.dirty, size);
  page.dirty = null;
  if (!rect) return;
  const whole = rect.x === 0 && rect.y === 0 && rect.width === size.width && rect.height === size.height;
  const bitmap = (whole ? page.image : page.image.crop(rect)).toBitmap();
  page.waiting = true;
  // If the renderer never answers (reloaded, busy), don't stall the page forever.
  page.ackTimer = setTimeout(() => ackFrame(page.id), ACK_TIMEOUT_MS);
  context.send('webinput:frame', page.id, { ...rect, fullWidth: size.width, fullHeight: size.height }, bitmap);
}

function ackFrame(id) {
  const page = pages.get(id);
  if (!page) return;
  clearTimeout(page.ackTimer);
  page.waiting = false;
  flush(page);
}

/**
 * Page render rate: its own while shown, a trickle while nobody watches (the
 * renderer decides). Raising it repaints at once so the picture is current.
 */
function setFrameRate(id, fps) {
  const page = pages.get(id);
  if (!page || page.win.isDestroyed()) return;
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || 1)));
  page.win.webContents.setFrameRate(rate);
  page.win.webContents.invalidate();
}

async function startWebInput(id, source, opts = {}) {
  stopWebInput(id);
  const url = normalizeWebUrl(source);
  const width = Math.min(3840, Math.max(160, Math.round(Number(opts.width) || 1920)));
  const height = Math.min(2160, Math.max(90, Math.round(Number(opts.height) || 1080)));
  const fps = Math.min(60, Math.max(1, Math.round(Number(opts.fps) || 30)));
  const win = pageWindow({ width, height, offscreen: true });
  // Windows limits a new window to the screen's work area (1080 minus the
  // taskbar); an offscreen page must keep the size it was asked for.
  win.setContentSize(width, height);
  const page = { id, url, width, height, win, image: null, dirty: null, waiting: false, ackTimer: 0, panels: new Set() };
  pages.set(id, page);
  log.info(`Página ${id}: ${url} (${width}×${height}, ${fps} fps)`);

  const wc = win.webContents;
  confine(wc, url);
  wc.setAudioMuted(true);
  wc.setFrameRate(fps);
  wc.on('paint', (_event, dirty, image) => {
    page.image = image;
    page.dirty = unionRect(page.dirty, dirty);
    flush(page);
  });
  wc.on('did-start-loading', () => context.send('webinput:status', { id, state: 'loading' }));
  wc.on('did-finish-load', () => context.send('webinput:status', { id, state: 'ready' }));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
    log.warn(`Página ${id}: no se pudo cargar (${description})`);
    context.send('webinput:status', { id, state: 'error', error: `No se pudo cargar la página (${description})` });
  });
  wc.on('render-process-gone', (_event, details) => {
    if (pages.get(id) !== page) return;
    log.warn(`Página ${id}: el proceso se cerró (${details.reason}), recargando`);
    setTimeout(() => !win.isDestroyed() && wc.reload(), 2000);
  });
  wc.loadURL(url).catch(() => {
    // Reported by did-fail-load.
  });
  return { ok: true, url };
}

function reloadWebInput(id) {
  const page = pages.get(id);
  if (!page || page.win.isDestroyed()) return;
  page.image = null;
  page.dirty = null;
  page.win.webContents.reloadIgnoringCache();
}

/**
 * Opens a visible window to click on the page (`kind: 'page'`, the same URL
 * scaled to fit) or on its control panel (`kind: 'panel'`, another URL).
 * Both share the graphics' session, so changes reach the on-air page.
 */
function openWebWindow(id, kind, panelSource) {
  const page = pages.get(id);
  if (!page) throw new Error('La página no está cargada');
  const url = kind === 'panel' ? normalizeWebUrl(panelSource) : page.url;
  const zoom = kind === 'panel' ? 1 : Math.min(1, 1280 / page.width);
  const width = kind === 'panel' ? 440 : Math.round(page.width * zoom);
  const height = kind === 'panel' ? 860 : Math.round(page.height * zoom);
  const win = pageWindow({ width, height, offscreen: false, title: kind === 'panel' ? 'Panel de control' : 'Interactuar con la página' });
  confine(win.webContents, url);
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoom));
  win.loadURL(url).catch((err) => log.warn(`Ventana ${id}:`, err.message));
  page.panels.add(win);
  win.on('closed', () => page.panels.delete(win));
  return { ok: true };
}

function stopWebInput(id) {
  const page = pages.get(id);
  if (!page) return;
  pages.delete(id);
  clearTimeout(page.ackTimer);
  for (const panel of page.panels) if (!panel.isDestroyed()) panel.destroy();
  if (!page.win.isDestroyed()) page.win.destroy();
}

function stopAllWebInputs() {
  for (const id of [...pages.keys()]) stopWebInput(id);
}

module.exports = {
  startWebInput,
  stopWebInput,
  stopAllWebInputs,
  reloadWebInput,
  openWebWindow,
  ackFrame,
  setFrameRate,
  normalizeWebUrl,
  sameSite,
  unionRect,
  clampRect,
};
