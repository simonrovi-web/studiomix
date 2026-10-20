// Output windows on other monitors or projectors. Each display can show
// Program, Preview or Multiview full screen; floating windows are for setups
// with a single monitor. Display assignments are remembered and come back when
// the display is connected again.

import { app, saveSettings, state } from './store.js';

const WINDOWED = 'window';
const SOURCES = ['program', 'preview', 'multiview'];

export const SOURCE_LABELS = { program: 'Program', preview: 'Preview', multiview: 'Multiview' };

export class ScreenOutputs {
  constructor() {
    this.windows = new Map(); // key -> { win, source, display }
    this.displays = [];
    this.windowSeq = 0;
    this.onChange = null;
    // Output pages pull their video from here (see output.js).
    window.studioMixScreens = this;
    setInterval(() => this.reap(), 1000);
  }

  get assignments() {
    state.settings.screenOutputs ??= {};
    return state.settings.screenOutputs;
  }

  streamFor(source) {
    return SOURCES.includes(source) ? new MediaStream([app.compositor.monitorTrack(source)]) : null;
  }

  /** What a display shows, or null. */
  sourceOn(displayId) {
    return [...this.windows.values()].find((w) => w.display === displayId)?.source ?? null;
  }

  get floating() {
    return [...this.windows.entries()].filter(([, w]) => w.display === WINDOWED);
  }

  /** Shows `source` full screen on a display (null turns the display off). */
  assign(displayId, source) {
    this.closeDisplay(displayId);
    if (source) {
      this.assignments[displayId] = source;
      this.open(source, displayId);
    } else {
      delete this.assignments[displayId];
    }
    saveSettings();
    this.onChange?.();
  }

  openFloating(source) {
    this.open(source, WINDOWED, `${WINDOWED}-${++this.windowSeq}`);
    this.onChange?.();
  }

  close(key) {
    const entry = this.windows.get(key);
    if (!entry) return;
    if (!entry.win.closed) entry.win.close();
    this.forget(key);
    this.onChange?.();
  }

  closeDisplay(displayId) {
    if (this.windows.has(displayId)) this.close(displayId);
  }

  open(source, display, key = display) {
    const url = `output.html?source=${encodeURIComponent(source)}&display=${encodeURIComponent(display)}`;
    const win = window.open(url, `studiomix-output-${key}`, 'popup');
    if (!win) throw new Error('No se pudo abrir la ventana de salida');
    app.compositor.watch(source, 1);
    this.windows.set(key, { win, source, display });
  }

  forget(key) {
    const entry = this.windows.get(key);
    if (!entry) return;
    this.windows.delete(key);
    app.compositor.watch(entry.source, -1);
  }

  /** Notices windows closed from their side (Esc, double click, display unplugged). */
  async reap() {
    const closed = [...this.windows.entries()].filter(([, w]) => w.win.closed);
    if (!closed.length) return;
    this.displays = await window.studio.listDisplays();
    for (const [key, entry] of closed) {
      this.forget(key);
      // Closed by the operator: forget the assignment. Display unplugged: keep it
      // so the output returns when the projector is back.
      const stillThere = this.displays.some((d) => d.id === entry.display);
      if (entry.display !== WINDOWED && stillThere) delete this.assignments[entry.display];
    }
    saveSettings();
    this.onChange?.();
  }

  /** Opens remembered outputs whose display is connected. */
  reconcile(displays) {
    this.displays = displays;
    for (const [displayId, source] of Object.entries(this.assignments)) {
      if (!SOURCES.includes(source)) continue;
      if (displays.some((d) => d.id === displayId) && !this.windows.has(displayId)) {
        try {
          this.open(source, displayId);
        } catch (err) {
          console.warn('No se pudo reabrir la salida', displayId, err);
        }
      }
    }
    this.onChange?.();
  }
}
