import { CLICK_PREFIX, MIDI_ACTIONS, describeBinding, getAction } from './midi.js';
import { MIDI_PROFILES } from './midi-profiles.js';
import { startMidiWizard } from './ui-midi-learn.js';
import { app } from './store.js';
import { ask, confirmAction } from './ui-common.js';
import { $, h } from './util.js';

let open = false;

export function renderMidiChip() {
  const midi = app.midi;
  const chip = $('#chip-midi');
  const count = midi.inputs.length;
  chip.textContent = count ? `MIDI ${count}` : 'MIDI —';
  chip.className = `chip ${count ? 'good' : ''}`;
  chip.title = count ? `Controladores: ${midi.inputs.join(', ')}` : 'No hay controladores MIDI conectados';
}

export function renderMidiDialog() {
  renderMidiChip();
  if (!open) return;
  const midi = app.midi;
  let status;
  if (!midi.supported) status = 'Este sistema no admite MIDI.';
  else if (midi.error) status = `No se pudo acceder a MIDI: ${midi.error}`;
  else if (!midi.inputs.length) status = 'No hay controladores conectados. Conecta uno por USB; aparecerá aquí automáticamente.';
  else status = `Conectado: ${midi.inputs.join(', ')}`;
  $('#midi-status').textContent = status;

  const m = midi.lastMessage;
  $('#midi-monitor').textContent = m
    ? `Último mensaje: ${m.kind === 'cc' ? 'CC' : 'Nota'} ${m.number} · valor ${m.value} · canal ${m.channel + 1} · ${m.device}`
    : 'Último mensaje: —';

  const box = $('#midi-actions');
  const rows = [];
  let group = null;
  // Interface buttons assigned with right-click are listed after the fixed functions.
  const extra = Object.keys(midi.bindings).filter((id) => id.startsWith(CLICK_PREFIX)).map((id) => getAction(id, midi.bindings));
  for (const action of [...MIDI_ACTIONS, ...extra]) {
    if (action.group !== group) {
      group = action.group;
      rows.push(h('h4', {}, group));
    }
    const binding = midi.bindings[action.id];
    const learning = midi.learning === action.id;
    rows.push(
      h(
        'div',
        { class: 'midi-row' },
        h('span', {}, action.label, action.kind === 'fader' ? h('span', { class: 'muted' }, ' (fader)') : null),
        h('span', { class: `binding ${binding ? 'set' : ''}` }, learning ? 'Mueve un control…' : describeBinding(binding)),
        h('button', { type: 'button', class: learning ? 'learning' : '', onclick: () => (learning ? midi.cancelLearn() : midi.learn(action.id)) }, learning ? 'Cancelar' : 'Aprender'),
        h('button', { type: 'button', title: 'Quitar asignación', disabled: !binding, onclick: () => midi.clear(action.id) }, '✕'),
      ),
    );
  }
  const scroll = box.scrollTop;
  box.replaceChildren(...rows);
  box.scrollTop = scroll;
}

export async function openMidiDialog() {
  const dlg = $('#dlg-midi');
  open = true;
  $('#btn-midi-clear').onclick = async () => {
    if (await confirmAction('¿Borrar todas las asignaciones MIDI?', { ok: 'Borrar todas', danger: true })) app.midi.clearAll();
  };
  // Guided setup runs with the dialog closed, so the marked controls stay visible.
  $('#midi-profiles').replaceChildren(
    h('span', { class: 'muted small' }, 'Configuración guiada:'),
    ...MIDI_PROFILES.map((p) => h('button', { type: 'submit', value: `wizard:${p.id}` }, `🎹 ${p.name}…`)),
  );
  renderMidiDialog();
  const result = await ask(dlg);
  open = false;
  app.midi.cancelLearn();
  const profile = MIDI_PROFILES.find((p) => result === `wizard:${p.id}`);
  if (profile) startMidiWizard(profile);
}
