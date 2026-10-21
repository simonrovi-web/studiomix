'use strict';

// Updates. Installed builds use electron-updater with the GitHub Releases feed
// electron-builder bakes in (resources/app-update.yml), or a "generic" feed (a
// folder with latest.yml + the installer) from STUDIOMIX_UPDATE_URL or
// userData/update.json { "url": "https://…/" }. They download in the background
// and install on quit or when the user restarts, never mid-show.
// The portable build and development runs can't replace themselves: for them
// "Buscar actualizaciones" asks GitHub for the latest release and offers its page.

const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const context = require('./context');
const log = require('./log').scope('updates');

const CHECK_EVERY_MS = 6 * 3600 * 1000;
// Where releases are published when no app-update.yml says otherwise.
const DEFAULT_REPO = { owner: 'simonrovi-web', repo: 'studiomix' };

let autoUpdater = null;
let mode = 'manual'; // 'auto' (installed, updates itself) | 'manual' (portable/dev: link only)
let status = { state: 'idle', current: null };

/** Compares dotted versions ("0.3.10" > "0.3.9"); a leading "v" is ignored. */
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

/** Release notes as plain text (GitHub sends HTML); never rendered as markup. */
function plainNotes(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => n.note ?? '').join('\n') : String(notes ?? '');
  return text
    .replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function readRepo() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*(\S+)/m.exec(yml)?.[1];
    const repo = /^repo:\s*(\S+)/m.exec(yml)?.[1];
    if (owner && repo) return { owner, repo };
  } catch {
    // Development run or portable without the file: the default repository.
  }
  return DEFAULT_REPO;
}

const releasesPage = () => {
  const { owner, repo } = readRepo();
  return `https://github.com/${owner}/${repo}/releases/latest`;
};

function setStatus(patch) {
  status = { ...status, ...patch, current: app.getVersion(), mode, releaseUrl: patch.releaseUrl ?? releasesPage() };
  context.send('app:update-status', status);
}

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
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const feed = updateFeed();
  const builtIn = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  if (!app.isPackaged || portable || (!feed && !builtIn)) {
    mode = 'manual';
    setStatus({ state: 'idle', why: !app.isPackaged ? 'dev' : portable ? 'portable' : 'nofeed' });
    return;
  }
  mode = 'auto';
  ({ autoUpdater } = require('electron-updater'));
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    log.info('Hay una versión nueva:', info.version);
    setStatus({ state: 'downloading', version: info.version, progress: 0, notes: plainNotes(info.releaseNotes) });
  });
  autoUpdater.on('update-not-available', () => setStatus({ state: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', progress: p.percent / 100, bytesPerSecond: p.bytesPerSecond }));
  autoUpdater.on('update-downloaded', (info) => {
    log.info('Actualización descargada:', info.version);
    setStatus({ state: 'downloaded', version: info.version, progress: 1, notes: plainNotes(info.releaseNotes) || status.notes, checkedAt: Date.now() });
  });
  autoUpdater.on('error', (err) => {
    log.warn(err.message);
    setStatus({ state: 'error', error: friendlyError(err) });
  });
  setStatus({ state: 'idle' });
  const check = () => autoUpdater.checkForUpdates().catch(() => {
    // Reported by the 'error' event above.
  });
  check();
  setInterval(check, CHECK_EVERY_MS);
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_INTERNET|net::ERR_NAME/i.test(msg)) return 'Sin conexión a internet. Inténtalo más tarde.';
  if (/404|No published versions/i.test(msg)) return 'Todavía no hay versiones publicadas.';
  return msg.split('\n')[0].slice(0, 200);
}

/** Portable/dev: ask GitHub for the latest release and compare. */
async function checkManually() {
  setStatus({ state: 'checking', error: null });
  try {
    const { owner, repo } = readRepo();
    const res = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'No published versions' : `GitHub respondió ${res.status}`);
    const release = await res.json();
    const version = String(release.tag_name ?? '').replace(/^v/i, '');
    const newer = compareVersions(version, app.getVersion()) > 0;
    setStatus(newer
      ? { state: 'available', version, notes: plainNotes(release.body), releaseUrl: release.html_url, checkedAt: Date.now() }
      : { state: 'latest', version, checkedAt: Date.now() });
  } catch (err) {
    log.warn('No se pudo comprobar la versión:', err.message);
    setStatus({ state: 'error', error: friendlyError(err) });
  }
  return status;
}

/** "Buscar actualizaciones" in the menu. */
async function checkNow() {
  if (mode === 'manual') return checkManually();
  // Already downloading or ready: nothing to ask again.
  if (['downloading', 'downloaded', 'checking'].includes(status.state)) return status;
  setStatus({ state: 'checking', error: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', error: friendlyError(err) });
  }
  return status;
}

const getStatus = () => ({ ...status, current: app.getVersion(), mode, releaseUrl: status.releaseUrl ?? releasesPage() });
const updatesEnabled = () => mode === 'auto';

/** Restarts into a downloaded update, unless `busy` says something is on air. */
function installUpdate(busy) {
  if (mode !== 'auto' || status.state !== 'downloaded') return { ok: false, error: 'No hay ninguna actualización descargada' };
  if (busy) return { ok: false, error: 'Detén la emisión y las grabaciones antes de actualizar' };
  log.info('Reiniciando para instalar', status.version);
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
}

module.exports = { setupUpdates, updatesEnabled, installUpdate, checkNow, getStatus, compareVersions, plainNotes };
