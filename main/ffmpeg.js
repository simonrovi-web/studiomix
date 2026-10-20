'use strict';

// FFmpeg: where the binary is, which encoders work on this machine, and the
// command lines for every output. Argument builders and parsers are pure
// functions (no Electron), so they are covered by tests.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function resolveFfmpeg() {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) {
      const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch {
    // ffmpeg-static missing: fall back to an ffmpeg on PATH.
  }
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

/** "2026-10-19_09-42-33" — local time, safe for file names. */
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
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

/** Encoders that actually work here (hardware ones need a matching GPU and driver). */
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

/** The requested encoder if available, else the first GPU one, else x264. */
function pickEncoder(requested, available) {
  if (requested && requested !== 'auto') return available.includes(requested) ? requested : 'x264';
  return available.find((e) => e !== 'x264') ?? 'x264';
}

async function resolveEncoder(requested) {
  return pickEncoder(requested, await probeEncoders());
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

/** RTMP(S) URLs for the enabled destinations, with the stream key appended. */
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

/** Escapes a URL for FFmpeg's tee muxer, whose separators are | [ ] and \. */
function teeEscape(url) {
  return url.replace(/[\\|[\]]/g, (c) => `\\${c}`);
}

/**
 * FFmpeg arguments for an output.
 * @param {object} opts output request from the renderer (kind, fps, destinations…)
 * @param {{ encoder: string, recordFolder: string, replayDir?: string, now?: Date }} env
 *   resolved encoder and folders (kept out so this stays pure).
 * @returns {{ args: string[], file: string | null }}
 */
function outputArgs(opts, env) {
  const input = ['-hide_banner', '-loglevel', 'warning', '-stats', '-i', 'pipe:0'];
  const fps = Math.round(Number(opts.fps) || 30);
  const stamp = timestamp(env.now);

  if (opts.kind === 'stream' || opts.kind === 'vstream') {
    const targets = streamTargets(opts.destinations);
    const vb = Math.max(300, Math.round(Number(opts.videoKbps) || 4500));
    const ab = Math.max(64, Math.round(Number(opts.audioKbps) || 160));
    // One encode, sent to every destination; a failing destination doesn't stop the others.
    const output = targets.length === 1
      ? ['-rw_timeout', '10000000', '-f', 'flv', '-flvflags', 'no_duration_filesize', targets[0]]
      : ['-map', '0:v', '-map', '0:a?', '-f', 'tee', targets.map((t) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${teeEscape(t)}`).join('|')];
    return {
      file: null,
      args: [
        ...input,
        ...videoEncoderArgs(env.encoder, vb, fps, opts.x264Preset),
        '-fps_mode', 'cfr', '-r', String(fps),
        '-c:a', 'aac', '-b:a', `${ab}k`, '-ar', '48000', '-ac', '2',
        ...output,
      ],
    };
  }

  if (opts.kind === 'replay') {
    // Rolling buffer: 2 s MPEG-TS segments; the list keeps the newest ones and
    // file names wrap with slack so a save in progress never reads a segment
    // that is being overwritten.
    const seconds = Math.min(300, Math.max(5, Number(opts.replaySeconds) || 20));
    const keep = Math.ceil(seconds / 2) + 2;
    const kbps = Math.max(2000, Math.round((Number(opts.recordMbps) || 16) * 1000 * 0.6));
    return {
      file: null,
      args: [
        ...input,
        ...videoEncoderArgs(env.encoder, kbps, fps, 'veryfast'),
        '-fps_mode', 'cfr', '-r', String(fps),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts',
        '-segment_wrap', String(keep + 4),
        '-segment_list', path.join(env.replayDir, 'list.csv'), '-segment_list_type', 'csv', '-segment_list_size', String(keep),
        path.join(env.replayDir, 'seg%03d.ts'),
      ],
    };
  }

  if (opts.kind === 'iso') {
    // Per-camera recording: the camera's own H.264 is copied, no re-encode.
    const safe = String(opts.label || 'entrada').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    const file = path.join(env.recordFolder, 'ISO', `${safe}_${stamp}.mkv`);
    return { file, args: [...input, '-c', 'copy', file] };
  }

  if (opts.kind === 'record') {
    const ext = opts.format === 'mkv' ? 'mkv' : 'mp4';
    const suffix = opts.label ? `_${String(opts.label).replace(/[^\w-]+/g, '')}` : '';
    const file = path.join(env.recordFolder, `StudioMix${suffix}_${stamp}.${ext}`);
    if (ext === 'mkv') return { file, args: [...input, '-c', 'copy', file] };
    const video = opts.videoCodec === 'h264'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
    return { file, args: [...input, ...video, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file] };
  }

  throw new Error(`Salida desconocida: ${opts.kind}`);
}

/** Fields of an FFmpeg "-stats" progress line. */
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

const isProgressLine = (line) => /frame=|size=/.test(line) && /time=/.test(line);

/** Network input (SRT/RTSP/RTMP/UDP/HLS) → low-latency fragmented MP4 on stdout. */
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

const PLAYS_WELL = new Set(['h264', 'vp8', 'vp9', 'av1']);

/** Codec, size, frame rate and duration from `ffmpeg -i` output, plus why it may stutter. */
function parseProbe(text) {
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

/** Runs FFmpeg to completion; rejects with its last error line. */
function runFfmpeg(args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let tail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      tail = (tail + chunk).slice(-2000);
      onStderr?.(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(tail.trim().split(/\r?\n/).pop() || `FFmpeg terminó con código ${code}`))));
  });
}

/** Full `ffmpeg -i` report (it exits non-zero without an output, which is expected). */
function ffmpegInfo(file) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(err));
  });
}

module.exports = {
  FFMPEG,
  timestamp,
  probeEncoders,
  pickEncoder,
  resolveEncoder,
  videoEncoderArgs,
  streamTargets,
  teeEscape,
  outputArgs,
  parseStats,
  isProgressLine,
  netInputArgs,
  parseProbe,
  runFfmpeg,
  ffmpegInfo,
};
