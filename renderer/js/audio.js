import { clamp } from './util.js';

export const FADER_MAX = 125;

export const DEFAULT_AUDIO_FX = {
  trim: 0, // dB
  delay: 0, // ms, to line audio up with late video
  pan: 0,
  hpf: false, // 80 Hz low cut
  noise: false, // spectral noise suppression
  noiseLevel: -30, // dB, how far noise may be pushed down
  gate: false,
  gateMode: 'gate', // 'gate' (ratio 10) | 'expander' (ratio 2)
  gateThreshold: -45,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  comp: false,
  compThreshold: -18,
  compRatio: 3,
  limit: false,
  limitThreshold: -6,
  monitor: 'off', // 'off' | 'monitor' (monitor and output) | 'only' (monitor only)
  duckVoice: false, // this channel is a voice: while it sounds, "ducked" channels go down
  ducked: false, // this channel (music, ambience) goes down while a voice is heard
  duckAmount: -12, // dB
};

const GATE_PRESETS = {
  gate: { ratio: 10, attack: 5, release: 125 },
  expander: { ratio: 2, attack: 10, release: 50 },
};

/** Fader position (0–125, 100 = unity) to linear gain. */
export function faderToGain(value) {
  return value <= 0 ? 0 : (value / 100) ** 2;
}

export function gainToDbLabel(gain) {
  if (gain <= 0) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function levelToDb(level) {
  return level > 0 ? 20 * Math.log10(level) : -100;
}

const dbToGain = (db) => 10 ** (db / 20);

const DUCK_THRESHOLD_DB = -38;
const DUCK_HOLD_MS = 450;

class StereoMeter {
  constructor(ctx) {
    this.input = ctx.createChannelSplitter(2);
    this.analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.buffer = new Float32Array(1024);
    this.levels = [0, 0];
    this.analysers.forEach((analyser, i) => {
      analyser.fftSize = 1024;
      this.input.connect(analyser, i);
    });
  }

  /** Peak level per channel with a short decay so the meter doesn't flicker. */
  read() {
    this.analysers.forEach((analyser, i) => {
      analyser.getFloatTimeDomainData(this.buffer);
      let peak = 0;
      for (let k = 0; k < this.buffer.length; k++) peak = Math.max(peak, Math.abs(this.buffer[k]));
      this.levels[i] = Math.max(peak, this.levels[i] * 0.86);
    });
    return this.levels;
  }

  disconnect() {
    this.input.disconnect();
  }
}

function makeLimiter(ctx) {
  const node = ctx.createDynamicsCompressor();
  node.knee.value = 0;
  node.ratio.value = 20;
  node.attack.value = 0.001;
  node.release.value = 0.06;
  return node;
}

/**
 * One mixer channel:
 * source → trim → delay → low cut → noise suppression → gate/expander → EQ (3 bands)
 *        → [compressor] → [limiter] → pan → fader → master (and/or monitor)
 */
export class Channel {
  constructor(engine, source, afv) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;
    this.source = source;
    this.trim = ctx.createGain();
    this.delay = ctx.createDelay(1);
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.Q.value = 0.7;
    this.denoise = engine.dspReady ? new AudioWorkletNode(ctx, 'noise-suppressor') : null;
    this.gate = engine.dspReady ? new AudioWorkletNode(ctx, 'expander') : null;
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 120;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1200;
    this.mid.Q.value = 0.9;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 7000;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.15;
    this.limiter = makeLimiter(ctx);
    this.pan = ctx.createStereoPanner();
    this.duck = ctx.createGain();
    this.peakBuffer = new Float32Array(512);
    this.gain = ctx.createGain();
    this.meter = new StereoMeter(ctx);

    this.volume = 100;
    this.muted = false;
    this.afv = afv;
    this.presence = 1;
    this.applied = null;
    this.fx = { ...DEFAULT_AUDIO_FX };
    this.wiring = null;
    this.applyFx();
  }

  wire() {
    const fx = this.fx;
    const nodes = [this.source, this.trim, this.delay, this.hpf, this.denoise, this.gate, this.low, this.mid, this.high, this.comp, this.limiter, this.pan, this.gain, this.duck];
    for (const node of nodes) node?.disconnect();
    const chain = [this.source, this.trim, this.delay, this.hpf, this.denoise, this.gate, this.low, this.mid, this.high, fx.comp ? this.comp : null, fx.limit ? this.limiter : null, this.pan, this.gain, this.duck].filter(Boolean);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    this.duck.connect(this.meter.input);
    if (fx.monitor !== 'only') this.duck.connect(this.engine.sum);
    if (fx.monitor !== 'off') this.duck.connect(this.engine.monitorBus);
    this.wiring = `${fx.comp}|${fx.limit}|${fx.monitor}`;
  }

  applyFx() {
    const fx = this.fx;
    const now = this.ctx.currentTime;
    if (this.wiring !== `${fx.comp}|${fx.limit}|${fx.monitor}`) this.wire();
    this.trim.gain.setTargetAtTime(dbToGain(fx.trim), now, 0.02);
    this.delay.delayTime.setTargetAtTime(clamp(fx.delay, 0, 1000) / 1000, now, 0.02);
    this.hpf.frequency.setTargetAtTime(fx.hpf ? 80 : 10, now, 0.02);
    if (this.denoise) {
      this.denoise.parameters.get('enabled').value = fx.noise ? 1 : 0;
      this.denoise.parameters.get('level').value = fx.noiseLevel;
    }
    if (this.gate) {
      const preset = GATE_PRESETS[fx.gateMode] ?? GATE_PRESETS.gate;
      const p = this.gate.parameters;
      p.get('enabled').value = fx.gate ? 1 : 0;
      p.get('threshold').value = fx.gateThreshold;
      p.get('ratio').value = preset.ratio;
      p.get('attack').value = preset.attack;
      p.get('release').value = preset.release;
    }
    this.limiter.threshold.setTargetAtTime(fx.limitThreshold, now, 0.02);
    this.low.gain.setTargetAtTime(fx.eqLow, now, 0.02);
    this.mid.gain.setTargetAtTime(fx.eqMid, now, 0.02);
    this.high.gain.setTargetAtTime(fx.eqHigh, now, 0.02);
    this.comp.threshold.setTargetAtTime(fx.compThreshold, now, 0.02);
    this.comp.ratio.setTargetAtTime(fx.compRatio, now, 0.02);
    this.pan.pan.setTargetAtTime(clamp(fx.pan, -1, 1), now, 0.02);
  }

  /** Current peak after the fader (0–1), read without touching the meter decay. */
  instantPeak() {
    let peak = 0;
    for (const analyser of this.meter.analysers) {
      analyser.getFloatTimeDomainData(this.peakBuffer);
      for (let i = 0; i < this.peakBuffer.length; i++) peak = Math.max(peak, Math.abs(this.peakBuffer[i]));
    }
    return peak;
  }

  setPresence(presence) {
    this.presence = clamp(presence, 0, 1);
    this.apply();
  }

  get effectiveGain() {
    if (this.muted) return 0;
    return faderToGain(this.volume) * (this.afv ? this.presence : 1);
  }

  apply() {
    const g = this.effectiveGain;
    if (this.applied !== null && Math.abs(g - this.applied) < 1e-4) return;
    this.applied = g;
    this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
  }

  serialize() {
    return { volume: this.volume, muted: this.muted, afv: this.afv, fx: { ...this.fx } };
  }

  restore(data) {
    if (!data) return;
    this.volume = data.volume ?? this.volume;
    this.muted = data.muted ?? this.muted;
    this.afv = data.afv ?? this.afv;
    Object.assign(this.fx, data.fx ?? {});
    this.applied = null;
    this.applyFx();
    this.apply();
  }

  dispose() {
    for (const node of [this.source, this.trim, this.delay, this.hpf, this.denoise, this.gate, this.low, this.mid, this.high, this.comp, this.limiter, this.pan, this.gain, this.duck]) {
      node?.disconnect();
    }
    this.meter.disconnect();
    this.engine.channels.delete(this);
  }
}

/**
 * Mix bus: every channel feeds `master` → [limiter] → fade (FTB) → output
 * stream (`dest`, used by streaming/recording) and an optional headphone monitor.
 */
export class AudioEngine {
  constructor() {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    // Nothing here suspends the mix on purpose; the system can (a sound card
    // unplugged or changed). Stream and recording stall without audio, so restart it.
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') this.resume();
    });
    // Unity-gain sum of all channels, before the master fader. Mix-minus feeds
    // for guests subtract a channel from this exact signal.
    this.sum = ctx.createGain();
    this.master = ctx.createGain();
    this.sum.connect(this.master);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.fade = ctx.createGain();
    this.meter = new StereoMeter(ctx);
    this.dest = ctx.createMediaStreamDestination();
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    // Per-channel monitoring (like OBS "monitor only" / "monitor and output") goes straight to the speakers.
    this.monitorBus = ctx.createGain();
    // Everything heard locally meets here; it plays on the context's own
    // output or, for another sound card, through an <audio> element.
    this.listen = ctx.createGain();
    this.listen.connect(ctx.destination);
    this.monitorBus.connect(this.listen);
    this.listenDevice = '';
    this.listenEl = null;
    this.listenStream = null;
    this.fade.connect(this.meter.input);
    this.fade.connect(this.dest);
    this.fade.connect(this.monitor);
    this.monitor.connect(this.listen);
    this.volume = 100;
    this.muted = false;
    this.monitoring = false;
    this.limiterOn = true;
    this.lastFade = 1;
    this.channels = new Set();
    this.voiceUntil = 0;
    this.ducking = false;
    // Ducking: when any "voice" channel is above the threshold, "ducked" channels
    // are pulled down; they come back smoothly after a short hold.
    setInterval(() => this.updateDucking(), 50);
    this.dspReady = false;
    this.wireMaster();
    this.applyMaster();
  }

  async init() {
    try {
      await this.ctx.audioWorklet.addModule('js/dsp.worklet.js');
      this.dspReady = true;
    } catch (err) {
      console.warn('Filtros de audio avanzados no disponibles', err);
    }
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  get outputTrack() {
    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  wireMaster() {
    this.master.disconnect();
    this.limiter.disconnect();
    if (this.limiterOn) {
      this.master.connect(this.limiter);
      this.limiter.connect(this.fade);
    } else {
      this.master.connect(this.fade);
    }
  }

  /**
   * Sends monitoring (headphones, per-channel monitor) to another sound card.
   * The context itself never changes device: it clocks the stream and
   * recording audio, which must not stall or move with the headphones (a
   * sink change can leave it suspended, and an unplugged card would stop it).
   */
  async setOutputDevice(deviceId = '') {
    if (deviceId === this.listenDevice) return;
    if (!deviceId) {
      this.listen.disconnect();
      this.listen.connect(this.ctx.destination);
      this.listenEl?.pause();
      this.listenDevice = '';
      return;
    }
    const el = this.listenEl ?? new Audio();
    if (typeof el.setSinkId !== 'function') throw new Error('Este equipo no permite elegir la salida de audio.');
    this.listenStream ??= this.ctx.createMediaStreamDestination();
    el.srcObject = this.listenStream.stream;
    await el.setSinkId(deviceId);
    await el.play();
    this.listenEl = el;
    this.listen.disconnect();
    this.listen.connect(this.listenStream);
    this.listenDevice = deviceId;
  }

  setLimiter(on) {
    if (on === this.limiterOn) return;
    this.limiterOn = on;
    this.wireMaster();
  }

  updateDucking() {
    const now = performance.now();
    for (const ch of this.channels) {
      if (ch.fx.duckVoice && !ch.muted && levelToDb(ch.instantPeak()) > DUCK_THRESHOLD_DB) this.voiceUntil = now + DUCK_HOLD_MS;
    }
    const active = now < this.voiceUntil;
    const t = this.ctx.currentTime;
    for (const ch of this.channels) {
      const target = active && ch.fx.ducked && !ch.fx.duckVoice ? dbToGain(ch.fx.duckAmount) : 1;
      if (ch.duckTarget === target) continue;
      ch.duckTarget = target;
      // Fast down (~80 ms), slow back up (~600 ms).
      ch.duck.gain.setTargetAtTime(target, t, target < 1 ? 0.03 : 0.2);
    }
    this.ducking = active;
  }

  attach(input) {
    const source = input.createAudioNode?.(this.ctx);
    if (!source) return null;
    input.channel = new Channel(this, source, input.defaultAfv);
    this.channels.add(input.channel);
    return input.channel;
  }

  /**
   * Mix-minus: everything in the mix except one channel (a guest hears the show
   * but not their own delayed voice). Returns a MediaStream track for WebRTC.
   */
  createMixMinus() {
    const bus = this.ctx.createGain();
    const invert = this.ctx.createGain();
    invert.gain.value = -1;
    const dest = this.ctx.createMediaStreamDestination();
    this.sum.connect(bus);
    invert.connect(bus);
    bus.connect(dest);
    let channel = null;
    return {
      track: dest.stream.getAudioTracks()[0],
      /** Starts subtracting a channel: its post-fader signal, exactly as it enters the sum. */
      exclude(ch) {
        channel = ch;
        ch.duck.connect(invert);
      },
      dispose: () => {
        try {
          this.sum.disconnect(bus);
          channel?.duck.disconnect(invert);
        } catch {
          // Already disconnected.
        }
        bus.disconnect();
      },
    };
  }

  /** Routes a media element (e.g. the stinger clip) straight into the master bus. */
  connectElement(el) {
    const source = this.ctx.createMediaElementSource(el);
    source.connect(this.sum);
    return source;
  }

  applyMaster() {
    const g = this.muted ? 0 : faderToGain(this.volume);
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
    this.monitor.gain.setTargetAtTime(this.monitoring ? 1 : 0, this.ctx.currentTime, 0.015);
  }

  /** Fade-to-black also fades the program audio. */
  setFade(value) {
    if (Math.abs(value - this.lastFade) < 1e-3) return;
    this.lastFade = value;
    this.fade.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }
}
