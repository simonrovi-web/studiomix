'use strict';

// Output windows: Program, Preview or Multiview full screen on a monitor or
// projector (or in a floating window). The renderer opens them with
// window.open('output.html?…') so they share its video directly; here we
// only decide where they go and keep them tied to their display.

const { screen, shell } = require('electron');
const context = require('./context');
const log = require('./log').scope('screens');

const SOURCES = new Set(['program', 'preview', 'multiview']);
const WINDOWED = 'window';
const children = new Set(); // { win, displayId }

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  const appDisplay = context.window && !context.window.isDestroyed() ? screen.getDisplayMatching(context.window.getBounds()).id : primary;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || `Pantalla ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primary,
    hasApp: d.id === appDisplay,
  }));
}

/** What an output page asks for: `output.html?source=program&display=123`. */
function parseOutputUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'app:' || parsed.host !== 'studiomix' || parsed.pathname !== '/output.html') return null;
  const source = parsed.searchParams.get('source');
  if (!SOURCES.has(source)) return null;
  return { source, display: parsed.searchParams.get('display') || WINDOWED };
}

const findDisplay = (id) => screen.getAllDisplays().find((d) => String(d.id) === id) ?? null;

const TITLES = { program: 'Program', preview: 'Preview', multiview: 'Multiview' };

/** Handler for the main window's window.open: only output pages, links go to the browser. */
function handleWindowOpen({ url }) {
  const request = parseOutputUrl(url);
  if (!request) {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  }
  const display = request.display === WINDOWED ? null : findDisplay(request.display);
  const base = {
    title: `StudioMix · ${TITLES[request.source]}`,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
  };
  const options = display
    ? { ...base, ...display.bounds, frame: false, fullscreenable: true, skipTaskbar: false }
    : { ...base, width: 960, height: 540, minWidth: 320, minHeight: 180 };
  return { action: 'allow', overrideBrowserWindowOptions: options, outlivesOpener: false };
}

/** Called for each window the renderer opened: fullscreen it on its display. */
function adopt(win, { url }) {
  const request = parseOutputUrl(url);
  if (!request) return;
  const display = request.display === WINDOWED ? null : findDisplay(request.display);
  const entry = { win, displayId: display ? String(display.id) : null };
  children.add(entry);
  win.setMenu(null);
  win.once('ready-to-show', () => {
    if (display) {
      win.setBounds(display.bounds);
      win.setFullScreen(true);
    }
    win.show();
  });
  win.on('closed', () => children.delete(entry));
  log.info(`Salida ${request.source} en ${display ? `pantalla ${display.id} (${display.size.width}×${display.size.height})` : 'ventana'}`);
}

function closeAll() {
  for (const { win } of [...children]) if (!win.isDestroyed()) win.close();
}

function watchDisplays() {
  const changed = () => context.send('screens:changed', listDisplays());
  screen.on('display-added', changed);
  screen.on('display-removed', (_event, display) => {
    // A projector that goes away must not drop its output onto the operator's screen.
    for (const entry of [...children]) {
      if (entry.displayId === String(display.id) && !entry.win.isDestroyed()) {
        log.info(`Pantalla ${display.id} desconectada; se cierra su salida`);
        entry.win.close();
      }
    }
    changed();
  });
  screen.on('display-metrics-changed', changed);
}

module.exports = { listDisplays, parseOutputUrl, handleWindowOpen, adopt, closeAll, watchDisplays, WINDOWED };
