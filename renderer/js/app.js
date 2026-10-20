import { AudioEngine, FADER_MAX } from './audio.js';
import { Compositor, TRANSITIONS } from './compositor.js';
import { MidiController } from './midi.js';
import { OutputManager } from './outputs.js';
import { loadProject, serializeProject } from './project.js';
import { DEFAULT_SETTINGS, app, byId, changed, onChange, overlayIndexOf, saveSettings, state } from './store.js';
import { ask, closePanels, confirmAction, fillSelect, initPanels, isTyping, panelOpen, showMenu, toast } from './ui-common.js';
import { adders, buildCard, removeCard, updateCardTimes, updateCards } from './ui-inputs.js';
import { openMidiDialog, renderMidiDialog } from './ui-midi.js';
import { buildMasterStrip, dropStrip, editAudioFx, setLimiter, startMeters, updateStrips } from './ui-mixer.js';
import { handleSceneKey, initSceneEditor, previewScene, renderDock } from './ui-scenes.js';
import { destinationReady, initGuide, renderGuide } from './ui-guide.js';
import { initGoLive, openGoLive } from './ui-golive.js';
import { initRemote } from './ui-remote.js';
import { initChat } from './ui-chat.js';
import { initGuests } from './ui-guests.js';
import { initVertical, render as renderVertical } from './ui-vertical.js';
import { initStats } from './ui-stats.js';
import { SceneInput } from './scenes.js';
import { LUMA_PATTERNS } from './transitions.js';
import { VideoFileInput } from './inputs.js';
import { $, $$, fmtTime, h } from './util.js';

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const audio = new AudioEngine();
await audio.init();
audio.setLimiter(state.settings.limiter);

const compositor = new Compositor(state, $('#program-canvas'), $('#preview-canvas'), $('#multiview-canvas'));
compositor.configure(state.settings.width, state.settings.height, state.settings.fps);
compositor.onCommit = () => changed();
compositor.onMasterFade = (value) => audio.setFade(value);
compositor.stinger.onAudioElement = (el) => audio.connectElement(el);
// Media paths are only served after the user picks them again (or opens a project).
state.settings.stinger.path = '';

let appInfo = { defaultRecordFolder: '', ffmpeg: '' };
let encoders = ['x264'];

const outputs = new OutputManager({
  tracksFor: (kind) => [kind === 'vstream' ? compositor.verticalTrack : compositor.videoTrack, audio.outputTrack],
  settings: () => state.settings,
  onChange: () => {
    renderOutputs();
    changed();
  },
  onError: (message) => toast(message, 'error'),
  onFinished: (key, file) => {
    if ((key === 'record' || key === 'vrecord') && file) toast(`Grabación guardada en:\n${file}`);
  },
  onReconnect: (key, entry, recovered) => {
    const what = key === 'vstream' ? 'La emisión vertical' : 'La emisión';
    if (recovered) toast(`${what} se ha recuperado.`);
    else if (entry.attempt === 1) toast(`${what} perdió la conexión. Reconectando automáticamente…\nLa grabación local sigue en marcha.`, 'error');
  },
});

const midi = new MidiController({
  onAction: (id, value) => handleMidiAction(id, value),
  onChange: () => renderMidiDialog(),
});

Object.assign(app, { state, audio, compositor, outputs, midi });

// ---------------------------------------------------------------------------
// Actions (shared by buttons, keyboard and MIDI)
// ---------------------------------------------------------------------------

const actions = {
  addInput(input, { select = true } = {}) {
    audio.resume();
    state.inputs.push(input);
    try {
      audio.attach(input);
    } catch (err) {
      console.warn('Sin audio para', input.name, err);
    }
    if (select && state.previewId == null && input.hasVideo) state.previewId = input.id;
    buildCard(input);
    changed();
  },

  /**
   * Removes an input. With `undoable`, it is only detached (and silenced) and a
   * toast offers to undo for a few seconds; it's destroyed when the toast expires.
   */
  removeInput(input, { undoable = false } = {}) {
    const snapshot = {
      index: state.inputs.indexOf(input),
      program: state.programId === input.id,
      preview: state.previewId === input.id,
      overlays: state.overlays.map((ov) => ov.inputId === input.id && ov.target > 0),
      sceneItems: [],
    };
    if (snapshot.program) state.programId = null;
    if (snapshot.preview) state.previewId = null;
    for (const ov of state.overlays) {
      if (ov.inputId === input.id) Object.assign(ov, { inputId: null, alpha: 0, target: 0 });
    }
    state.inputs = state.inputs.filter((i) => i !== input);
    for (const scene of state.inputs) {
      if (!(scene instanceof SceneInput)) continue;
      scene.items.forEach((item, i) => {
        if (item.inputId === input.id) snapshot.sceneItems.push({ scene, item, i });
      });
      scene.items = scene.items.filter((item) => item.inputId !== input.id);
    }
    removeCard(input);
    dropStrip(input);
    const destroy = () => {
      input.channel?.dispose();
      input.destroy();
    };
    if (!undoable) {
      destroy();
      changed();
      return;
    }
    // Detached inputs no longer get audio presence updates: silence them explicitly.
    if (input.channel) {
      input.channel.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.01);
      input.channel.applied = null;
    }
    changed();
    toast(`«${input.name}» quitada.`, 'info', {
      label: 'Deshacer',
      dismissLabel: 'Cerrar',
      onClick: () => actions.restoreInput(input, snapshot),
    }, { timeout: 8000, onExpire: destroy });
  },

  restoreInput(input, snapshot) {
    state.inputs.splice(Math.min(snapshot.index, state.inputs.length), 0, input);
    buildCard(input);
    if (snapshot.program && state.programId == null) state.programId = input.id;
    if (snapshot.preview && state.previewId == null) state.previewId = input.id;
    snapshot.overlays.forEach((was, i) => {
      if (was && state.overlays[i].inputId == null) compositor.toggleOverlay(i, input.id);
    });
    for (const { scene, item, i } of snapshot.sceneItems) {
      if (state.inputs.includes(scene)) scene.items.splice(Math.min(i, scene.items.length), 0, item);
    }
    input.channel?.apply();
    changed();
  },

  editAudio(input) {
    if (input.channel) editAudioFx(input);
  },

  setPreview(id) {
    if (!byId(id)) return;
    state.previewId = id;
    changed();
  },

  cutTo(id) {
    if (id === state.programId || !byId(id)) return;
    state.previewId = id;
    compositor.cut();
  },

  quickPlay(id) {
    if (id === state.programId || !byId(id)) return;
    state.previewId = id;
    compositor.auto();
    changed();
  },

  toggleOverlay(index, id) {
    if (id == null) return;
    compositor.toggleOverlay(index, id);
    changed();
  },

  /** Overlay button without an input: remove what's there, or put Preview on it. */
  overlayButton(index) {
    const ov = state.overlays[index];
    actions.toggleOverlay(index, ov.inputId != null && ov.target > 0 ? ov.inputId : state.previewId);
  },

  cut: () => compositor.cut(),
  auto: () => compositor.auto(),

  ftb() {
    compositor.toggleFtb();
    changed();
  },

  async snapshot() {
    try {
      const file = await outputs.snapshot(compositor.program);
      toast(`Captura guardada en:\n${file}`);
    } catch (err) {
      toast(`No se pudo guardar la captura: ${err.message}`, 'error');
    }
  },

  async toggleOutput(kind) {
    audio.resume();
    try {
      if (outputs.get(kind)) {
        if (kind === 'stream' && !(await confirmAction('¿Detener la emisión en directo?', { ok: 'Detener emisión', cancel: 'Seguir en directo', danger: true }))) return;
        if (kind === 'record') await actions.stopIso();
        await outputs.stop(kind);
      } else {
        // Without a usable destination, guide the user instead of failing.
        if (kind === 'stream' && !destinationReady()) return openGoLive();
        await outputs.start(kind);
        if (kind === 'record' && state.settings.isoRecording) await actions.startIso();
        if (kind === 'record' && !state.settings.hasRecorded) {
          state.settings.hasRecorded = true;
          saveSettings();
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async startStream() {
    audio.resume();
    try {
      await outputs.start('stream');
      toast('Estás en directo.');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  openSettings: () => openSettings(),

  /** Suggests optimising clips Chromium is likely to play badly (HEVC, 10-bit, 4K60…). */
  async checkVideo(input) {
    let info;
    try {
      info = await window.studio.probeMedia(input.path);
    } catch {
      return;
    }
    // A clip whose video can't be decoded at all also needs converting.
    const undecodable = await new Promise((resolve) => {
      const el = input.el;
      if (el.readyState >= 2 && el.videoWidth) return resolve(false);
      const done = (bad) => {
        clearTimeout(timer);
        resolve(bad);
      };
      const timer = setTimeout(() => done(!(el.readyState >= 2 && el.videoWidth)), 4000);
      el.addEventListener('loadeddata', () => done(!el.videoWidth), { once: true });
      el.addEventListener('error', () => done(true), { once: true });
    });
    const reasons = undecodable ? ['no se puede decodificar', ...info.reasons] : info.reasons;
    if (!reasons.length || !state.inputs.includes(input)) return;
    toast(`«${input.name}» puede ir a tirones o congelarse (${reasons.join(', ')}).\nOptimizarlo crea una copia H.264 fluida.`, 'info', {
      label: 'Optimizar',
      onClick: () => actions.optimizeInput(input),
    });
  },

  async optimizeInput(input) {
    if (input.optimizing != null) return;
    input.optimizing = 0;
    try {
      const file = await window.studio.optimizeMedia(input.originalPath ?? input.path);
      if (!state.inputs.includes(input)) return;
      input.replaceSource(file);
      toast(file.reused ? `«${input.name}» ya estaba optimizado; usando la copia.` : `«${input.name}» optimizado. Ahora se reproduce desde una copia H.264.`);
    } catch (err) {
      toast(`No se pudo optimizar «${input.name}»: ${err.message}`, 'error');
    } finally {
      input.optimizing = null;
    }
  },

  togglePause() {
    outputs.togglePause('record');
    const paused = outputs.isPaused('record');
    for (const key of [...outputs.active.keys()].filter((k) => k.startsWith('iso:'))) {
      if (outputs.isPaused(key) !== paused) outputs.togglePause(key);
    }
  },

  /**
   * ISO recordings: every live source (cameras, screens, network, guests) is
   * also recorded on its own, untouched by switching, for editing later.
   */
  async startIso() {
    const failed = [];
    for (const input of state.inputs) {
      const stream = input.stream ?? input.captureStream?.();
      const video = stream?.getVideoTracks()[0];
      if (!video || !input.hasVideo) continue;
      try {
        await outputs.start(`iso:${input.id}`, {
          kind: 'iso',
          label: input.name,
          tracks: [video, stream.getAudioTracks()[0] ?? audio.outputTrack],
        });
      } catch (err) {
        failed.push(`${input.name}: ${err.message}`);
      }
    }
    const count = [...outputs.active.keys()].filter((k) => k.startsWith('iso:')).length;
    if (count) toast(`Grabando también ${count} ISO (una por fuente).`);
    if (failed.length) toast(`No se pudieron grabar en ISO:\n${failed.join('\n')}`, 'error');
  },

  async stopIso() {
    await Promise.all([...outputs.active.keys()].filter((k) => k.startsWith('iso:')).map((k) => outputs.stop(k)));
  },

  async toggleReplay() {
    try {
      if (outputs.get('replay')) await outputs.stop('replay');
      else await outputs.start('replay');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async saveReplay() {
    try {
      const file = await outputs.saveReplay();
      if (state.settings.replayAsInput) {
        const clip = new VideoFileInput(file);
        clip.name = `Repetición ${state.inputs.filter((i) => i.name.startsWith('Repetición')).length + 1}`;
        clip.loop = false;
        clip.el.pause();
        actions.addInput(clip, { select: false });
        state.previewId = clip.id;
        changed();
        toast(`Repetición de ${Math.round(file.seconds)} s lista en Preview.\nPulsa AUTO o CUT para emitirla.`);
      } else {
        toast(`Repetición guardada en:\n${file.path}`);
      }
    } catch (err) {
      toast(`No se pudo guardar la repetición: ${err.message}`, 'error');
    }
  },

  setView(view) {
    state.view = view;
    $('.stage').dataset.view = view;
    $('#view-studio').classList.toggle('on', view === 'studio');
    $('#view-multiview').classList.toggle('on', view === 'multiview');
    $('#view-vertical').classList.toggle('on', view === 'vertical');
    renderVertical();
  },
};
app.actions = actions;

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

let tbarFlipped = false;

function audioChannelInput(n) {
  return state.inputs.filter((i) => i.channel)[n - 1] ?? null;
}

function handleMidiAction(id, value) {
  const direct = { 'record-pause': actions.togglePause, replay: actions.toggleReplay, 'replay-save': actions.saveReplay }[id];
  if (direct) {
    direct();
    changed();
    return;
  }
  const [name, num] = id.split('-');
  const n = Number(num);
  switch (name) {
    case 'cut':
    case 'auto':
    case 'ftb':
    case 'snapshot':
      actions[name]();
      break;
    case 'stream':
    case 'record':
      actions.toggleOutput(name);
      break;
    case 'tbar': {
      // A physical T-bar stays at the end after a transition, so the next move goes the other way.
      const p = (tbarFlipped ? 1 - value : value) * 100;
      if (compositor.setManual(Math.min(100, p))) tbarFlipped = !tbarFlipped;
      break;
    }
    case 'preview':
      if (state.inputs[n - 1]) actions.setPreview(state.inputs[n - 1].id);
      break;
    case 'program':
      if (state.inputs[n - 1]) actions.cutTo(state.inputs[n - 1].id);
      break;
    case 'overlay':
      actions.overlayButton(n - 1);
      break;
    case 'master':
      audio.volume = Math.round(value * FADER_MAX);
      audio.applyMaster();
      break;
    case 'fader': {
      const ch = audioChannelInput(n)?.channel;
      if (ch) {
        ch.volume = Math.round(value * FADER_MAX);
        ch.apply();
      }
      break;
    }
    case 'mute': {
      const ch = audioChannelInput(n)?.channel;
      if (ch) {
        ch.muted = !ch.muted;
        ch.apply();
      }
      break;
    }
    default:
      return;
  }
  changed();
}

function midiFeedback() {
  const lit = {};
  state.inputs.forEach((input, i) => {
    if (input.id === state.previewId) lit[`preview-${i + 1}`] = 127;
    if (input.id === state.programId) lit[`program-${i + 1}`] = 127;
  });
  state.overlays.forEach((ov, i) => {
    if (ov.inputId != null && ov.target > 0) lit[`overlay-${i + 1}`] = 127;
  });
  state.inputs.filter((i) => i.channel).forEach((input, i) => {
    if (input.channel.muted) lit[`mute-${i + 1}`] = 127;
  });
  if (state.ftb.target > 0) lit.ftb = 127;
  if (outputs.get('stream')) lit.stream = 127;
  if (outputs.get('record')) lit.record = 127;
  if (outputs.isPaused('record')) lit['record-pause'] = 127;
  if (outputs.get('replay')) lit.replay = 127;
  midi.feedback(lit);
}

// ---------------------------------------------------------------------------
// UI refresh
// ---------------------------------------------------------------------------

function refresh() {
  updateCards();
  updateStrips();

  $('#preview-name').textContent = byId(state.previewId)?.name ?? '';
  $('#program-name').textContent = byId(state.programId)?.name ?? '';

  $$('#overlay-buttons button').forEach((btn, i) => {
    const ov = state.overlays[i];
    const active = ov.inputId != null && ov.target > 0;
    btn.classList.toggle('on', active);
    btn.title = active ? `Capa ${i + 1}: ${byId(ov.inputId)?.name ?? ''} (clic para quitar)` : `Capa ${i + 1}: poner encima la entrada de Preview (Ctrl+${i + 1})`;
    btn.disabled = !active && state.previewId == null;
  });
  $('#btn-ftb').classList.toggle('on', state.ftb.target > 0);
  $('#trans-type').value = state.transition.type;
  $('#trans-duration').value = state.transition.duration;
  $('#btn-scene-dock').hidden = !previewScene();
  renderDock();
  renderGuide();
  midiFeedback();
}
onChange(refresh);

// Fast-changing bits: transition progress, T-bar, clip times.
setInterval(() => {
  const t = state.transition;
  const p = t.running ? t.progress : t.manual / 100;
  $('#trans-progress').style.width = `${(p * 100).toFixed(1)}%`;
  const tbar = $('#tbar');
  if (t.running) tbar.value = Math.round(t.progress * 100);
  else if (document.activeElement !== tbar) tbar.value = t.manual;
}, 50);

setInterval(() => {
  updateCardTimes();
  const program = byId(state.programId);
  const remaining = program && 'remaining' in program ? program.remaining : 0;
  const label = $('#program-remaining');
  label.textContent = remaining ? `quedan ${fmtTime(remaining * 1000)}` : '';
  label.style.color = remaining && remaining < 10 ? 'var(--program)' : '';
}, 250);

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const ENCODER_LABELS = {
  auto: 'Automático (GPU si está disponible)',
  x264: 'x264 (CPU)',
  nvenc: 'NVIDIA NVENC (GPU)',
  qsv: 'Intel Quick Sync (GPU)',
  amf: 'AMD AMF (GPU)',
};

function describeOutput(kind) {
  const entry = outputs.get(kind);
  const s = state.settings;
  if (!entry) {
    if (kind === 'record') {
      const folder = s.recordFolder || appInfo.defaultRecordFolder;
      return `Detenido · ${s.recordFormat.toUpperCase()} · ${folder}`;
    }
    const active = s.destinations.filter((d) => d.enabled);
    return active.length ? `Detenido · ${active.map((d) => d.name).join(', ')}` : 'Configura los destinos en Ajustes';
  }
  if (entry.stopping) return 'Deteniendo…';
  if (outputs.isReconnecting(kind)) {
    if (!entry.retryAt) return `Reconectando (intento ${entry.attempt})… · ${fmtTime(outputs.elapsed(entry))}`;
    const secs = Math.max(0, Math.ceil((entry.retryAt - performance.now()) / 1000));
    return `Reconectando en ${secs} s (intento ${entry.attempt}) · ${fmtTime(outputs.elapsed(entry))}`;
  }
  const st = entry.stats;
  if (kind === 'replay') return `Guardando los últimos ${s.replaySeconds} s · pulsa 💾 o R`;
  const parts = [fmtTime(outputs.elapsed(entry))];
  if (outputs.isPaused(kind)) parts.unshift('EN PAUSA');
  if (st?.bitrate) parts.push(st.bitrate);
  if (st?.speed) parts.push(st.speed);
  if (Number(st?.drop) > 0) parts.push(`${st.drop} descartados`);
  if (kind === 'stream' && entry.encoder) parts.push(ENCODER_LABELS[entry.encoder]?.replace(/ \(.*\)/, '') ?? entry.encoder);
  if (kind === 'record' && entry.file) parts.push(entry.file.split(/[\\/]/).pop());
  return parts.join(' · ');
}

/**
 * Top-bar output buttons. Each one shows its state in place (one location for
 * starting and monitoring an output); the long description goes in the tooltip.
 */
function renderOutputs() {
  const stream = outputs.get('stream');
  const streamBtn = $('#btn-stream');
  const reconnecting = outputs.isReconnecting('stream');
  streamBtn.classList.toggle('on', !!stream && !reconnecting);
  streamBtn.classList.toggle('reconnecting', reconnecting);
  streamBtn.classList.toggle('ready', !stream && destinationReady());
  streamBtn.disabled = !!stream?.stopping;
  $('.out-label', streamBtn).textContent = reconnecting ? 'RECONECTANDO' : stream ? 'EN DIRECTO' : 'Emitir';
  $('#stream-info').textContent = stream && !stream.stopping
    ? [fmtTime(outputs.elapsed(stream)), stream.stats?.bitrate?.replace(/kbits\/s/, ' kb/s')].filter(Boolean).join(' · ')
    : '';
  streamBtn.title = `${describeOutput('stream')}${stream ? '\nClic para detener' : '\nClic para preparar la emisión'}`;

  const record = outputs.get('record');
  const paused = outputs.isPaused('record');
  const recordBtn = $('#btn-record');
  recordBtn.classList.toggle('on', !!record && !paused);
  recordBtn.classList.toggle('paused', paused);
  recordBtn.disabled = !!record?.stopping;
  $('.out-label', recordBtn).textContent = record ? (paused ? 'PAUSA' : 'REC') : 'Grabar';
  $('#record-info').textContent = record && !record.stopping ? fmtTime(outputs.elapsed(record)) : '';
  recordBtn.title = `${describeOutput('record')}${record ? '\nClic para detener' : ''}`;
  const pause = $('#btn-record-pause');
  pause.hidden = !record;
  pause.classList.toggle('on', paused);
  pause.textContent = paused ? '▶' : '⏸';

  const replay = outputs.get('replay');
  const replayBtn = $('#btn-replay');
  replayBtn.classList.toggle('on', !!replay);
  replayBtn.disabled = !!replay?.stopping;
  $('#replay-info').textContent = replay ? `${state.settings.replaySeconds} s` : '';
  replayBtn.title = replay ? describeOutput('replay') : 'Búfer de repetición: guarda los últimos segundos con R';
  $('#btn-replay-save').disabled = !replay || replay.stopping;

  renderVerticalOutput?.();
}

const renderVerticalOutput = () => renderVertical();
setInterval(renderOutputs, 500);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let destSeq = Math.max(0, ...state.settings.destinations.map((d) => d.id || 0));

function renderDestinations(list) {
  const box = $('#destinations');
  box.replaceChildren(
    ...(list.length
      ? list.map((d, i) =>
          h(
            'div',
            { class: 'dest-row' },
            h('input', { type: 'checkbox', checked: d.enabled, title: 'Activo', onchange: (e) => (d.enabled = e.target.checked) }),
            h('input', { value: d.name, placeholder: 'Nombre', oninput: (e) => (d.name = e.target.value) }),
            h('input', { value: d.url, placeholder: 'rtmp://servidor/app', oninput: (e) => (d.url = e.target.value.trim()) }),
            h('button', { type: 'button', title: 'Quitar destino', onclick: () => { list.splice(i, 1); renderDestinations(list); } }, '✕'),
            h('span'),
            h('input', { class: 'key', type: 'password', value: d.key, placeholder: 'Clave de emisión', autocomplete: 'off', oninput: (e) => (d.key = e.target.value.trim()) }),
          ),
        )
      : [h('div', { class: 'muted small' }, 'Sin destinos. Añade uno con el menú de abajo.')]),
  );
}

async function openSettings() {
  const dlg = $('#dlg-settings');
  const form = dlg.querySelector('form');
  const s = state.settings;
  const destinations = structuredClone(s.destinations);
  form.resolution.value = `${s.width}x${s.height}`;
  form.fps.value = String(s.fps);
  fillSelect(form.encoder, ['auto', ...encoders].map((e) => [e, ENCODER_LABELS[e] ?? e]), encoders.includes(s.encoder) || s.encoder === 'auto' ? s.encoder : 'auto');
  form.x264Preset.value = s.x264Preset;
  form.recordFolder.value = s.recordFolder || appInfo.defaultRecordFolder;
  form.recordFormat.value = s.recordFormat;
  form.recordMbps.value = s.recordMbps;
  form.streamVideoKbps.value = s.streamVideoKbps;
  form.audioKbps.value = s.audioKbps;
  form.limiter.checked = s.limiter;
  form.replaySeconds.value = s.replaySeconds;
  form.replayAsInput.checked = s.replayAsInput;
  form.isoRecording.checked = !!s.isoRecording;
  const locked = outputs.busyMain;
  form.resolution.disabled = locked;
  form.fps.disabled = locked;
  renderDestinations(destinations);
  const preset = $('#dest-preset');
  preset.value = '';
  preset.onchange = () => {
    if (!preset.value) return;
    const [name, url] = preset.value.split('|');
    destinations.push({ id: ++destSeq, enabled: true, name, url, key: '' });
    renderDestinations(destinations);
    preset.value = '';
  };
  $('#settings-note').textContent = [
    locked ? 'Detén la emisión y la grabación para cambiar la resolución o los fps.' : '',
    `Codificadores disponibles: ${encoders.map((e) => ENCODER_LABELS[e]).join(', ')}.`,
    'Las claves de emisión se guardan en este equipo sin cifrar.',
  ].filter(Boolean).join(' ');
  $('#btn-choose-folder').onclick = async () => {
    const folder = await window.studio.chooseFolder();
    if (folder) form.recordFolder.value = folder;
  };

  if ((await ask(dlg)) !== 'ok') return;
  const [width, height] = form.resolution.value.split('x').map(Number);
  const fps = Number(form.fps.value);
  const videoChanged = width !== s.width || height !== s.height || fps !== s.fps;
  Object.assign(s, {
    width,
    height,
    fps,
    encoder: form.encoder.value,
    x264Preset: form.x264Preset.value,
    recordFolder: form.recordFolder.value === appInfo.defaultRecordFolder ? '' : form.recordFolder.value,
    recordFormat: form.recordFormat.value,
    recordMbps: Number(form.recordMbps.value) || DEFAULT_SETTINGS.recordMbps,
    streamVideoKbps: Number(form.streamVideoKbps.value) || DEFAULT_SETTINGS.streamVideoKbps,
    audioKbps: Number(form.audioKbps.value) || DEFAULT_SETTINGS.audioKbps,
    destinations,
  });
  s.replaySeconds = Math.min(300, Math.max(5, Number(form.replaySeconds.value) || DEFAULT_SETTINGS.replaySeconds));
  s.replayAsInput = form.replayAsInput.checked;
  s.isoRecording = form.isoRecording.checked;
  setLimiter(form.limiter.checked);
  saveSettings();
  if (videoChanged && !outputs.busyMain) compositor.configure(width, height, fps);
  changed();
  renderOutputs();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

let projectPath = null;

async function saveProject(saveAs = false) {
  try {
    const file = await window.studio.saveProject(serializeProject(), saveAs ? null : projectPath);
    if (!file) return;
    projectPath = file;
    document.title = `StudioMix · ${file.split(/[\\/]/).pop()}`;
    toast(`Proyecto guardado:\n${file}`);
  } catch (err) {
    toast(`No se pudo guardar: ${err.message}`, 'error');
  }
}

async function openProject() {
  if (state.inputs.length && !(await confirmAction('Abrir un proyecto sustituye las entradas actuales.', { ok: 'Abrir proyecto' }))) return;
  let result;
  try {
    result = await window.studio.openProject();
  } catch (err) {
    return toast(`No se pudo abrir el proyecto: ${err.message}`, 'error');
  }
  if (!result) return;
  if (outputs.busy) return toast('Detén la emisión y la grabación antes de abrir otro proyecto.', 'error');
  for (const input of [...state.inputs]) actions.removeInput(input);
  const skipped = await loadProject(result.data, result.media, actions.addInput);
  const stingerPath = result.data.transition?.stinger?.path;
  compositor.stinger.load(stingerPath ? result.media[stingerPath] ?? null : null);
  state.transition.stinger.path = compositor.stinger.path;
  projectPath = result.file;
  document.title = `StudioMix · ${result.file.split(/[\\/]/).pop()}`;
  changed();
  if (skipped.length) toast(`No se pudieron restaurar: ${skipped.join(', ')}.\nLas capturas de pantalla hay que añadirlas de nuevo.`, 'error');
  else toast('Proyecto abierto.');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function initTransitionPanel() {
  fillSelect($('#trans-type'), Object.entries(TRANSITIONS), state.transition.type);
  $('#trans-type').addEventListener('change', (e) => {
    state.transition.type = e.target.value;
    state.settings.transitionType = e.target.value;
    saveSettings();
  });
  const duration = $('#trans-duration');
  duration.addEventListener('change', () => {
    const value = Math.min(5000, Math.max(100, Number(duration.value) || 1000));
    state.transition.duration = value;
    state.settings.transitionDuration = value;
    saveSettings();
    changed();
  });

  $('#btn-cut').addEventListener('click', actions.cut);
  $('#btn-auto').addEventListener('click', actions.auto);
  $('#btn-ftb').addEventListener('click', actions.ftb);

  const tbar = $('#tbar');
  tbar.addEventListener('input', () => {
    if (compositor.setManual(Number(tbar.value))) tbar.value = 0;
  });

  $('#overlay-buttons').replaceChildren(...state.overlays.map((_, i) => h('button', { type: 'button', onclick: () => actions.overlayButton(i) }, `Capa ${i + 1}`)));
}

async function openTransitionOptions() {
  const dlg = $('#dlg-transition');
  const form = dlg.querySelector('form');
  const { luma, stinger } = state.transition;
  fillSelect(form.pattern, Object.entries(LUMA_PATTERNS), luma.pattern);
  form.softness.value = luma.softness;
  form.invert.checked = luma.invert;
  form.cutPoint.value = stinger.cutPoint;
  const showStinger = () => {
    $('#stinger-name').textContent = compositor.stinger.path ? compositor.stinger.path.split(/[\\/]/).pop() : 'Sin clip';
  };
  showStinger();
  form.oninput = () => {
    luma.pattern = form.pattern.value;
    luma.softness = Number(form.softness.value);
    luma.invert = form.invert.checked;
    stinger.cutPoint = Math.max(0, Number(form.cutPoint.value) || 0);
    saveSettings();
  };
  form.onchange = form.oninput;
  $('#btn-stinger-file').onclick = async () => {
    const [file] = await window.studio.openMedia('video');
    if (!file) return;
    compositor.stinger.load(file);
    stinger.path = file.path;
    showStinger();
  };
  $('#btn-stinger-clear').onclick = () => {
    compositor.stinger.load(null);
    stinger.path = '';
    showStinger();
  };
  await ask(dlg);
  form.oninput = null;
  form.onchange = null;
  saveSettings();
}

function initAddMenu() {
  const menu = $('#add-menu');
  $('#btn-add').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
  });
  $$('[data-add]', menu).forEach((btn) =>
    btn.addEventListener('click', async () => {
      menu.hidden = true;
      try {
        await adders[btn.dataset.add]();
      } catch (err) {
        console.error(err);
        toast(`No se pudo añadir la entrada: ${err.message}`, 'error');
      }
    }),
  );
}

function initMultiview() {
  const canvas = $('#multiview-canvas');
  const toCanvas = (e) => {
    // The canvas is letterboxed with object-fit: contain.
    const r = canvas.getBoundingClientRect();
    const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
    const ox = (r.width - canvas.width * scale) / 2;
    const oy = (r.height - canvas.height * scale) / 2;
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale];
  };
  canvas.addEventListener('click', (e) => {
    const cell = compositor.cellAt(...toCanvas(e));
    if (cell) actions.setPreview(cell.id);
  });
  canvas.addEventListener('dblclick', (e) => {
    const cell = compositor.cellAt(...toCanvas(e));
    if (cell) actions.quickPlay(cell.id);
  });
  $('#view-studio').addEventListener('click', () => actions.setView('studio'));
  $('#view-multiview').addEventListener('click', () => actions.setView('multiview'));
  $('#view-vertical').addEventListener('click', () => actions.setView('vertical'));
}

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Side panels don't block shortcuts (you can keep switching while editing); modal dialogs do.
    if (document.querySelector('dialog:modal') || isTyping(e.target)) return;
    if (e.key === 'Escape' && !previewScene() && panelOpen()) {
      closePanels();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Escape'].includes(e.key) && handleSceneKey(e)) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (e.ctrlKey && e.code === 'KeyS') {
      e.preventDefault();
      saveProject(e.shiftKey);
      return;
    }
    if (e.ctrlKey && e.code === 'KeyO') {
      e.preventDefault();
      openProject();
      return;
    }
    if (e.ctrlKey && digit && Number(digit) <= state.overlays.length) {
      e.preventDefault();
      actions.overlayButton(Number(digit) - 1);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (digit) {
      const input = state.inputs[Number(digit) - 1];
      if (input) (e.shiftKey ? actions.cutTo : actions.setPreview)(input.id);
      return;
    }
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        actions.cut();
        break;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        actions.auto();
        break;
      case 'KeyB':
        actions.ftb();
        break;
      case 'KeyV':
        actions.setView(state.view === 'studio' ? 'multiview' : 'studio');
        break;
      case 'KeyR':
        actions.saveReplay();
        break;
      case 'KeyS':
        actions.snapshot();
        break;
      default:
    }
  });
}

initTransitionPanel();
initAddMenu();
initMultiview();
initKeyboard();
buildMasterStrip();
initStats();
startMeters();

initPanels();
initSceneEditor();
initGoLive();
initRemote();
initChat();
initGuests();
initVertical();
initGuide();
$('#btn-trans-options').addEventListener('click', openTransitionOptions);
$('#btn-record-pause').addEventListener('click', actions.togglePause);
$('#btn-replay').addEventListener('click', actions.toggleReplay);
$('#btn-replay-save').addEventListener('click', actions.saveReplay);
$('#btn-settings').addEventListener('click', openSettings);
// Less frequent actions grouped in one menu (fewer choices in the bar, Hick's law).
$('#btn-menu').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 240, r.bottom + 4, [
    ['Abrir proyecto…', openProject, { hint: 'Ctrl+O' }],
    ['Guardar proyecto', () => saveProject(false), { hint: 'Ctrl+S' }],
    ['Guardar como…', () => saveProject(true), { hint: 'Ctrl+Mayús+S' }],
    null,
    ['Captura de Program', actions.snapshot, { hint: 'S' }],
    ['Abrir carpeta de grabaciones', () => window.studio.openFolder(state.settings.recordFolder || null)],
    null,
    ['Controlador MIDI…', openMidiDialog],
    ['Mando remoto y Stream Deck…', () => actions.openRemote?.()],
    ['Invitados remotos…', () => actions.openGuests?.()],
    ['Atajos de teclado', () => ask($('#dlg-help'))],
  ]);
});
// The button opens the go-live sheet (destinations + pre-flight); while live it stops.
$('#btn-stream').addEventListener('click', () => (outputs.get('stream') ? actions.toggleOutput('stream') : openGoLive()));
$('#btn-record').addEventListener('click', () => actions.toggleOutput('record'));
document.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('beforeunload', () => {
  outputs.stopAll();
});

window.studio.info().then((info) => {
  appInfo = info;
  renderOutputs();
});
window.studio.encoders().then((list) => {
  encoders = list;
});
midi.init();
window.studio.onOptimizeProgress(({ file, progress }) => {
  for (const input of state.inputs) {
    if (input.optimizing != null && (input.originalPath ?? input.path) === file) input.optimizing = progress;
  }
});

changed();
renderOutputs();

// --- Updates ----------------------------------------------------------------------
window.studio.onUpdateReady(({ version }) => {
  toast(`StudioMix ${version} está descargado y se instalará al cerrar la aplicación.`, 'info', {
    label: 'Reiniciar ahora',
    dismissLabel: 'Al cerrar',
    onClick: async () => {
      const result = await window.studio.installUpdate();
      if (!result.ok) toast(result.error, 'error');
    },
  });
});

// --- Autosave and crash recovery ------------------------------------------------
// Saves the show every few seconds after a change; if the previous session
// didn't close cleanly, offers to bring its montage back.
let dirty = false;
onChange(() => {
  dirty = true;
});
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  window.studio.autosave(serializeProject()).catch(() => {
    dirty = true;
  });
}, 5000);

window.studio.checkRecovery().then((info) => {
  if (!info) return;
  const when = new Date(info.savedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  toast(`StudioMix no se cerró bien la última vez.\n¿Recuperar el montaje guardado a las ${when}?`, 'info', {
    label: 'Recuperar',
    dismissLabel: 'Empezar de cero',
    onClick: async () => {
      try {
        const result = await window.studio.loadRecovery();
        for (const input of [...state.inputs]) actions.removeInput(input);
        const skipped = await loadProject(result.data, result.media, actions.addInput);
        const stingerPath = result.data.transition?.stinger?.path;
        compositor.stinger.load(stingerPath ? result.media[stingerPath] ?? null : null);
        changed();
        toast(skipped.length ? `Montaje recuperado. No se pudieron restaurar: ${skipped.join(', ')}.` : 'Montaje recuperado.');
      } catch (err) {
        toast(`No se pudo recuperar: ${err.message}`, 'error');
      }
    },
  }, { timeout: 60000, onExpire: () => window.studio.discardRecovery() });
});

// Exposed for debugging from DevTools.
window.studioMix = { state, compositor, audio, outputs, midi, actions, changed };
