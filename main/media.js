'use strict';

// The app:// protocol (renderer files, user media, MediaPipe runtime, models),
// the allow-list of media the renderer may load, and media probing/optimising.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const ffmpeg = require('./ffmpeg');
const context = require('./context');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');
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
  stinger: [
    { name: 'Stinger (vídeo con alfa o animación HTML)', extensions: ['webm', 'mov', 'mp4', 'm4v', 'mkv', 'avi', 'html', 'htm'] },
  ],
};

// Only files the user picked (dialog, opened project, our own output) can be served.
const allowedMedia = new Set();

function mediaDescriptor(filePath) {
  const abs = path.resolve(filePath);
  allowedMedia.add(abs);
  return {
    path: abs,
    name: path.parse(abs).name,
    url: `${APP_ORIGIN}/media?p=${encodeURIComponent(abs)}`,
  };
}

function assertAllowed(file) {
  const resolved = path.resolve(String(file));
  if (!allowedMedia.has(resolved)) throw new Error('Archivo no permitido');
  return resolved;
}

function defaultRecordFolder() {
  return path.join(app.getPath('videos'), 'StudioMix');
}

/** `bytes=a-b` header → { start, end } (inclusive), or null if unsatisfiable. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = 0;
  let end = size - 1;
  if (match[1]) {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), size - 1);
  } else {
    start = Math.max(0, size - Number(match[2]));
  }
  return start > end || start >= size ? null : { start, end };
}

/** Resolves `rel` inside `base`, or null if it would escape it. */
function inside(base, rel) {
  const file = path.join(base, path.normalize(rel));
  const relative = path.relative(base, file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : file;
}

async function serveFile(file, request) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const header = request.headers.get('range');
  if (header) {
    const range = parseRange(header, stat.size);
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const { start, end } = range;
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
  const forbidden = () => new Response('Forbidden', { status: 403 });
  if (url.host !== 'studiomix') return forbidden();

  if (url.pathname === '/media') {
    const requested = path.resolve(url.searchParams.get('p') || '');
    return allowedMedia.has(requested) ? serveFile(requested, request) : forbidden();
  }
  // MediaPipe (person segmentation) runtime, straight from the installed package.
  if (url.pathname.startsWith('/vendor/mediapipe/')) {
    const base = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
    const file = inside(base, decodeURIComponent(url.pathname.slice('/vendor/mediapipe/'.length)));
    return file ? serveFile(file, request) : forbidden();
  }
  // Downloaded models (fixed names only).
  if (url.pathname.startsWith('/models/')) {
    const name = path.basename(decodeURIComponent(url.pathname));
    if (!MODELS[name]) return new Response('Not found', { status: 404 });
    return serveFile(path.join(app.getPath('userData'), 'models', name), request);
  }
  const file = inside(RENDERER_DIR, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  return file ? serveFile(file, request) : forbidden();
}

// --- media optimisation ------------------------------------------------------
// Phone/camera footage (HEVC, 10-bit, 4K60, variable frame rate, long GOPs) can
// stutter or freeze in Chromium. Optimising transcodes it to H.264 ≤1080p with a
// constant frame rate and a keyframe every second, which plays and loops smoothly.

async function probeMedia(file) {
  return ffmpeg.parseProbe(await ffmpeg.ffmpegInfo(assertAllowed(file)));
}

function optimizeVideoArgs(encoder) {
  switch (encoder) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-profile:v', 'high'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '22', '-profile:v', 'high'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-profile:v', 'high'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
  }
}

const optimizing = new Map();

async function optimizeMedia(file) {
  const source = assertAllowed(file);
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
    const encoder = await ffmpeg.resolveEncoder('auto');
    const temp = `${target}.part.mp4`;
    let lastSent = 0;
    await ffmpeg.runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-stats', '-y', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=-2:'min(1080,ih)':flags=lanczos,format=yuv420p",
      '-fps_mode', 'cfr', '-r', String(fps), '-g', String(fps), '-keyint_min', String(fps),
      ...optimizeVideoArgs(encoder),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', temp,
    ], {
      onStderr: (chunk) => {
        const t = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
        if (!t || !info.duration || Date.now() - lastSent < 400) return;
        lastSent = Date.now();
        const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        context.send('media:optimize-progress', { file: source, progress: Math.min(0.99, secs / info.duration) });
      },
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

module.exports = {
  APP_ORIGIN,
  MEDIA_FILTERS,
  allowedMedia,
  mediaDescriptor,
  defaultRecordFolder,
  parseRange,
  inside,
  handleAppProtocol,
  probeMedia,
  optimizeMedia,
  ensureModel,
};
