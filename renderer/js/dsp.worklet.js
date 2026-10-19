// Audio processors that Web Audio doesn't provide natively.

// ---------------------------------------------------------------------------
// Downward expander / noise gate with an RMS detector. Below the threshold the
// signal is attenuated by (threshold - level) × (ratio - 1) dB; a high ratio
// behaves like a gate.
// ---------------------------------------------------------------------------
class Expander extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -40, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 2, minValue: 1, maxValue: 50, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 10, minValue: 0.1, maxValue: 500, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 50, minValue: 1, maxValue: 2000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.power = 0;
    this.gainDb = 0;
    this.rmsCoef = 1 - Math.exp(-1 / (0.01 * sampleRate));
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;
    const n = input[0].length;
    if (params.enabled[0] < 0.5) {
      for (let c = 0; c < output.length; c++) output[c].set(input[c] ?? input[0]);
      this.gainDb = 0;
      return true;
    }
    const threshold = params.threshold[0];
    const ratio = params.ratio[0];
    const attack = 1 - Math.exp(-1 / ((params.attack[0] / 1000) * sampleRate));
    const release = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate));
    for (let i = 0; i < n; i++) {
      let sq = 0;
      for (let c = 0; c < input.length; c++) sq = Math.max(sq, input[c][i] * input[c][i]);
      this.power += (sq - this.power) * this.rmsCoef;
      const level = 10 * Math.log10(this.power + 1e-12);
      const target = level < threshold ? Math.max(-80, (level - threshold) * (ratio - 1)) : 0;
      // Opening (gain rising) uses the attack time, closing the release time.
      this.gainDb += (target - this.gainDb) * (target > this.gainDb ? attack : release);
      const g = 10 ** (this.gainDb / 20);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] ?? input[0])[i] * g;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Spectral noise suppression. 512-point STFT, 50% overlap, sqrt-Hann windows
// (analysis × synthesis sums to one). The noise floor per bin follows the
// minimum of the smoothed power; each bin gets a Wiener-style gain limited by
// the user's suppression level. Adds ~11 ms of latency while enabled.
// ---------------------------------------------------------------------------
const N = 512;
const HOP = N / 2;
const BINS = N / 2 + 1;
const OVERSUBTRACT = 4;

const WINDOW = new Float32Array(N);
for (let i = 0; i < N; i++) WINDOW[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

const BITREV = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  BITREV[i] = r;
}
const COS = new Float32Array(N / 2);
const SIN = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / N);
  SIN[i] = Math.sin((2 * Math.PI * i) / N);
}

/** In-place iterative radix-2 FFT; `inverse` uses conjugate twiddles (unscaled). */
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = BITREV[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step];
        const wi = inverse ? SIN[k * step] : -SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

class ChannelState {
  constructor() {
    this.frame = new Float32Array(N); // last N input samples
    this.fill = 0;
    this.ola = new Float32Array(N); // overlap-add accumulator
    this.out = new Float32Array(8192); // output ring
    this.read = 0;
    this.write = N; // start with N samples of silence = algorithm latency
    this.power = new Float32Array(BINS);
    this.noise = new Float32Array(BINS);
    this.gain = new Float32Array(BINS).fill(1);
    this.frames = 0;
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
  }
}

class NoiseSuppressor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'level', defaultValue: -30, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.channels = [];
  }

  processFrame(st, floor) {
    const { re, im, frame, power, noise, gain } = st;
    for (let i = 0; i < N; i++) {
      re[i] = frame[i] * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im, false);
    const warmup = st.frames < 20;
    for (let k = 0; k < BINS; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[k] = st.frames === 0 ? p : power[k] * 0.8 + p * 0.2;
      if (warmup) noise[k] = st.frames === 0 ? power[k] : noise[k] * 0.9 + power[k] * 0.1;
      else if (power[k] < noise[k]) noise[k] = noise[k] * 0.9 + power[k] * 0.1;
      else noise[k] *= 1.002; // let the floor creep up if the noise gets louder
      // Tracking minima underestimates the mean noise power, so over-subtract;
      // using the smoothed power (not this frame's) avoids "musical noise".
      const g = Math.max(floor, 1 - (OVERSUBTRACT * noise[k]) / (Math.max(power[k], p * 0.5) + 1e-12));
      gain[k] = g < gain[k] ? g : gain[k] * 0.6 + g * 0.4;
      re[k] *= gain[k];
      im[k] *= gain[k];
      if (k > 0 && k < N / 2) {
        re[N - k] *= gain[k];
        im[N - k] *= gain[k];
      }
    }
    st.frames++;
    fft(re, im, true);
    for (let i = 0; i < N; i++) st.ola[i] += (re[i] / N) * WINDOW[i];
    for (let i = 0; i < HOP; i++) {
      st.out[st.write % st.out.length] = st.ola[i];
      st.write++;
    }
    st.ola.copyWithin(0, HOP);
    st.ola.fill(0, N - HOP);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;
    if (params.enabled[0] < 0.5) {
      for (let c = 0; c < output.length; c++) output[c].set(input[c] ?? input[0]);
      this.channels = [];
      return true;
    }
    const floor = 10 ** (params.level[0] / 20);
    for (let c = 0; c < output.length; c++) {
      const src = input[c] ?? input[0];
      const st = (this.channels[c] ??= new ChannelState());
      const dst = output[c];
      for (let i = 0; i < src.length; i++) {
        st.frame[st.fill++] = src[i];
        if (st.fill === N) {
          this.processFrame(st, floor);
          st.frame.copyWithin(0, HOP);
          st.fill = N - HOP;
        }
        dst[i] = st.read < st.write ? st.out[st.read % st.out.length] : 0;
        st.read++;
      }
    }
    return true;
  }
}

registerProcessor('expander', Expander);
registerProcessor('noise-suppressor', NoiseSuppressor);
