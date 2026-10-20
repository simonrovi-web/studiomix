// Actions shared by buttons, keyboard, MIDI and the remote API. Services come
// from the `app` registry, filled in by app.js before any action runs.

import { app, byId, changed, saveSettings, state } from './store.js';
import { confirmAction, toast } from './ui-common.js';
import { buildCard, removeCard } from './ui-inputs.js';
import { dropStrip, editAudioFx } from './ui-mixer.js';
import { destinationReady } from './ui-guide.js';
import { openGoLive } from './ui-golive.js';
import { openSettings } from './ui-outputs.js';
import { render as renderVertical } from './ui-vertical.js';
import { SceneInput } from './scenes.js';
import { VideoFileInput } from './inputs.js';
import { $ } from './util.js';

const isoKeys = () => [...app.outputs.active.keys()].filter((k) => k.startsWith('iso:'));

export const actions = {
  addInput(input, { select = true } = {}) {
    app.audio.resume();
    state.inputs.push(input);
    try {
      app.audio.attach(input);
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
      input.channel.gain.gain.setTargetAtTime(0, app.audio.ctx.currentTime, 0.01);
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
      if (was && state.overlays[i].inputId == null) app.compositor.toggleOverlay(i, input.id);
    });
    for (const { scene, item, i } of snapshot.sceneItems) {
      if (state.inputs.includes(scene)) scene.items.splice(Math.min(i, scene.items.length), 0, item);
    }
    input.channel?.apply();
    changed();
  },

  /** Removes every input (opening a project or a recovery replaces the montage). */
  clearInputs() {
    for (const input of [...state.inputs]) actions.removeInput(input);
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
    app.compositor.cut();
  },

  quickPlay(id) {
    if (id === state.programId || !byId(id)) return;
    state.previewId = id;
    app.compositor.auto();
    changed();
  },

  toggleOverlay(index, id) {
    if (id == null) return;
    app.compositor.toggleOverlay(index, id);
    changed();
  },

  /** Overlay button without an input: remove what's there, or put Preview on it. */
  overlayButton(index) {
    const ov = state.overlays[index];
    actions.toggleOverlay(index, ov.inputId != null && ov.target > 0 ? ov.inputId : state.previewId);
  },

  cut: () => app.compositor.cut(),
  auto: () => app.compositor.auto(),

  ftb() {
    app.compositor.toggleFtb();
    changed();
  },

  async snapshot() {
    try {
      const file = await app.outputs.snapshot(app.compositor.program);
      toast(`Captura guardada en:\n${file}`);
    } catch (err) {
      toast(`No se pudo guardar la captura: ${err.message}`, 'error');
    }
  },

  async toggleOutput(kind) {
    const { outputs } = app;
    app.audio.resume();
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
    app.audio.resume();
    try {
      await app.outputs.start('stream');
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
    } catch (err) {
      console.warn('No se pudo analizar', input.name, err);
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
    const { outputs } = app;
    outputs.togglePause('record');
    const paused = outputs.isPaused('record');
    for (const key of isoKeys()) {
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
        await app.outputs.start(`iso:${input.id}`, {
          kind: 'iso',
          label: input.name,
          tracks: [video, stream.getAudioTracks()[0] ?? app.audio.outputTrack],
        });
      } catch (err) {
        failed.push(`${input.name}: ${err.message}`);
      }
    }
    const count = isoKeys().length;
    if (count) toast(`Grabando también ${count} ISO (una por fuente).`);
    if (failed.length) toast(`No se pudieron grabar en ISO:\n${failed.join('\n')}`, 'error');
  },

  async stopIso() {
    await Promise.all(isoKeys().map((k) => app.outputs.stop(k)));
  },

  async toggleReplay() {
    try {
      if (app.outputs.get('replay')) await app.outputs.stop('replay');
      else await app.outputs.start('replay');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async saveReplay() {
    try {
      const file = await app.outputs.saveReplay();
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
