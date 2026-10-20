'use strict';

// Running FFmpeg outputs (stream, vertical stream, recordings, ISO, replay
// buffer). The renderer encodes with MediaRecorder and pipes the chunks in.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpeg = require('./ffmpeg');
const media = require('./media');
const context = require('./context');
const log = require('./log').scope('outputs');

const outputs = new Map();
const NETWORK_KINDS = new Set(['stream', 'vstream']);
const STALL_MS = 15000;

const sendStatus = (status) => context.send('output:status', status);

/** Creates the folders an output writes to and returns its FFmpeg arguments. */
async function prepare(opts) {
  const recordFolder = opts.folder ? path.resolve(opts.folder) : media.defaultRecordFolder();
  const needsEncoder = NETWORK_KINDS.has(opts.kind) || opts.kind === 'replay';
  const encoder = needsEncoder ? await ffmpeg.resolveEncoder(opts.encoder) : null;
  let replayDir = null;
  if (opts.kind === 'replay') {
    replayDir = path.join(app.getPath('temp'), `studiomix-replay-${process.pid}-${Date.now()}`);
    fs.mkdirSync(replayDir, { recursive: true });
  }
  const { args, file } = ffmpeg.outputArgs(opts, { encoder, recordFolder, replayDir });
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  return { args, file, encoder, replayDir };
}

async function startOutput(opts) {
  const id = String(opts.id);
  if (outputs.has(id)) throw new Error('Esa salida ya está en marcha');
  const { args, file, encoder, replayDir } = await prepare(opts);
  const proc = spawn(ffmpeg.FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const out = { id, kind: opts.kind, proc, file, replayDir, stopping: false, log: [], lastStatsAt: 0, lastProgressAt: Date.now(), exited: null };
  outputs.set(id, out);
  log.info(`Inicio ${opts.kind} ${id}`, encoder ? `(${encoder})` : '', file ?? '');

  // Network outputs can hang instead of failing when the connection drops.
  // If FFmpeg stops reporting progress, kill it so the renderer can reconnect.
  if (NETWORK_KINDS.has(opts.kind)) {
    const watchdog = setInterval(() => {
      if (out.stopping || !outputs.has(id)) return clearInterval(watchdog);
      if (Date.now() - out.lastProgressAt > STALL_MS) {
        out.log.push('Sin progreso durante 15 s: conexión perdida');
        clearInterval(watchdog);
        proc.kill('SIGKILL');
      }
    }, 2000);
  }

  out.exited = new Promise((resolve) => {
    proc.on('error', (err) => {
      out.log.push(err.code === 'ENOENT' ? 'No se encontró FFmpeg' : err.message);
      resolve(-1);
    });
    proc.on('close', (code) => resolve(code ?? -1));
  });

  proc.stdin.on('error', () => {
    // EPIPE when FFmpeg exits first; the close handler reports the reason.
  });

  let pending = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r|\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (ffmpeg.isProgressLine(line)) {
        const now = Date.now();
        out.lastProgressAt = now;
        if (now - out.lastStatsAt > 900) {
          out.lastStatsAt = now;
          sendStatus({ id, state: 'stats', stats: ffmpeg.parseStats(line) });
        }
      } else {
        out.log.push(line.trim());
        if (out.log.length > 20) out.log.shift();
      }
    }
  });

  out.exited.then((code) => {
    outputs.delete(id);
    if (out.replayDir) {
      fs.promises.rm(out.replayDir, { recursive: true, force: true })
        .catch((err) => log.warn('No se pudo borrar el búfer de repetición', out.replayDir, err.message));
    }
    if (out.stopping || code === 0) {
      log.info(`Fin ${out.kind} ${id}`);
      sendStatus({ id, state: 'stopped', file: out.file });
    } else {
      const reason = out.log.slice(-4).join('\n') || `FFmpeg terminó con código ${code}`;
      log.warn(`Error en ${out.kind} ${id} (código ${code}):`, reason);
      sendStatus({ id, state: 'error', message: reason, file: out.file });
    }
  });

  return { ok: true, file, encoder };
}

function writeChunk(id, data) {
  const out = outputs.get(String(id));
  if (!out || out.stopping || !out.proc.stdin.writable) return;
  out.proc.stdin.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
}

async function stopOutput(id) {
  const out = outputs.get(String(id));
  if (!out) return { ok: true };
  out.stopping = true;
  out.proc.stdin.end();
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000));
  if ((await Promise.race([out.exited, timeout])) === 'timeout') {
    log.warn(`${out.kind} ${id} no terminó en 15 s; se fuerza el cierre`);
    out.proc.kill('SIGKILL');
  }
  return { ok: true, file: out.file };
}

const stopAll = () => Promise.all([...outputs.keys()].map(stopOutput));

/**
 * Newest segments from FFmpeg's CSV segment list (name,start,end) that add up
 * to at least `seconds`, oldest first. Segments that no longer exist are skipped.
 */
function pickReplaySegments(csv, dir, seconds, exists = fs.existsSync) {
  const entries = String(csv)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((parts) => parts.length >= 3)
    .map(([name, start, end]) => ({ file: path.join(dir, name), duration: Number(end) - Number(start) }));
  const picked = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0 && total < seconds; i--) {
    if (!exists(entries[i].file)) continue;
    picked.unshift(entries[i]);
    total += entries[i].duration;
  }
  return { picked, total };
}

/** A line of an FFmpeg concat list; quotes inside the path are escaped. */
const concatLine = (file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

/** Joins the newest replay segments covering `seconds` into one MP4. */
async function saveReplay(id, seconds, folder) {
  const out = outputs.get(String(id));
  if (!out || out.kind !== 'replay' || out.stopping) throw new Error('El búfer de repetición no está activo.');
  const notYet = 'Aún no hay suficiente vídeo en el búfer. Espera unos segundos.';
  let list;
  try {
    list = await fs.promises.readFile(path.join(out.replayDir, 'list.csv'), 'utf8');
  } catch {
    throw new Error(notYet);
  }
  const { picked, total } = pickReplaySegments(list, out.replayDir, seconds);
  if (!picked.length) throw new Error(notYet);
  const dir = path.join(folder ? path.resolve(folder) : media.defaultRecordFolder(), 'Repeticiones');
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `Repeticion_${ffmpeg.timestamp()}.mp4`);
  const concat = path.join(out.replayDir, `concat-${Date.now()}.txt`);
  await fs.promises.writeFile(concat, picked.map((e) => concatLine(e.file)).join('\n'), 'utf8');
  try {
    await ffmpeg.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', target]);
  } finally {
    // The whole folder goes when the buffer stops, so a leftover list is harmless.
    fs.promises.rm(concat, { force: true }).catch((err) => log.warn('No se pudo borrar', concat, err.message));
  }
  log.info(`Repetición guardada (${total.toFixed(1)} s):`, target);
  return { ...media.mediaDescriptor(target), seconds: total };
}

module.exports = {
  outputs,
  startOutput,
  writeChunk,
  stopOutput,
  stopAll,
  saveReplay,
  pickReplaySegments,
  concatLine,
};
