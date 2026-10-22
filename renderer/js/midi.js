// MIDI controller support: map any note or CC to an action with "learn",
// drive faders/T-bar from CCs, and light controller LEDs as tally feedback.

const STORAGE_KEY = 'studiomix.midi';
/** Mixer channels and inputs MIDI can address by position. */
export const CHANNEL_SLOTS = 8;
export const INPUT_SLOTS = 16;

/** Any button of the interface, by element id: "press this button". */
export const CLICK_PREFIX = 'click:';

function buildActions() {
  const actions = [
    { id: 'cut', label: 'Cut', kind: 'button', group: 'Conmutación' },
    { id: 'auto', label: 'Auto (transición)', kind: 'button', group: 'Conmutación' },
    { id: 'tbar', label: 'T-bar', kind: 'fader', group: 'Conmutación' },
    { id: 'ftb', label: 'Negro (fundido de salida)', kind: 'button', group: 'Conmutación' },
  ];
  for (let i = 1; i <= INPUT_SLOTS; i++) actions.push({ id: `preview-${i}`, label: `Entrada ${i} a Preview`, kind: 'button', group: 'Preview' });
  for (let i = 1; i <= INPUT_SLOTS; i++) actions.push({ id: `program-${i}`, label: `Entrada ${i} a Program (cut)`, kind: 'button', group: 'Program' });
  for (let i = 1; i <= 4; i++) actions.push({ id: `overlay-${i}`, label: `Capa ${i}`, kind: 'button', group: 'Capas (overlays)' });
  actions.push({ id: 'master', label: 'Volumen master', kind: 'fader', group: 'Audio' });
  actions.push({ id: 'master-mute', label: 'Silenciar master', kind: 'button', group: 'Audio' });
  actions.push({ id: 'monitor', label: 'Escucha por auriculares/altavoces', kind: 'button', group: 'Audio' });
  for (let i = 1; i <= CHANNEL_SLOTS; i++) actions.push({ id: `fader-${i}`, label: `Volumen canal ${i}`, kind: 'fader', group: 'Audio' });
  for (let i = 1; i <= CHANNEL_SLOTS; i++) actions.push({ id: `mute-${i}`, label: `Silenciar canal ${i}`, kind: 'button', group: 'Audio' });
  actions.push(
    { id: 'stream', label: 'Emitir / parar', kind: 'button', group: 'Salidas' },
    { id: 'record', label: 'Grabar / parar', kind: 'button', group: 'Salidas' },
    { id: 'record-pause', label: 'Pausar grabación', kind: 'button', group: 'Salidas' },
    { id: 'replay', label: 'Búfer de repetición on/off', kind: 'button', group: 'Salidas' },
    { id: 'replay-save', label: 'Guardar repetición', kind: 'button', group: 'Salidas' },
    { id: 'snapshot', label: 'Captura de Program', kind: 'button', group: 'Salidas' },
    { id: 'vstream', label: 'Emitir vertical / parar', kind: 'button', group: 'Salidas' },
    { id: 'vrecord', label: 'Grabar vertical / parar', kind: 'button', group: 'Salidas' },
    { id: 'view-studio', label: 'Vista Estudio', kind: 'button', group: 'Vistas' },
    { id: 'view-multiview', label: 'Vista Multiview', kind: 'button', group: 'Vistas' },
    { id: 'view-vertical', label: 'Vista Vertical', kind: 'button', group: 'Vistas' },
  );
  return actions;
}

export const MIDI_ACTIONS = buildActions();
const ACTIONS_BY_ID = new Map(MIDI_ACTIONS.map((a) => [a.id, a]));

/**
 * The action for an id: a listed one, or "press button X" for any interface
 * button (label kept with the binding, since the list doesn't know it).
 */
export function getAction(id, bindings = {}) {
  const listed = ACTIONS_BY_ID.get(id);
  if (listed) return listed;
  if (String(id).startsWith(CLICK_PREFIX)) return { id, kind: 'button', group: 'Otros botones', label: bindings[id]?.label || `Botón ${id.slice(CLICK_PREFIX.length)}` };
  return null;
}

export function describeBinding(b) {
  if (!b) return '—';
  return `${b.type === 'cc' ? 'CC' : 'Nota'} ${b.number} · canal ${b.channel + 1}`;
}

export class MidiController {
  /**
   * @param {{ onAction: (id: string, value: number) => void,
   *           onChange: () => void }} handlers
   *   onAction value: 1 for buttons, 0–1 for faders.
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.access = null;
    this.supported = 'requestMIDIAccess' in navigator;
    this.error = null;
    this.learning = null;
    this.lastMessage = null;
    this.ccState = new Map();
    this.ledState = new Map();
    this.bindings = this.load();
  }

  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (err) {
      console.warn('Asignaciones MIDI dañadas; se empieza sin ellas:', err);
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch {
      // Mappings simply won't persist.
    }
  }

  async init() {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.error = err.message;
      this.handlers.onChange();
      return false;
    }
    this.attachInputs();
    this.access.onstatechange = () => {
      this.attachInputs();
      this.ledState.clear();
      this.handlers.onChange();
    };
    this.handlers.onChange();
    return true;
  }

  attachInputs() {
    for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this.handle(e.data, input.name);
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()].map((i) => i.name) : [];
  }

  get outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  /** Waits for the next control moved or pressed; `label` names buttons outside the list. */
  learn(actionId, label = null) {
    this.learning = actionId;
    this.learningLabel = label;
    this.handlers.onChange();
  }

  cancelLearn() {
    this.learning = null;
    this.learningLabel = null;
    this.learnRejected = null;
    this.handlers.onChange();
  }

  clear(actionId) {
    delete this.bindings[actionId];
    this.save();
    this.handlers.onChange();
  }

  clearAll() {
    this.bindings = {};
    this.save();
    this.handlers.onChange();
  }

  handle(data, deviceName) {
    const [status, number, value = 0] = data;
    const type = status & 0xf0;
    const channel = status & 0x0f;
    let kind;
    if (type === 0x90 && value > 0) kind = 'note';
    else if (type === 0xb0) kind = 'cc';
    else return; // note-off, clock, aftertouch…

    this.lastMessage = { kind, channel, number, value, device: deviceName };

    if (this.learning) {
      const id = this.learning;
      const action = getAction(id, this.bindings);
      // Faders need a CC; buttons accept notes or CCs.
      if (!action || (action.kind === 'fader' && kind !== 'cc')) {
        this.learnRejected = kind;
        this.handlers.onChange();
        return;
      }
      // One control does one thing: it leaves whatever it did before.
      const replaced = [];
      for (const [other, b] of Object.entries(this.bindings)) {
        if (b.type === kind && b.channel === channel && b.number === number) {
          replaced.push(other);
          delete this.bindings[other];
        }
      }
      const previousLabel = this.bindings[id]?.label;
      const binding = { type: kind, channel, number };
      if (id.startsWith(CLICK_PREFIX)) binding.label = this.learningLabel ?? previousLabel;
      this.bindings[id] = binding;
      this.learning = null;
      this.learningLabel = null;
      this.learnRejected = null;
      this.save();
      this.ledState.clear();
      this.handlers.onLearned?.(id, binding, replaced.filter((r) => r !== id));
      this.handlers.onChange();
      return;
    }

    for (const [id, b] of Object.entries(this.bindings)) {
      if (b.type !== kind || b.channel !== channel || b.number !== number) continue;
      const action = getAction(id, this.bindings);
      if (!action) continue;
      if (action.kind === 'fader') {
        this.handlers.onAction(id, value / 127);
      } else if (kind === 'note') {
        this.handlers.onAction(id, 1);
      } else {
        // CC buttons fire on the rising edge only.
        const key = `${channel}:${number}`;
        const previous = this.ccState.get(key) ?? 0;
        this.ccState.set(key, value);
        if (value >= 64 && previous < 64) this.handlers.onAction(id, 1);
      }
    }
    this.handlers.onChange();
  }

  /**
   * Lights LEDs on note-mapped buttons: `lit` maps actionId → velocity
   * (0 = off). Only changes are sent.
   */
  feedback(lit) {
    const outputs = this.outputs;
    if (!outputs.length) return;
    for (const [id, b] of Object.entries(this.bindings)) {
      if (b.type !== 'note') continue;
      const velocity = lit[id] ?? 0;
      if (this.ledState.get(id) === velocity) continue;
      this.ledState.set(id, velocity);
      for (const out of outputs) {
        try {
          out.send([0x90 | b.channel, b.number, velocity]);
        } catch {
          // Output went away mid-send.
        }
      }
    }
  }
}
