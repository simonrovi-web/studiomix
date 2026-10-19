// Network input (SRT / RTSP / RTMP / UDP / HLS). The main process turns the
// stream into fragmented MP4; it is played here with Media Source Extensions.
import { Input } from './inputs.js';
import { drawPlaceholder } from './util.js';

const VIDEO_CODEC = 'avc1.640029'; // H.264 High 4.1, as produced by the main process
const AUDIO_CODEC = 'mp4a.40.2';
const MAX_LATENCY = 0.8; // seconds behind the live edge before jumping forward
const registry = new Map();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.studio.onNetInput(
    (id, chunk) => registry.get(id)?.append(chunk),
    (status) => registry.get(status.id)?.onStatus(status),
  );
}

export class NetworkInput extends Input {
  constructor({ url, name, listenPort = null }) {
    super('network', name || 'Red');
    listen();
    this.url = url;
    this.listenPort = listenPort;
    this.netId = `net-${this.id}-${Date.now()}`;
    this.state = 'waiting';
    this.defaultAfv = true;
    this.queue = [];
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.el = document.createElement('video');
    this.el.playsInline = true;
    this.el.autoplay = true;
    document.getElementById('media-host').append(this.el);
    registry.set(this.netId, this);
    window.studio.startNetInput(this.netId, url).catch((err) => {
      this.state = 'error';
      this.error = err.message;
    });
    this.latencyTimer = setInterval(() => this.keepLive(), 500);
  }

  /** A new FFmpeg run started (first time or after a reconnect): fresh MediaSource. */
  onStatus(status) {
    this.state = status.state;
    // 'waiting' is sent before a run produces any data, so leftovers of the
    // previous run are dropped here. Not on 'ready': stdout and stderr are
    // separate pipes, so this run's first bytes (the MP4 header) can arrive
    // before the 'ready' notice and must be kept.
    if (status.state === 'waiting' || status.state === 'lost') {
      this.queue = [];
      return;
    }
    if (status.state !== 'ready') return;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.sourceBuffer = null;
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      const codecs = status.hasAudio ? `${VIDEO_CODEC}, ${AUDIO_CODEC}` : VIDEO_CODEC;
      this.sourceBuffer = ms.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
      this.sourceBuffer.mode = 'segments';
      this.sourceBuffer.addEventListener('updateend', () => this.flush());
      this.flush();
    }, { once: true });
    this.el.src = URL.createObjectURL(ms);
    this.el.play().catch(() => {});
  }

  append(chunk) {
    this.queue.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    this.flush();
  }

  flush() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || !this.queue.length || this.mediaSource?.readyState !== 'open') return;
    const size = this.queue.reduce((n, c) => n + c.byteLength, 0);
    const data = new Uint8Array(size);
    let offset = 0;
    for (const c of this.queue) {
      data.set(c, offset);
      offset += c.byteLength;
    }
    this.queue = [];
    try {
      sb.appendBuffer(data);
    } catch (err) {
      // QuotaExceeded: drop old media and try again on the next chunk.
      if (err.name === 'QuotaExceededError' && this.el.currentTime > 5) sb.remove(0, this.el.currentTime - 2);
    }
  }

  /** Stay close to live: jump forward if playback falls behind, trim old media. */
  keepLive() {
    const v = this.el;
    const sb = this.sourceBuffer;
    if (!sb || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    if (end - v.currentTime > MAX_LATENCY) v.currentTime = end - 0.15;
    if (v.paused) v.play().catch(() => {});
    if (!sb.updating && v.currentTime > 20 && v.buffered.start(0) < v.currentTime - 15) {
      try {
        sb.remove(0, v.currentTime - 10);
      } catch {
        // Busy; next tick.
      }
    }
  }

  get latency() {
    const v = this.el;
    return v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
  }

  source() {
    const v = this.el;
    return v.readyState >= 2 && v.videoWidth ? { el: v, w: v.videoWidth, h: v.videoHeight } : null;
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode === 'program') return;
    const text = { waiting: this.listenPort ? `Esperando señal en el puerto ${this.listenPort}…` : 'Conectando…', lost: 'Señal perdida, reintentando…', error: this.error ?? 'Error' }[this.state] ?? 'Cargando…';
    drawPlaceholder(ctx, x, y, w, h, '🌐', text);
  }

  /** Live stream of this input, for ISO recording. */
  captureStream() {
    return this.el.captureStream?.() ?? null;
  }

  createAudioNode(ctx) {
    return ctx.createMediaElementSource(this.el);
  }

  serialize() {
    return { ...super.serialize(), url: this.url, listenPort: this.listenPort };
  }

  destroy() {
    super.destroy();
    clearInterval(this.latencyTimer);
    registry.delete(this.netId);
    window.studio.stopNetInput(this.netId);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.remove();
  }
}
