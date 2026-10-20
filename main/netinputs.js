'use strict';

// Network inputs (SRT / RTSP / RTMP / UDP / HLS). FFmpeg receives the stream
// and re-emits low-latency fragmented MP4 on stdout; the renderer plays it
// through Media Source Extensions like any other input.

const { spawn } = require('node:child_process');
const ffmpeg = require('./ffmpeg');
const context = require('./context');
const log = require('./log').scope('netinput');

const netInputs = new Map();
const SUPPORTED = /^(srt|rtsp|rtmps?|udp|rtp|https?):\/\//i;

/** Hides credentials (user:pass@) before a URL goes to the log. */
const redact = (url) => url.replace(/\/\/[^/@]*@/, '//***@');

async function startNetInput(id, url) {
  stopNetInput(id);
  if (!SUPPORTED.test(url)) throw new Error('Usa una dirección srt://, rtsp://, rtmp://, udp:// o http(s)://');
  const encoder = await ffmpeg.resolveEncoder('auto');
  const entry = { id, url, proc: null, stopped: false, timer: 0 };
  netInputs.set(id, entry);
  log.info(`Entrada ${id}:`, redact(url));

  const launch = () => {
    if (entry.stopped) return;
    const proc = spawn(ffmpeg.FFMPEG, ffmpeg.netInputArgs(url, encoder), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    entry.proc = proc;
    let header = '';
    let announced = false;
    context.send('netinput:status', { id, state: 'waiting' });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      if (announced) return;
      header += chunk;
      // FFmpeg prints the input streams before writing any output.
      if (/Output #0/.test(header)) {
        announced = true;
        const inputPart = header.split('Output #0')[0];
        context.send('netinput:status', { id, state: 'ready', hasAudio: /Stream #0:\d+.*Audio:/.test(inputPart) });
      }
    });
    proc.stdout.on('data', (chunk) => context.send('netinput:data', id, chunk));
    proc.on('error', (err) => log.warn(`Entrada ${id}: no se pudo iniciar FFmpeg:`, err.message));
    proc.on('close', (code) => {
      if (entry.stopped || netInputs.get(id) !== entry) return;
      // Source gone (camera off, network blip): keep trying.
      if (announced) log.info(`Entrada ${id}: señal perdida (código ${code}), reintentando`);
      context.send('netinput:status', { id, state: 'lost' });
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

function stopAllNetInputs() {
  for (const id of [...netInputs.keys()]) stopNetInput(id);
}

module.exports = { startNetInput, stopNetInput, stopAllNetInputs, redact };
