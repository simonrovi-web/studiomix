'use strict';

// Installed builds check GitHub Releases (the feed electron-builder bakes in from
// package.json "publish"), or a "generic" feed (a folder on any web server with
// latest.yml + the installer) from STUDIOMIX_UPDATE_URL or userData/update.json
// { "url": "https://…/" }. Updates download in the background and install on
// quit, never mid-show.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const context = require('./context');
const log = require('./log').scope('updates');

let autoUpdater = null;

function updateFeed() {
  if (process.env.STUDIOMIX_UPDATE_URL) return process.env.STUDIOMIX_UPDATE_URL;
  const file = path.join(app.getPath('userData'), 'update.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).url || null;
  } catch (err) {
    log.warn('update.json no es válido:', err.message);
    return null;
  }
}

function setupUpdates() {
  if (!app.isPackaged) return;
  // The portable build can't update itself in place.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;
  const feed = updateFeed();
  // Without a custom feed, use the GitHub Releases feed baked in at build time (if any).
  const builtIn = fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  if (!feed && !builtIn) return;
  ({ autoUpdater } = require('electron-updater'));
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    log.info('Actualización descargada:', info.version);
    context.send('app:update-ready', { version: info.version });
  });
  autoUpdater.on('error', (err) => log.warn(err.message));
  // Failures (offline, no release yet) are reported by the 'error' event above.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600 * 1000);
}

const updatesEnabled = () => !!autoUpdater;

/** Restarts into a downloaded update, unless `busy` says something is on air. */
function installUpdate(busy) {
  if (!autoUpdater) return { ok: false, error: 'No hay ninguna actualización descargada' };
  if (busy) return { ok: false, error: 'Detén la emisión y las grabaciones antes de actualizar' };
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
}

module.exports = { setupUpdates, updatesEnabled, installUpdate };
