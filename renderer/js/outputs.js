// MediaRecorder encodes a video track + audio track and the main process pipes
// it through FFmpeg. H.264 is preferred so recordings can be remuxed without
// re-encoding the video.
//
// Outputs are keyed: 'stream', 'record', 'replay', 'vstream' (vertical stream)
// and 'iso:<inputId>' (per-camera recordings). Network streams reconnect on
// their own with back-off once they had connected at least once.
const RECONNECTING_KINDS = new Set(['stream', 'vstream']);
const MAX_RETRY_DELAY = 30;

// H.264 levels: [level_idc, max macroblocks per second, max macroblocks per frame].
const H264_LEVELS = [
  [0x28, 245760, 8192], // 4.0: 1080p30
  [0x2a, 522240, 8704], // 4.2: 1080p60
  [0x32, 589824, 22080], // 5.0: 1440p30
  [0x33, 983040, 36864], // 5.1: 2160p30
  [0x34, 2073600, 36864], // 5.2: 2160p60
];

/**
 * Codec string asking for H.264 High profile at the lowest level that fits
 * the picture (players reject files above their level). Without a profile
 * Chromium encodes Constrained Baseline, which needs more bits for the same
 * quality.
 */
export function h264HighCodec(width, height, fps) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = frameMbs * Math.ceil(fps || 30);
  const level = H264_LEVELS.find(([, maxRate, maxFrame]) => rate <= maxRate && frameMbs <= maxFrame) ?? H264_LEVELS.at(-1);
  return `avc1.6400${level[0].toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Best format MediaRecorder offers for this video track: H.264 High, then any H.264, then VP9/VP8. */
function pickMime(track, fps) {
  const { width = 1920, height = 1080, frameRate } = track?.getSettings?.() ?? {};
  const candidates = [
    [`video/x-matroska;codecs=${h264HighCodec(width, height, frameRate || fps)},opus`, 'h264'],
    ['video/x-matroska;codecs=avc1,opus', 'h264'],
    ['video/webm;codecs=h264,opus', 'h264'],
    ['video/webm;codecs=vp9,opus', 'vp9'],
    ['video/webm;codecs=vp8,opus', 'vp8'],
  ];
  for (const [mime, codec] of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, codec };
  }
  throw new Error('Este equipo no puede codificar vídeo con MediaRecorder.');
}

export class OutputManager {
  /**
   * @param {{ tracksFor: (kind: string) => MediaStreamTrack[],
   *           settings: () => object, onChange: () => void, onError: (msg: string) => void,
   *           onFinished: (key: string, file: string | null) => void,
   *           onReconnect?: (key: string, entry: object) => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.active = new Map();
    window.studio.onOutputStatus((status) => this.handleStatus(status));
  }

  get(key) {
    return this.active.get(key) ?? null;
  }

  get busy() {
    return this.active.size > 0;
  }

  /** Main outputs that lock resolution/fps (ISO recordings don't). */
  get busyMain() {
    return [...this.active.keys()].some((k) => !k.startsWith('iso:'));
  }

  /**
   * Starts an output. `spec` may give `kind`, `tracks` (MediaStreamTrack[]),
   * `label` (used in file names) and `extra` (passed to FFmpeg setup).
   */
  async start(key, spec = {}) {
    if (this.active.has(key)) return;
    const entry = {
      key,
      kind: spec.kind ?? key,
      label: spec.label ?? null,
      tracks: spec.tracks ?? null,
      extra: spec.extra ?? {},
      id: null,
      startedAt: performance.now(),
      stats: null,
      file: null,
      stopping: false,
      recorder: null,
      chain: Promise.resolve(),
      pausedAt: 0,
      pausedTotal: 0,
      connected: false,
      attempt: 0,
      retryTimer: 0,
      retryAt: 0,
      lastError: null,
    };
    this.active.set(key, entry);
    this.opts.onChange();
    try {
      await this.launch(entry);
    } catch (err) {
      this.active.delete(key);
      this.opts.onChange();
      throw err;
    }
    entry.startedAt = performance.now();
    this.opts.onChange();
  }

  /** Spawns FFmpeg and a fresh MediaRecorder for an entry (also used to reconnect). */
  async launch(entry) {
    const s = this.opts.settings();
    const tracks = (entry.tracks ?? this.opts.tracksFor(entry.kind)).filter(Boolean);
    const video = tracks.find((t) => t.kind === 'video');
    if (!video) throw new Error('No hay vídeo que enviar.');
    const { mime, codec } = pickMime(video, s.fps);
    entry.id = `${entry.key}-${Date.now()}`;
    entry.connected = false;
    entry.stats = null;
    const vertical = entry.kind === 'vstream';
    const result = await window.studio.startOutput({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      videoCodec: codec,
      fps: s.fps,
      destinations: (vertical ? s.verticalDestinations : s.destinations).map((d) => ({ enabled: d.enabled, name: d.name, url: d.url, key: d.key })),
      encoder: s.encoder,
      x264Preset: s.x264Preset,
      videoKbps: vertical ? s.verticalKbps : s.streamVideoKbps,
      audioKbps: s.audioKbps,
      folder: s.recordFolder,
      format: s.recordFormat,
      recordMbps: s.recordMbps,
      replaySeconds: s.replaySeconds,
      ...entry.extra,
    });
    if (!result.ok) throw new Error(result.error);
    entry.file = result.file;
    entry.encoder = result.encoder;

    // Streams are re-encoded by FFmpeg, so the intermediate only needs to be clean.
    const network = RECONNECTING_KINDS.has(entry.kind);
    const videoBitsPerSecond = network ? Math.max(s.streamVideoKbps * 2000, 8e6) : s.recordMbps * 1e6;
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond, audioBitsPerSecond: 256000 });
    entry.recorder = recorder;
    entry.chain = Promise.resolve();
    const id = entry.id;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      // Keep chunks in order: arrayBuffer() resolves asynchronously.
      entry.chain = entry.chain.then(async () => {
        window.studio.writeOutput(id, new Uint8Array(await event.data.arrayBuffer()));
      });
    };
    recorder.onerror = (event) => {
      this.opts.onError(`Error del codificador: ${event.error?.message ?? 'desconocido'}`);
      this.stop(entry.key);
    };
    recorder.start(200);
    entry.launchedAt = performance.now();
  }

  /** Pauses or resumes a recording; paused time is left out of the file. */
  togglePause(key) {
    const entry = this.active.get(key);
    const recorder = entry?.recorder;
    if (!recorder || entry.stopping) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      entry.pausedAt = performance.now();
    } else if (recorder.state === 'paused') {
      recorder.resume();
      entry.pausedTotal += performance.now() - entry.pausedAt;
      entry.pausedAt = 0;
    }
    this.opts.onChange();
  }

  isPaused(key) {
    return this.active.get(key)?.recorder?.state === 'paused';
  }

  /** Waiting to retry, or retried but not sending yet: either way, not live. */
  isReconnecting(key) {
    const entry = this.active.get(key);
    return !!entry && (!!entry.retryAt || (entry.attempt > 0 && !entry.connected));
  }

  /** Running time without pauses, in ms. */
  elapsed(entry) {
    const now = performance.now();
    return now - entry.startedAt - entry.pausedTotal - (entry.pausedAt ? now - entry.pausedAt : 0);
  }

  /** Saves the last N seconds kept by the replay buffer as an MP4. */
  async saveReplay() {
    const entry = this.active.get('replay');
    if (!entry || entry.stopping) throw new Error('Activa primero el búfer de repetición.');
    const s = this.opts.settings();
    return window.studio.saveReplay(entry.id, s.replaySeconds, s.recordFolder || null);
  }

  async stopRecorder(entry) {
    const recorder = entry.recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.stop();
      });
    }
    await entry.chain;
  }

  async stop(key) {
    const entry = this.active.get(key);
    if (!entry || entry.stopping) return;
    entry.stopping = true;
    clearTimeout(entry.retryTimer);
    this.opts.onChange();
    await this.stopRecorder(entry);
    const result = entry.id ? await window.studio.stopOutput(entry.id) : null;
    this.active.delete(key);
    this.opts.onChange();
    this.opts.onFinished(key, result?.file ?? entry.file);
  }

  /** Saves the current Program frame as a PNG next to the recordings. */
  async snapshot(canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo capturar la imagen');
    return window.studio.saveSnapshot(new Uint8Array(await blob.arrayBuffer()), this.opts.settings().recordFolder || null);
  }

  async stopAll() {
    await Promise.all([...this.active.keys()].map((key) => this.stop(key)));
  }

  scheduleReconnect(entry, reason) {
    entry.attempt++;
    entry.lastError = reason;
    const delay = Math.min(MAX_RETRY_DELAY, 2 ** entry.attempt);
    entry.retryAt = performance.now() + delay * 1000;
    this.opts.onReconnect?.(entry.key, entry);
    this.opts.onChange();
    entry.retryTimer = setTimeout(async () => {
      if (entry.stopping || this.active.get(entry.key) !== entry) return;
      entry.retryAt = 0;
      try {
        await this.launch(entry);
        this.opts.onChange();
      } catch (err) {
        this.scheduleReconnect(entry, err.message);
      }
    }, delay * 1000);
  }

  handleStatus(status) {
    const entry = [...this.active.values()].find((e) => e.id === status.id);
    if (!entry) return;
    if (status.state === 'stats') {
      entry.stats = status.stats;
      if (!entry.connected) {
        entry.connected = true;
        if (entry.attempt) this.opts.onReconnect?.(entry.key, entry, true);
      }
      // Stable for 30 s: the next drop starts the back-off from the beginning.
      if (entry.attempt && performance.now() - entry.launchedAt > 30000) entry.attempt = 0;
      this.opts.onChange();
      return;
    }
    if (entry.stopping) return;
    this.stopRecorder(entry);
    // A stream that had been sending reconnects; one that never connected
    // (wrong key, bad URL) fails straight away so the user can fix it.
    if (status.state === 'error' && RECONNECTING_KINDS.has(entry.kind) && (entry.connected || entry.attempt > 0)) {
      this.scheduleReconnect(entry, status.message);
      return;
    }
    // FFmpeg ended on its own (bad stream key, disk full…).
    this.active.delete(entry.key);
    if (status.state === 'error') {
      const what = { stream: 'La emisión', vstream: 'La emisión vertical', record: 'La grabación', replay: 'El búfer de repetición', iso: `La grabación ISO de ${entry.label}` }[entry.kind];
      this.opts.onError(`${what} se ha detenido:\n${status.message}`);
    }
    this.opts.onChange();
  }
}
