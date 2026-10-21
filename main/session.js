'use strict';

// Projects, autosave and crash recovery. A lock file exists while the app
// runs; finding it at start-up means the last session didn't close cleanly.
// Its autosave is then moved aside to recovery.studiomix, so the new session's
// autosaves can't overwrite it while the user decides whether to recover it.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const media = require('./media');
const log = require('./log').scope('session');

const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.studiomix');
const recoveryFile = () => path.join(app.getPath('userData'), 'recovery.studiomix');
const lockFile = () => path.join(app.getPath('userData'), 'session.lock');
let previousSessionCrashed = false;

function startSessionLock() {
  try {
    if (fs.existsSync(lockFile()) && fs.existsSync(autosaveFile())) {
      // rename keeps the file's date, which the recovery prompt shows.
      fs.renameSync(autosaveFile(), recoveryFile());
      previousSessionCrashed = true;
      log.warn('La sesión anterior no se cerró bien; se ofrecerá recuperarla');
    } else {
      // A recovery left over from an earlier start was already offered.
      previousSessionCrashed = false;
    }
    fs.writeFileSync(lockFile(), String(process.pid));
  } catch (err) {
    previousSessionCrashed = false;
    log.warn('No se pudo crear el bloqueo de sesión:', err.message);
  }
}

function endSessionLock() {
  try {
    fs.rmSync(lockFile(), { force: true });
  } catch (err) {
    log.warn('No se pudo borrar el bloqueo de sesión:', err.message);
  }
}

/** Paths of media a project refers to (inputs, masks, title logos, stinger). */
function projectMediaPaths(data) {
  const paths = [];
  for (const input of Array.isArray(data?.inputs) ? data.inputs : []) {
    for (const p of [input?.path, input?.fx?.maskPath, input?.fields?.logoPath]) {
      if (typeof p === 'string' && p) paths.push(p);
    }
  }
  const stinger = data?.transition?.stinger?.path;
  if (typeof stinger === 'string' && stinger) paths.push(stinger);
  return paths;
}

async function readProjectFile(file) {
  const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  // Media referenced by a project the user opened may be served, like dialog picks.
  const files = {};
  for (const p of projectMediaPaths(data)) {
    if (fs.existsSync(p)) files[p] = media.mediaDescriptor(p);
    else log.info('Falta un archivo del proyecto:', p);
  }
  return { file, data, media: files };
}

async function writeAutosave(json) {
  const target = autosaveFile();
  // Write-then-rename so a crash mid-write never leaves a broken autosave.
  await fs.promises.writeFile(`${target}.tmp`, String(json), 'utf8');
  await fs.promises.rename(`${target}.tmp`, target);
}

async function checkRecovery() {
  if (!previousSessionCrashed) return null;
  try {
    const stat = await fs.promises.stat(recoveryFile());
    return { savedAt: stat.mtimeMs };
  } catch {
    return null; // The autosave vanished since start-up: nothing to recover.
  }
}

async function loadRecovery() {
  previousSessionCrashed = false;
  const result = await readProjectFile(recoveryFile());
  return { ...result, file: null };
}

function discardRecovery() {
  previousSessionCrashed = false;
  fs.promises.rm(recoveryFile(), { force: true }).catch((err) => log.warn('No se pudo borrar la recuperación:', err.message));
}

module.exports = {
  startSessionLock,
  endSessionLock,
  projectMediaPaths,
  readProjectFile,
  writeAutosave,
  checkRecovery,
  loadRecovery,
  discardRecovery,
};
