// What MIDI controls do, and which of their lights are on.

import { FADER_MAX } from './audio.js';
import { app, changed, state } from './store.js';

const audioChannelInput = (n) => state.inputs.filter((i) => i.channel)[n - 1] ?? null;

export function handleMidiAction(id, value) {
  const { actions, audio, compositor } = app;
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
    case 'tbar':
      // Physical position; the compositor works out direction and completion.
      // A completed transition refreshes the UI itself (onCommit), so a fader
      // sending dozens of messages a second doesn't redraw everything each time.
      compositor.setBar(value * 100, 'midi');
      return;
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

/** Lights the controller's buttons to match the current state. */
export function midiFeedback() {
  const { outputs, midi } = app;
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
