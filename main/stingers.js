'use strict';

// Stinger clips. Chromium plays WebM (VP8/VP9) with transparency, but not MOV
// with alpha (ProRes 4444, QuickTime Animation, PNG) nor HTML animations. Both
// are converted once, before the show, into a transparent WebM that plays like
// any other stinger, so a transition costs nothing extra live. Results are
// cached by source, size and date, so reopening a project is instant.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ffmpeg = require('./ffmpeg');
const media = require('./media');
const context = require('./context');
const log = require('./log').scope('stingers');

const HTML_EXT = new Set(['.html', '.htm']);
const PLAYABLE = new Set(['vp8', 'vp9', 'h264', 'av1']);
const MAX_HTML_MS = 15000;

/** Whether `ffmpeg -i` output describes video with an alpha channel. */
function hasAlpha(probeText, pixFmt) {
  return /^(yuva|rgba|argb|bgra|abgr|gbrap|ya\d|pal8)/.test(pixFmt ?? '') || /alpha_mode\s*:\s*1/.test(probeText);
}

/**
 * What to do with a stinger file: 'html' (render it), 'use' (plays as is),
 * 'alpha' (to WebM with alpha) or 'convert' (no alpha, to WebM).
 */
function stingerPlan(file, probeText) {
  if (HTML_EXT.has(path.extname(file).toLowerCase())) return 'html';
  const info = ffmpeg.parseProbe(probeText);
  const alpha = hasAlpha(probeText, info.pixFmt);
  if (info.codec && PLAYABLE.has(info.codec) && (!alpha || info.codec === 'vp8' || info.codec === 'vp9')) return 'use';
  return alpha ? 'alpha' : 'convert';
}

/**
 * VP9 with alpha (yuva420p) when needed; Chromium decodes it in hardware or fast
 * in software. `premultiplied`: the input colours are already multiplied by alpha
 * (Chromium's page captures), so semi-transparent areas must be divided back.
 */
function webmArgs(input, output, { alpha, fps, width, height, premultiplied = false }) {
  const unpremultiply = premultiplied ? 'format=gbrap,unpremultiply=inplace=1,' : '';
  const scale = width && height ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,` : '';
  return [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y', ...input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${unpremultiply}${scale}fps=${fps}`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p',
    '-b:v', '0', '-crf', '30', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
    '-auto-alt-ref', '0',
    '-c:a', 'libopus', '-b:a', '160k',
    output,
  ];
}

function cacheName(source, stat, extra) {
  const base = path.parse(source).name.replace(/[^\w-]+/g, '_').slice(0, 40);
  return `${base}_${Math.round(stat.mtimeMs).toString(36)}_${stat.size.toString(36)}${extra}.webm`;
}

const progress = (source, value) => context.send('stinger:progress', { file: source, progress: Math.min(0.99, value) });

async function convertVideo(source, target, alpha, info, fps) {
  const temp = `${target}.part.webm`;
  await ffmpeg.runFfmpeg(webmArgs(['-i', source], temp, { alpha, fps }), {
    onStderr: (chunk) => {
      const t = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
      if (t && info.duration) progress(source, (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) / info.duration);
    },
  });
  await fs.promises.rename(temp, target);
}

/**
 * Plays an HTML animation in a hidden transparent window and records it for
 * `durationMs` at the show's size and frame rate.
 */
async function renderHtml(source, target, { width, height, fps, durationMs }) {
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const temp = `${target}.part.webm`;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // The page is the user's own animation: it may load its fonts and images, nothing else.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.setFrameRate(fps);
  win.webContents.setAudioMuted(true);

  let latest = null;
  win.webContents.on('paint', (_event, _dirty, image) => {
    latest = image;
  });

  const proc = spawn(ffmpeg.FFMPEG, webmArgs(['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'], temp, { alpha: true, fps, premultiplied: true }), {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let errors = '';
  proc.stderr.on('data', (d) => {
    errors = (errors + d).slice(-2000);
  });
  const exited = new Promise((resolve) => {
    proc.on('error', (err) => {
      errors += err.message;
      resolve(-1);
    });
    proc.on('close', resolve);
  });
  proc.stdin.on('error', () => {
    // FFmpeg failed early; its exit code and stderr report why.
  });

  const blank = Buffer.alloc(width * height * 4);
  const frameBytes = () => {
    if (!latest) return blank;
    const size = latest.getSize();
    const image = size.width === width && size.height === height ? latest : latest.resize({ width, height });
    return image.toBitmap();
  };

  try {
    await win.loadURL(pathToFileURL(source).href);
    // Write at a steady rate, repeating the last painted frame when nothing changed.
    const start = Date.now();
    for (let i = 0; i < frames; i++) {
      const due = start + (i * 1000) / fps;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!proc.stdin.write(frameBytes())) await new Promise((r) => proc.stdin.once('drain', r));
      if (i % fps === 0) progress(source, i / frames);
    }
  } finally {
    proc.stdin.end();
    win.destroy();
  }
  const code = await exited;
  if (code !== 0) throw new Error(errors.trim().split(/\r?\n/).pop() || `FFmpeg terminó con código ${code}`);
  await fs.promises.rename(temp, target);
}

const jobs = new Map();

/**
 * Returns a media descriptor for a stinger the renderer can play, converting
 * it first if needed. `opts`: { width, height, fps, durationMs (HTML only) }.
 */
async function prepareStinger(file, opts = {}) {
  const source = path.resolve(String(file));
  if (!media.allowedMedia.has(source)) throw new Error('Archivo no permitido');
  const width = Math.min(3840, Math.max(160, Math.round(Number(opts.width) || 1920)));
  const height = Math.min(2160, Math.max(90, Math.round(Number(opts.height) || 1080)));
  const fps = Math.min(60, Math.max(15, Math.round(Number(opts.fps) || 30)));
  const durationMs = Math.min(MAX_HTML_MS, Math.max(200, Math.round(Number(opts.durationMs) || 2000)));

  const probeText = HTML_EXT.has(path.extname(source).toLowerCase()) ? '' : await ffmpeg.ffmpegInfo(source);
  const plan = stingerPlan(source, probeText);
  if (plan === 'use') return { ...media.mediaDescriptor(source), source, converted: false };

  const stat = await fs.promises.stat(source);
  const extra = plan === 'html' ? `_${width}x${height}_${fps}_${durationMs}` : '';
  const dir = path.join(app.getPath('userData'), 'Stingers');
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, cacheName(source, stat, extra));
  const done = () => ({ ...media.mediaDescriptor(target), source, converted: true, plan });
  if (fs.existsSync(target)) return { ...done(), reused: true };

  if (jobs.has(target)) return jobs.get(target);
  const job = (async () => {
    const t0 = Date.now();
    if (plan === 'html') await renderHtml(source, target, { width, height, fps, durationMs });
    else await convertVideo(source, target, plan === 'alpha', ffmpeg.parseProbe(probeText), fps);
    log.info(`Stinger ${plan} listo en ${((Date.now() - t0) / 1000).toFixed(1)} s:`, source, '→', target);
    return done();
  })();
  jobs.set(target, job);
  try {
    return await job;
  } catch (err) {
    log.warn('No se pudo preparar el stinger', source, err.message);
    throw err;
  } finally {
    jobs.delete(target);
  }
}

module.exports = { prepareStinger, stingerPlan, hasAlpha, webmArgs };
