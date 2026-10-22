import { DEFAULT_AUDIO_FX, FADER_MAX, faderToGain, gainToDbLabel, levelToDb } from './audio.js';
import { CHANNEL_SLOTS } from './midi.js';
import { app, saveSettings, state } from './store.js';
import { ask } from './ui-common.js';
import { $, $$, h } from './util.js';

const strips = new Map(); // input id -> strip
let masterStrip = null;
const emptyMixer = h('div', { class: 'empty' }, 'Las entradas con audio aparecerán aquí.');

function buildStrip({ name, getVolume, setVolume, getMuted, setMuted, extraButtons = [] }) {
  const meter = h('canvas', { class: 'meter', width: 14, height: 96 });
  const db = h('div', { class: 'db' });
  const fader = h('input', { class: 'fader', type: 'range', min: 0, max: FADER_MAX, step: 1, value: getVolume(), title: 'Doble clic: 0 dB' });
  const showDb = () => {
    db.textContent = gainToDbLabel(faderToGain(Number(fader.value)));
  };
  const set = (v) => {
    setVolume(v);
    showDb();
  };
  fader.addEventListener('input', () => set(Number(fader.value)));
  fader.addEventListener('dblclick', () => {
    fader.value = 100;
    set(100);
  });
  showDb();
  const mute = h('button', { type: 'button', class: 'mute', title: 'Silenciar' }, 'M');
  const syncMute = () => mute.classList.toggle('on', getMuted());
  mute.addEventListener('click', () => {
    setMuted(!getMuted());
    syncMute();
  });
  syncMute();
  const nameEl = h('div', { class: 'strip-name', title: name }, name);
  const el = h('div', { class: 'strip' }, nameEl, h('div', { class: 'strip-body' }, meter, fader), db, h('div', { class: 'btns' }, mute, ...extraButtons));
  return {
    el,
    meter,
    nameEl,
    fader,
    mute,
    sync() {
      fader.value = getVolume();
      showDb();
      syncMute();
    },
  };
}

function isFxActive(fx) {
  return Object.entries(DEFAULT_AUDIO_FX).some(([k, v]) => fx[k] !== v);
}

function buildChannelStrip(input) {
  const ch = input.channel;
  const afv = h('button', { type: 'button', class: 'afv', title: 'El audio sigue al vídeo: suena solo cuando la entrada está en Program' }, 'AFV');
  const fx = h('button', { type: 'button', class: 'fx', title: 'Ecualizador, compresor, puerta de ruido, retardo…' }, 'FX');
  const strip = buildStrip({
    name: input.name,
    getVolume: () => ch.volume,
    setVolume: (v) => {
      ch.volume = v;
      ch.apply();
    },
    getMuted: () => ch.muted,
    setMuted: (m) => {
      ch.muted = m;
      ch.apply();
    },
    extraButtons: [afv, fx],
  });
  const syncButtons = () => {
    afv.classList.toggle('on', ch.afv);
    fx.classList.toggle('on', isFxActive(ch.fx));
  };
  afv.addEventListener('click', () => {
    ch.afv = !ch.afv;
    ch.apply();
    syncButtons();
  });
  fx.addEventListener('click', async () => {
    await editAudioFx(input);
    syncButtons();
  });
  syncButtons();
  const baseSync = strip.sync;
  strip.sync = () => {
    baseSync();
    syncButtons();
  };
  strip.channel = ch;
  strips.set(input.id, strip);
  return strip;
}

export function buildMasterStrip() {
  const audio = app.audio;
  const mon = h('button', { type: 'button', id: 'btn-monitor', class: 'mon', title: 'Escuchar la mezcla por los altavoces/auriculares' }, '🎧');
  mon.addEventListener('click', () => {
    audio.monitoring = !audio.monitoring;
    audio.applyMaster();
    mon.classList.toggle('on', audio.monitoring);
  });
  masterStrip = buildStrip({
    name: 'MASTER',
    getVolume: () => audio.volume,
    setVolume: (v) => {
      audio.volume = v;
      audio.applyMaster();
    },
    getMuted: () => audio.muted,
    setMuted: (m) => {
      audio.muted = m;
      audio.applyMaster();
    },
    extraButtons: [mon],
  });
  masterStrip.channel = audio;
  // Right-click assigns these to MIDI (see ui-midi-learn.js).
  masterStrip.fader.dataset.midi = 'master';
  masterStrip.mute.dataset.midi = 'master-mute';
  mon.dataset.midi = 'monitor';
  $('#master-strip').append(masterStrip.el);
}

export function dropStrip(input) {
  strips.get(input.id)?.el.remove();
  strips.delete(input.id);
}

function setMidiTarget(el, id) {
  if (id) el.dataset.midi = id;
  else delete el.dataset.midi;
}

export function updateStrips() {
  const container = $('#mixer-strips');
  const audioInputs = state.inputs.filter((i) => i.channel);
  const wanted = audioInputs.map((input, i) => {
    const strip = strips.get(input.id) ?? buildChannelStrip(input);
    strip.nameEl.textContent = input.name;
    // MIDI faders and mutes address channels by position (canal 1, 2…).
    setMidiTarget(strip.fader, i < CHANNEL_SLOTS ? `fader-${i + 1}` : null);
    setMidiTarget(strip.mute, i < CHANNEL_SLOTS ? `mute-${i + 1}` : null);
    strip.el.classList.toggle('live', input.id === state.programId);
    strip.sync();
    return strip.el;
  });
  if (!wanted.length) wanted.push(emptyMixer);
  // Only touch the DOM when the order changed, so a fader being dragged isn't detached.
  const current = [...container.children];
  if (current.length !== wanted.length || current.some((el, i) => el !== wanted[i])) container.replaceChildren(...wanted);
  masterStrip?.sync();
}

function drawMeter(canvas, levels) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: hgt } = canvas;
  ctx.fillStyle = '#0b0c0f';
  ctx.fillRect(0, 0, w, hgt);
  const barW = (w - 3) / 2;
  levels.forEach((level, i) => {
    const frac = Math.min(1, Math.max(0, (levelToDb(level) + 60) / 60));
    const y = hgt * (1 - frac);
    const grad = ctx.createLinearGradient(0, hgt, 0, 0);
    grad.addColorStop(0, '#2fbf71');
    grad.addColorStop(0.7, '#2fbf71');
    grad.addColorStop(0.8, '#f2b33d');
    grad.addColorStop(0.95, '#e5383b');
    ctx.fillStyle = grad;
    ctx.fillRect(1 + i * (barW + 1), y, barW, hgt - y);
  });
  // -18 dB and -6 dB reference ticks
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  for (const db of [-18, -6]) ctx.fillRect(0, hgt * (1 - (db + 60) / 60), w, 1);
}

export function startMeters() {
  const loop = () => {
    if (!document.hidden) {
      for (const strip of strips.values()) drawMeter(strip.meter, strip.channel.meter.read());
      if (masterStrip) drawMeter(masterStrip.meter, app.audio.meter.read());
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const FX_LABELS = {
  trim: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  delay: (v) => `${v} ms`,
  pan: (v) => (v === 0 ? 'Centro' : v < 0 ? `${Math.round(-v * 100)}% izq.` : `${Math.round(v * 100)}% der.`),
  gateThreshold: (v) => `${v} dB`,
  noiseLevel: (v) => `${v} dB`,
  limitThreshold: (v) => `${v} dB`,
  duckAmount: (v) => `${v} dB`,
  eqLow: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  eqMid: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  eqHigh: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  compThreshold: (v) => `${v} dB`,
  compRatio: (v) => `${v}:1`,
};

export async function editAudioFx(input) {
  const ch = input.channel;
  const dlg = $('#dlg-audio');
  const form = dlg.querySelector('form');
  $('#audio-dlg-heading').textContent = `Audio · ${input.name}`;
  const sync = () => {
    for (const [key, value] of Object.entries(ch.fx)) {
      const el = form[key];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
    for (const out of $$('output', form)) out.textContent = FX_LABELS[out.dataset.for]?.(ch.fx[out.dataset.for]) ?? '';
  };
  const apply = () => {
    for (const key of Object.keys(DEFAULT_AUDIO_FX)) {
      const el = form[key];
      if (!el) continue;
      if (el.type === 'checkbox') ch.fx[key] = el.checked;
      else if (typeof DEFAULT_AUDIO_FX[key] === 'string') ch.fx[key] = el.value;
      else ch.fx[key] = Number(el.value);
    }
    ch.applyFx();
    sync();
  };
  sync();
  form.oninput = apply;
  form.onchange = apply;
  $('#btn-reset-audio').onclick = () => {
    Object.assign(ch.fx, DEFAULT_AUDIO_FX);
    ch.applyFx();
    sync();
  };
  await ask(dlg);
  form.oninput = null;
  form.onchange = null;
}

export function setLimiter(on) {
  app.audio.setLimiter(on);
  state.settings.limiter = on;
  saveSettings();
}
