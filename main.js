'use strict';

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
const os = require('node:os');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const APP_ORIGIN = 'app://studiomix';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

const MEDIA_FILTERS = {
  video: [{ name: 'Vídeo', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
  image: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
};

function resolveFfmpeg() {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) {
      const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch {
    // Fall back to an ffmpeg on PATH.
  }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();
const { RemoteServer } = require('./remote.js');
let remote = null;
const { GuestServer } = require('./guests.js');
let guests = null;

// Only files the user picked through a dialog can be served to the renderer.
const allowedMedia = new Set();
const outputs = new Map();
let mainWindow = null;
let pendingDisplaySource = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep canvas, video decode and compositing on the GPU, and never throttle the renderer.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// A window covered by another app must keep decoding video and rendering at full rate.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

async function serveFile(file, request) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0;
    let end = stat.size - 1;
    if (match && match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), stat.size - 1);
    } else if (match && match[2]) {
      start = Math.max(0, stat.size - Number(match[2]));
    }
    if (!match || start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
  });
}

function handleAppProtocol(request) {
  const url = new URL(request.url);
  if (url.host !== 'studiomix') return new Response('Forbidden', { status: 403 });

  if (url.pathname === '/media') {
    const requested = path.resolve(url.searchParams.get('p') || '');
    if (!allowedMedia.has(requested)) return new Response('Forbidden', { status: 403 });
    return serveFile(requested, request);
  }

  // MediaPipe (person segmentation) runtime, straight from the installed package.
  if (url.pathname.startsWith('/vendor/mediapipe/')) {
    const base = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision');
    const file = path.join(base, path.normalize(decodeURIComponent(url.pathname.slice('/vendor/mediapipe/'.length))));
    const relative = path.relative(base, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    return serveFile(file, request);
  }
  // Downloaded models (fixed names only).
  if (url.pathname.startsWith('/models/')) {
    const name = path.basename(decodeURIComponent(url.pathname));
    if (!MODELS[name]) return new Response('Not found', { status: 404 });
    return serveFile(path.join(app.getPath('userData'), 'models', name), request);
  }

  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(RENDERER_DIR, path.normalize(rel));
  const relative = path.relative(RENDERER_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return new Response('Forbidden', { status: 403 });
  }
  return serveFile(file, request);
}

function mediaDescriptor(filePath) {
  const abs = path.resolve(filePath);
  allowedMedia.add(abs);
  return {
    path: abs,
    name: path.parse(abs).name,
    url: `${APP_ORIGIN}/media?p=${encodeURIComponent(abs)}`,
  };
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('output:status', status);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function defaultRecordFolder() {
  return path.join(app.getPath('videos'), 'StudioMix');
}

// --- encoders ---------------------------------------------------------------

const HW_ENCODERS = [
  ['nvenc', 'h264_nvenc'],
  ['qsv', 'h264_qsv'],
  ['amf', 'h264_amf'],
];

function tryEncoder(codec) {
  return new Promise((resolve) => {
    const proc = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30', '-frames:v', '5', '-c:v', codec, '-f', 'null', '-'],
      { windowsHide: true, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 8000);
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

let encoderProbe = null;

/** Encoders that actually work on this machine (hardware ones need a matching GPU and driver). */
function probeEncoders() {
  encoderProbe ??= (async () => {
    const found = ['x264'];
    for (const [id, codec] of HW_ENCODERS) {
      if (await tryEncoder(codec)) found.push(id);
    }
    return found;
  })();
  return encoderProbe;
}

async function resolveEncoder(requested) {
  const available = await probeEncoders();
  if (requested && requested !== 'auto') return available.includes(requested) ? requested : 'x264';
  return available.find((e) => e !== 'x264') ?? 'x264';
}

function videoEncoderArgs(encoder, kbps, fps, x264Preset) {
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2), '-keyint_min', String(fps * 2)];
  switch (encoder) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-bf', '0', ...rate];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'nv12', ...rate];
    case 'amf':
      return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr', '-profile:v', 'high', '-pix_fmt', 'nv12', ...rate];
    default:
      return ['-c:v', 'libx264', '-preset', x264Preset || 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-sc_threshold', '0', ...rate];
  }
}

function streamTargets(destinations) {
  const targets = (destinations || [])
    .filter((d) => d && d.enabled)
    .map((d) => {
      const url = String(d.url || '').trim();
      if (!/^rtmps?:\/\//i.test(url)) throw new Error(`El servidor de «${d.name || 'destino'}» debe empezar por rtmp:// o rtmps://`);
      const key = String(d.key || '').trim();
      return key ? `${url.replace(/\/+$/, '')}/${key}` : url;
    });
  if (!targets.length) throw new Error('Activa al menos un destino de emisión en Ajustes.');
  return targets;
}

async function buildFfmpegArgs(opts) {
  const input = ['-hide_banner', '-loglevel', 'warning', '-stats', '-i', 'pipe:0'];
  const fps = Math.round(Number(opts.fps) || 30);

  if (opts.kind === 'stream' || opts.kind === 'vstream') {
    const targets = streamTargets(opts.destinations);
    const vb = Math.max(300, Math.round(Number(opts.videoKbps) || 4500));
    const ab = Math.max(64, Math.round(Number(opts.audioKbps) || 160));
    const encoder = await resolveEncoder(opts.encoder);
    // One encode, sent to every destination; a failing destination doesn't stop the others.
    const output = targets.length === 1
      ? ['-rw_timeout', '10000000', '-f', 'flv', '-flvflags', 'no_duration_filesize', targets[0]]
      : ['-map', '0:v', '-map', '0:a?', '-f', 'tee',
          targets.map((t) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${t.replace(/[\\|[\]]/g, (c) => `\\${c}`)}`).join('|')];
    return {
      file: null,
      encoder,
      args: [
        ...input,
        ...videoEncoderArgs(encoder, vb, fps, opts.x264Preset),
        '-fps_mode', 'cfr', '-r', String(fps),
        '-c:a', 'aac', '-b:a', `${ab}k`, '-ar', '48000', '-ac', '2',
        ...output,
      ],
    };
  }

  if (opts.kind === 'replay') {
    // Rolling buffer: 2 s MPEG-TS segments in a temp folder; the list keeps the
    // newest ones and the file names wrap with some slack so a save in progress
    // never reads a segment that is being overwritten.
    const seconds = Math.min(300, Math.max(5, Number(opts.replaySeconds) || 20));
    const keep = Math.ceil(seconds / 2) + 2;
    const dir = path.join(app.getPath('temp'), `studiomix-replay-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const encoder = await resolveEncoder(opts.encoder);
    const kbps = Math.max(2000, Math.round((Number(opts.recordMbps) || 16) * 1000 * 0.6));
    return {
      file: null,
      encoder,
      replayDir: dir,
      args: [
        ...input,
        ...videoEncoderArgs(encoder, kbps, fps, 'veryfast'),
        '-fps_mode', 'cfr', '-r', String(fps),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts',
        '-segment_wrap', String(keep + 4),
        '-segment_list', path.join(dir, 'list.csv'), '-segment_list_type', 'csv', '-segment_list_size', String(keep),
        path.join(dir, 'seg%03d.ts'),
      ],
    };
  }

  if (opts.kind === 'iso') {
    // Per-camera recording: the camera's own H.264 is copied, no re-encode.
    const folder = opts.folder ? path.resolve(opts.folder) : defaultRecordFolder();
    const dir = path.join(folder, 'ISO');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(opts.label || 'entrada').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    const file = path.join(dir, `${safe}_${timestamp()}.mkv`);
    return { file, args: [...input, '-c', 'copy', file] };
  }

  if (opts.kind === 'record') {
    const folder = opts.folder ? path.resolve(opts.folder) : defaultRecordFolder();
    fs.mkdirSync(folder, { recursive: true });
    const ext = opts.format === 'mkv' ? 'mkv' : 'mp4';
    const suffix = opts.label ? `_${String(opts.label).replace(/[^\w-]+/g, '')}` : '';
    const file = path.join(folder, `StudioMix${suffix}_${timestamp()}.${ext}`);
    if (ext === 'mkv') return { file, args: [...input, '-c', 'copy', file] };
    const video = opts.videoCodec === 'h264'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
    return { file, args: [...input, ...video, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file] };
  }

  throw new Error(`Salida desconocida: ${opts.kind}`);
}

function parseStats(line) {
  const get = (re) => (re.exec(line) || [])[1];
  return {
    fps: get(/fps=\s*([\d.]+)/),
    bitrate: get(/bitrate=\s*([\d.]+\s*\S+)/),
    time: get(/time=\s*(\S+)/),
    speed: get(/speed=\s*([\d.]+x)/),
    size: get(/(?:L?size)=\s*(\S+)/),
    drop: get(/drop=\s*(\d+)/),
  };
}

async function startOutput(opts) {
  const id = String(opts.id);
  if (outputs.has(id)) throw new Error('Esa salida ya está en marcha');
  const { args, file, encoder, replayDir } = await buildFfmpegArgs(opts);
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const out = { id, kind: opts.kind, proc, file, replayDir, stopping: false, log: [], lastStatsAt: 0, lastProgressAt: Date.now(), exited: null };
  outputs.set(id, out);

  // Network outputs can hang instead of failing when the connection drops.
  // If FFmpeg stops reporting progress, kill it so the renderer can reconnect.
  if (opts.kind === 'stream' || opts.kind === 'vstream') {
    const watchdog = setInterval(() => {
      if (out.stopping || !outputs.has(id)) return clearInterval(watchdog);
      if (Date.now() - out.lastProgressAt > 15000) {
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
    // EPIPE when ffmpeg exits first; the close handler reports the reason.
  });

  let pending = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r|\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/frame=|size=/.test(line) && /time=/.test(line)) {
        const now = Date.now();
        out.lastProgressAt = now;
        if (now - out.lastStatsAt > 900) {
          out.lastStatsAt = now;
          sendStatus({ id, state: 'stats', stats: parseStats(line) });
        }
      } else {
        out.log.push(line.trim());
        if (out.log.length > 20) out.log.shift();
      }
    }
  });

  out.exited.then((code) => {
    outputs.delete(id);
    if (out.replayDir) fs.promises.rm(out.replayDir, { recursive: true, force: true }).catch(() => {});
    if (out.stopping || code === 0) {
      sendStatus({ id, state: 'stopped', file: out.file });
    } else {
      const reason = out.log.slice(-4).join('\n') || `FFmpeg terminó con código ${code}`;
      sendStatus({ id, state: 'error', message: reason, file: out.file });
    }
  });

  return { ok: true, file, encoder: encoder ?? null };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || `FFmpeg terminó con código ${code}`))));
  });
}

/** Joins the newest replay segments covering `seconds` into one MP4. */
async function saveReplay(id, seconds, folder) {
  const out = outputs.get(String(id));
  if (!out || out.kind !== 'replay' || out.stopping) throw new Error('El búfer de repetición no está activo.');
  let list;
  try {
    list = await fs.promises.readFile(path.join(out.replayDir, 'list.csv'), 'utf8');
  } catch {
    throw new Error('Aún no hay suficiente vídeo en el búfer. Espera unos segundos.');
  }
  const entries = list
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((parts) => parts.length >= 3)
    .map(([name, start, end]) => ({ file: path.join(out.replayDir, name), duration: Number(end) - Number(start) }));
  const picked = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0 && total < seconds; i--) {
    if (!fs.existsSync(entries[i].file)) continue;
    picked.unshift(entries[i]);
    total += entries[i].duration;
  }
  if (!picked.length) throw new Error('Aún no hay suficiente vídeo en el búfer. Espera unos segundos.');
  const dir = path.join(folder ? path.resolve(folder) : defaultRecordFolder(), 'Repeticiones');
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `Repeticion_${timestamp()}.mp4`);
  const concat = path.join(out.replayDir, `concat-${Date.now()}.txt`);
  await fs.promises.writeFile(concat, picked.map((e) => `file '${e.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  try {
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', target]);
  } finally {
    fs.promises.rm(concat, { force: true }).catch(() => {});
  }
  return { ...mediaDescriptor(target), seconds: total };
}

// --- media optimisation ------------------------------------------------------
// Phone/camera footage (HEVC, 10-bit, 4K60, variable frame rate, long GOPs) can
// stutter or freeze in Chromium. Optimising transcodes it to H.264 ≤1080p with a
// constant frame rate and a keyframe every second, which plays and loops smoothly.

const PLAYS_WELL = new Set(['h264', 'vp8', 'vp9', 'av1']);

async function probeMedia(file) {
  const resolved = path.resolve(String(file));
  if (!allowedMedia.has(resolved)) throw new Error('Archivo no permitido');
  const text = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', resolved], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(err));
  });
  const video = /Stream #\S+.*?Video: (\w+)[^,]*,\s*([\w()]+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*?(?:([\d.]+) fps|([\d.]+) tbr)/.exec(text);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const info = {
    codec: video?.[1] ?? null,
    pixFmt: video?.[2] ?? null,
    width: video ? Number(video[3]) : 0,
    height: video ? Number(video[4]) : 0,
    fps: video ? Number(video[5] ?? video[6]) : 0,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
  };
  const reasons = [];
  if (info.codec && !PLAYS_WELL.has(info.codec)) reasons.push(`códec ${info.codec.toUpperCase()}`);
  if (/10|12/.test(info.pixFmt ?? '')) reasons.push('color de 10 bits');
  if (info.height > 1080 && info.fps > 31) reasons.push(`${info.height}p a ${Math.round(info.fps)} fps`);
  if (info.height > 2160) reasons.push(`resolución ${info.width}×${info.height}`);
  if (info.fps > 61) reasons.push(`${Math.round(info.fps)} fps`);
  return { ...info, reasons };
}

const optimizing = new Map();

async function optimizeMedia(file, sender) {
  const source = path.resolve(String(file));
  if (!allowedMedia.has(source)) throw new Error('Archivo no permitido');
  if (optimizing.has(source)) return optimizing.get(source);
  const job = (async () => {
    const info = await probeMedia(source);
    const dir = path.join(app.getPath('userData'), 'Optimizados');
    await fs.promises.mkdir(dir, { recursive: true });
    const stat = await fs.promises.stat(source);
    const base = `${path.parse(source).name}_${Math.round(stat.mtimeMs).toString(36)}_${stat.size.toString(36)}`;
    const target = path.join(dir, `${base}.mp4`);
    if (fs.existsSync(target)) return { ...mediaDescriptor(target), reused: true };
    const fps = Math.min(60, Math.max(24, Math.round(info.fps || 30)));
    const encoder = await resolveEncoder('auto');
    const video = encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-profile:v', 'high']
      : encoder === 'qsv'
        ? ['-c:v', 'h264_qsv', '-global_quality', '22', '-profile:v', 'high']
        : encoder === 'amf'
          ? ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-profile:v', 'high']
          : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
    const temp = `${target}.part.mp4`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=-2:'min(1080,ih)':flags=lanczos,format=yuv420p",
      '-fps_mode', 'cfr', '-r', String(fps), '-g', String(fps), '-keyint_min', String(fps),
      ...video,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', temp,
    ];
    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let tail = '';
      let lastSent = 0;
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        tail = (tail + chunk).slice(-1500);
        const t = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
        if (t && info.duration && Date.now() - lastSent > 400) {
          lastSent = Date.now();
          const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
          if (!sender.isDestroyed()) sender.send('media:optimize-progress', { file: source, progress: Math.min(0.99, secs / info.duration) });
        }
      });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split(/\r?\n/).pop() || `FFmpeg terminó con código ${code}`))));
    });
    await fs.promises.rename(temp, target);
    return mediaDescriptor(target);
  })();
  optimizing.set(source, job);
  try {
    return await job;
  } finally {
    optimizing.delete(source);
  }
}

// --- network inputs (SRT / RTSP / RTMP / UDP / HLS) ----------------------------------
// FFmpeg receives the stream and re-emits low-latency fragmented MP4 on stdout;
// the renderer plays it through Media Source Extensions like any other input.

const netInputs = new Map();

function netInputArgs(url, encoder) {
  const video = encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-b:v', '8M']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '8M'];
  const pre = /^rtsp:/i.test(url) ? ['-rtsp_transport', 'tcp'] : [];
  return [
    '-hide_banner', '-loglevel', 'info', '-nostats',
    '-fflags', 'nobuffer', '-flags', 'low_delay', ...pre, '-i', url,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(1080,ih)',format=yuv420p",
    ...video, '-profile:v', 'high', '-level', '4.1', '-g', '30', '-bf', '0',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000', 'pipe:1',
  ];
}

async function startNetInput(id, url, sender) {
  stopNetInput(id);
  if (!/^(srt|rtsp|rtmps?|udp|rtp|https?):\/\//i.test(url)) throw new Error('Usa una dirección srt://, rtsp://, rtmp://, udp:// o http(s)://');
  const encoder = await resolveEncoder('auto');
  const entry = { id, url, proc: null, stopped: false, timer: 0 };
  netInputs.set(id, entry);
  const send = (channel, ...args) => {
    if (!sender.isDestroyed()) sender.send(channel, ...args);
  };
  const launch = () => {
    if (entry.stopped) return;
    const proc = spawn(FFMPEG, netInputArgs(url, encoder), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    entry.proc = proc;
    let header = '';
    let announced = false;
    send('netinput:status', { id, state: 'waiting' });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      if (announced) return;
      header += chunk;
      // FFmpeg prints the input streams before writing any output.
      if (/Output #0/.test(header)) {
        announced = true;
        const inputPart = header.split('Output #0')[0];
        send('netinput:status', { id, state: 'ready', hasAudio: /Stream #0:\d+.*Audio:/.test(inputPart) });
      }
    });
    proc.stdout.on('data', (chunk) => send('netinput:data', id, chunk));
    proc.on('error', () => {});
    proc.on('close', () => {
      if (entry.stopped || netInputs.get(id) !== entry) return;
      // Source gone (camera off, network blip): keep trying.
      send('netinput:status', { id, state: 'lost' });
      entry.timer = setTimeout(launch, 2000);
    });
  };
  launch();
  return { ok: true };
}

function stopNetInput(id) {
  const entry = netInputs.get(id);
  if (!entry) return;
  entry.stopped = true;
  clearTimeout(entry.timer);
  entry.proc?.kill('SIGKILL');
  netInputs.delete(id);
}

// --- ML models --------------------------------------------------------------------
// Downloaded once, on first use, from Google's official MediaPipe model storage.

const MODELS = {
  'selfie_segmenter.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
};

async function ensureModel(name) {
  const source = MODELS[name];
  if (!source) throw new Error('Modelo desconocido');
  const dir = path.join(app.getPath('userData'), 'models');
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return { url: `${APP_ORIGIN}/models/${name}`, downloaded: false };
  await fs.promises.mkdir(dir, { recursive: true });
  const { net } = require('electron');
  const res = await net.fetch(source);
  if (!res.ok) throw new Error(`No se pudo descargar el modelo (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 50_000) throw new Error('El modelo descargado no es válido');
  await fs.promises.writeFile(`${file}.part`, data);
  await fs.promises.rename(`${file}.part`, file);
  return { url: `${APP_ORIGIN}/models/${name}`, downloaded: true, bytes: data.length };
}

// --- autosave / crash recovery ----------------------------------------------------
// A lock file exists while the app runs; finding it at start-up means the last
// session didn't close cleanly, so its autosave can be offered for recovery.

const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.studiomix');
const lockFile = () => path.join(app.getPath('userData'), 'session.lock');
let previousSessionCrashed = false;

function startSessionLock() {
  try {
    previousSessionCrashed = fs.existsSync(lockFile()) && fs.existsSync(autosaveFile());
    fs.writeFileSync(lockFile(), String(process.pid));
  } catch {
    previousSessionCrashed = false;
  }
}

function endSessionLock() {
  try {
    fs.rmSync(lockFile(), { force: true });
  } catch {
    // Nothing to clean.
  }
}

async function readProjectFile(file) {
  const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  // Media referenced by a project the user opened may be served, like dialog picks.
  const media = {};
  for (const input of Array.isArray(data.inputs) ? data.inputs : []) {
    for (const p of [input.path, input.fx?.maskPath]) {
      if (typeof p === 'string' && p && fs.existsSync(p)) media[p] = mediaDescriptor(p);
    }
  }
  const stinger = data.transition?.stinger?.path;
  if (typeof stinger === 'string' && fs.existsSync(stinger)) media[stinger] = mediaDescriptor(stinger);
  return { file, data, media };
}

// --- upload speed test ----------------------------------------------------------

/** Uploads random data to Cloudflare's speed-test endpoint and returns Mbit/s. */
async function uploadTest() {
  const { net } = require('electron');
  const crypto = require('node:crypto');
  const results = [];
  for (const size of [2e6, 6e6]) {
    const body = crypto.randomBytes(size);
    const t0 = performance.now();
    const res = await net.fetch('https://speed.cloudflare.com/__up', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(`El servidor de prueba respondió ${res.status}`);
    await res.arrayBuffer();
    const secs = (performance.now() - t0) / 1000;
    results.push((size * 8) / secs / 1e6);
  }
  // The larger sample is the more reliable one.
  return { mbps: results[results.length - 1] };
}

// --- system metrics ------------------------------------------------------------

let lastCpuTimes = os.cpus().map((c) => c.times);

function systemCpuPercent() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const prev = lastCpuTimes[i] ?? t;
    const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
    idle += t.idle - prev.idle;
    total += sum(t) - sum(prev);
  });
  lastCpuTimes = now;
  return total > 0 ? (1 - idle / total) * 100 : 0;
}

function appMetrics() {
  const metrics = app.getAppMetrics();
  const cores = os.cpus().length || 1;
  return {
    appCpu: metrics.reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0) / cores,
    memoryMb: metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024,
    systemCpu: systemCpuPercent(),
  };
}

async function stopOutput(id) {
  const out = outputs.get(String(id));
  if (!out) return { ok: true };
  out.stopping = true;
  out.proc.stdin.end();
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000));
  if ((await Promise.race([out.exited, timeout])) === 'timeout') out.proc.kill('SIGKILL');
  return { ok: true, file: out.file };
}

function registerIpc() {
  ipcMain.handle('dialog:open-media', async (_event, kind) => {
    const filters = MEDIA_FILTERS[kind];
    if (!filters) return [];
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters });
    return result.canceled ? [] : result.filePaths.map(mediaDescriptor);
  });

  ipcMain.handle('dialog:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open-folder', async (_event, folder) => {
    const target = folder ? path.resolve(folder) : defaultRecordFolder();
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });

  ipcMain.handle('app:info', () => ({
    defaultRecordFolder: defaultRecordFolder(),
    ffmpeg: FFMPEG === 'ffmpeg' ? 'ffmpeg (PATH)' : 'ffmpeg integrado',
    version: app.getVersion(),
    updates: !!autoUpdater,
  }));

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

  ipcMain.handle('output:start', async (_event, opts) => {
    try {
      return await startOutput(opts || {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:encoders', () => probeEncoders());

  ipcMain.handle('media:probe', (_event, file) => probeMedia(file));
  ipcMain.handle('media:optimize', (event, file) => optimizeMedia(file, event.sender));

  ipcMain.handle('replay:save',(_event, id, seconds, folder) => saveReplay(id, Number(seconds) || 20, folder));

  ipcMain.handle('dialog:open-text', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Lista (CSV o texto)', extensions: ['csv', 'txt', 'tsv'] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if ((await fs.promises.stat(file)).size > 2 * 1024 * 1024) throw new Error('El archivo es demasiado grande');
    return fs.promises.readFile(file, 'utf8');
  });

  ipcMain.handle('dialog:open-lut', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
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

  ipcMain.handle('app:metrics', () => appMetrics());

  ipcMain.handle('snapshot:save', async (_event, bytes, folder) => {
    const dir = path.join(folder ? path.resolve(folder) : defaultRecordFolder(), 'Capturas');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `StudioMix_${timestamp()}.png`);
    await fs.promises.writeFile(file, Buffer.from(bytes));
    return file;
  });

  ipcMain.handle('project:save', async (_event, json, currentPath) => {
    let file = currentPath;
    if (!file) {
      const result = await dialog.showSaveDialog(mainWindow, {
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
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Proyecto StudioMix', extensions: ['studiomix'] }],
    });
    if (result.canceled) return null;
    return readProjectFile(result.filePaths[0]);
  });

  ipcMain.handle('autosave:write', async (_event, json) => {
    const target = autosaveFile();
    // Write-then-rename so a crash mid-write never leaves a broken autosave.
    await fs.promises.writeFile(`${target}.tmp`, String(json), 'utf8');
    await fs.promises.rename(`${target}.tmp`, target);
  });

  ipcMain.handle('autosave:check', async () => {
    if (!previousSessionCrashed) return null;
    try {
      const stat = await fs.promises.stat(autosaveFile());
      return { savedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  });

  ipcMain.handle('autosave:load', async () => {
    previousSessionCrashed = false;
    const result = await readProjectFile(autosaveFile());
    return { ...result, file: null };
  });

  ipcMain.handle('autosave:discard', () => {
    previousSessionCrashed = false;
  });

  ipcMain.handle('net:upload-test', () => uploadTest());

  // Restart into a downloaded update, but never while anything is being sent or recorded.
  ipcMain.handle('app:install-update', () => {
    if (!autoUpdater) return { ok: false, error: 'No hay ninguna actualización descargada' };
    if (outputs.size > 0) return { ok: false, error: 'Detén la emisión y las grabaciones antes de actualizar' };
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  ipcMain.handle('model:ensure', (_event, name) => ensureModel(String(name)));

  ipcMain.handle('netinput:start',(event, id, url) => startNetInput(String(id), String(url), event.sender));
  ipcMain.handle('netinput:stop', (_event, id) => stopNetInput(String(id)));
  ipcMain.handle('net:lan-addresses', () => require('./remote.js').lanAddresses());

  ipcMain.handle('guests:info', () => guests.info());
  ipcMain.handle('guests:enable', (_event, enabled, opts) => guests.setEnabled(!!enabled, opts || {}));
  ipcMain.on('guest:signal', (_event, guestId, data) => guests.signal(String(guestId), data));
  ipcMain.handle('guest:kick', (_event, guestId) => guests.kick(String(guestId)));

  ipcMain.handle('remote:info', () => remote.info());
  ipcMain.handle('remote:configure', (_event, opts) => remote.configure(opts || {}));
  ipcMain.on('api:state', (_event, state) => remote?.setState(state));
  ipcMain.on('api:thumbs', (_event, thumbs) => remote?.setThumbs(thumbs));

  ipcMain.on('output:chunk', (_event, id, data) => {
    const out = outputs.get(String(id));
    if (!out || out.stopping || !out.proc.stdin.writable) return;
    out.proc.stdin.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });

  ipcMain.handle('output:stop', (_event, id) => stopOutput(id));
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
  // Network inputs belong to the page that created them: if it reloads or
  // crashes, stop their FFmpeg receivers so the ports are freed.
  const stopPageInputs = () => {
    for (const id of [...netInputs.keys()]) stopNetInput(id);
  };
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) stopPageInputs();
  });
  mainWindow.webContents.on('render-process-gone', stopPageInputs);
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- updates ---------------------------------------------------------------------
// Installed builds check GitHub Releases (the feed electron-builder bakes in from
// package.json "publish"), or a "generic" feed (a folder on any web server with
// latest.yml + the installer) from STUDIOMIX_UPDATE_URL or userData/update.json
// { "url": "https://…/" }. Updates download in the background and install on
// quit, never mid-show.

let autoUpdater = null;

function updateFeed() {
  if (process.env.STUDIOMIX_UPDATE_URL) return process.env.STUDIOMIX_UPDATE_URL;
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update.json'), 'utf8')).url || null;
  } catch {
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
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update-ready', { version: info.version });
  });
  autoUpdater.on('error', (err) => console.warn('Actualizaciones:', err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600 * 1000);
}

app.whenReady().then(() => {
  protocol.handle('app', handleAppProtocol);

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find((s) => s.id === pendingDisplaySource);
      pendingDisplaySource = null;
      if (!chosen) return callback({});
      const loopback = process.platform === 'win32' && chosen.id.startsWith('screen:');
      callback(loopback ? { video: chosen, audio: 'loopback' } : { video: chosen });
    } catch {
      callback({});
    }
  });

  startSessionLock();
  remote = new RemoteServer({
    configFile: path.join(app.getPath('userData'), 'remote.json'),
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
  });
  guests = new GuestServer({
    dir: app.getPath('userData'),
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
  });
  registerIpc();
  createWindow();
  probeEncoders();
  if (remote.config.enabled) remote.start();
  setupUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Let running recordings finalize their files before quitting.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || outputs.size === 0) return;
  event.preventDefault();
  quitting = true;
  Promise.all([...outputs.keys()].map(stopOutput)).finally(() => app.quit());
});

app.on('will-quit', () => {
  for (const id of [...netInputs.keys()]) stopNetInput(id);
});

// A clean exit removes the lock, so the autosave isn't offered as a recovery.
app.on('will-quit', endSessionLock);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
