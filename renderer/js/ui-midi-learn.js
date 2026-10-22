// MIDI from anywhere: right-click a control → "Asignar control MIDI…", then
// move or press something on the controller. Controls carry their function in
// data-midi (CUT, faders, layers…); other buttons with an id are assigned as
// "press this button". Assigned controls are marked so they are easy to spot.

import { CLICK_PREFIX, describeBinding, getAction } from './midi.js';
import { app, onChange } from './store.js';
import { showMenu, toast } from './ui-common.js';
import { openMidiDialog } from './ui-midi.js';
import { h } from './util.js';

const LEARN_TIMEOUT_MS = 20000;
let hint = null;
let learnTimer = 0;
let learningEl = null;

/** The MIDI function a right-clicked element stands for, or null. */
export function midiTargetFor(target) {
  const el = target?.closest?.('[data-midi], button[id]');
  // Menus vanish on use, and fields keep their own menu (copy, paste…).
  if (!el || el.closest('.context-menu, dialog:modal')) return null;
  if (el.dataset.midi) {
    const action = getAction(el.dataset.midi);
    return action ? { el, id: action.id, label: action.label, kind: action.kind } : null;
  }
  const label = (el.title || el.textContent || el.id).split('\n')[0].trim().slice(0, 60);
  return { el, id: `${CLICK_PREFIX}${el.id}`, label: `Botón «${label}»`, kind: 'button' };
}

function stopLearning() {
  clearTimeout(learnTimer);
  hint?.remove();
  hint = null;
  learningEl?.classList.remove('midi-learning');
  learningEl = null;
}

/** Starts learning for one function and shows what to do. */
export function learnMidi(id, label, kind, el = null) {
  const midi = app.midi;
  stopLearning();
  midi.learn(id, label);
  learningEl = el;
  el?.classList.add('midi-learning');
  const noDevice = !midi.inputs.length;
  hint = h('div', { class: 'midi-learn-hint', role: 'status' },
    h('span', { class: 'midi-learn-dot' }),
    h('div', {},
      h('strong', {}, `Asignar «${label}»`),
      h('span', {}, noDevice
        ? 'No hay ningún controlador MIDI conectado. Conéctalo por USB y mueve un control.'
        : kind === 'fader' ? 'Mueve un fader o una perilla del controlador…' : 'Pulsa un botón o un pad del controlador…'),
    ),
    h('button', { type: 'button', onclick: () => cancel() }, 'Cancelar'),
  );
  document.body.append(hint);
  learnTimer = setTimeout(() => {
    cancel();
    toast('No llegó ningún mensaje MIDI. Comprueba que el controlador está conectado.', 'error');
  }, LEARN_TIMEOUT_MS);
}

function cancel() {
  app.midi.cancelLearn();
  stopLearning();
}

/** Called by the controller when a control was assigned. */
export function onMidiLearned(id, binding, replaced) {
  stopLearning();
  const action = getAction(id, app.midi.bindings);
  const lost = replaced.map((r) => getAction(r, app.midi.bindings)?.label ?? r);
  toast(`«${action?.label ?? id}» → ${describeBinding(binding)}${lost.length ? `\n(ese control ya no hace: ${lost.join(', ')})` : ''}`);
  markBound();
}

let boundSignature = '';

/** After any MIDI change: re-mark assigned controls if assignments changed; keep the hint honest. */
export function onMidiChange() {
  const signature = JSON.stringify(app.midi?.bindings ?? {});
  if (signature !== boundSignature) {
    boundSignature = signature;
    markBound();
  }
  if (!hint) return;
  const midi = app.midi;
  if (!midi.learning) return stopLearning();
  if (midi.learnRejected) {
    const line = hint.querySelector('div span');
    if (line) line.textContent = 'Eso es un botón: esta función necesita un fader o una perilla (mensajes CC).';
  }
  return undefined;
}

/** Marks every control that has a MIDI assignment. */
export function markBound() {
  const bindings = app.midi?.bindings ?? {};
  for (const el of document.querySelectorAll('[data-midi], .midi-bound')) {
    const id = el.dataset.midi ?? (el.id ? `${CLICK_PREFIX}${el.id}` : null);
    const binding = id ? bindings[id] : null;
    el.classList.toggle('midi-bound', !!binding);
    if (binding) el.dataset.midiBinding = describeBinding(binding);
    else delete el.dataset.midiBinding;
  }
  for (const id of Object.keys(bindings)) {
    if (!id.startsWith(CLICK_PREFIX)) continue;
    const el = document.getElementById(id.slice(CLICK_PREFIX.length));
    if (!el) continue;
    el.classList.add('midi-bound');
    el.dataset.midiBinding = describeBinding(bindings[id]);
  }
}

/** Menu entries to assign or clear MIDI for one function. */
export function midiMenuItems(id, label, kind, el = null) {
  const binding = app.midi.bindings[id];
  const items = [{ header: `MIDI · ${label}` }];
  if (binding) items.push([`Asignado a ${describeBinding(binding)}`, () => {}, { icon: '🎹', disabled: true }]);
  items.push([binding ? 'Cambiar control MIDI…' : 'Asignar control MIDI…', () => learnMidi(id, label, kind, el), { icon: '🎹' }]);
  if (binding) {
    items.push(['Quitar asignación', () => {
      app.midi.clear(id);
      markBound();
    }, { icon: '✕', danger: true }]);
  }
  items.push(['Ver todas las asignaciones…', openMidiDialog, { icon: '☰' }]);
  return items;
}

export function initMidiLearn() {
  // Capture phase: runs before a card's own menu, and only claims MIDI controls.
  document.addEventListener('contextmenu', (e) => {
    const target = midiTargetFor(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, midiMenuItems(target.id, target.label, target.kind, target.el));
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hint) cancel();
  });
  // Mixer strips and cards are rebuilt as inputs come and go.
  onChange(markBound);
  markBound();
}
