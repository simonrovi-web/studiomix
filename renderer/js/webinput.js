// Web page input: an HTML graphic with a transparent background (OBS-style
// browser source). The main process renders the page offscreen and sends the
// rectangles that change as premultiplied BGRA; they are painted here onto a
// canvas that is drawn like any other source.
import { Input } from './inputs.js';
import { BgraPainter } from './bgra-painter.js';
import { bgraToRgba, packRows } from './pixels.js';
import { drawPlaceholder } from './util.js';

const registry = new Map();
let listening = false;

// A page nobody is watching (not in Program, Preview, a layer or a visible
// scene) only needs to keep its thumbnail alive: it is rendered and sent at
// this rate instead of its own, which saves both processes most of the work.
const IDLE_FPS = 2;
const SHOWN_WINDOW_MS = 1000;

function listen() {
  if (listening) return;
  listening = true;
  window.studio.onWebInput(
    (id, rect, pixels) => registry.get(id)?.paint(rect, pixels),
    (status) => registry.get(status.id)?.onStatus(status),
  );
  setInterval(() => {
    const now = performance.now();
    for (const input of registry.values()) input.updateRate(now);
  }, 500);
}

export class WebInput extends Input {
  constructor({ url, name, width = 1920, height = 1080, fps = 30, panelUrl = '', reloadOnShow = true }) {
    super('web', name || 'Página web');
    listen();
    this.url = url;
    this.pageWidth = width;
    this.pageHeight = height;
    this.fps = fps;
    this.panelUrl = panelUrl;
    this.reloadOnShow = reloadOnShow;
    this.webId = `web-${this.id}-${Date.now()}`;
    this.state = 'loading';
    this.painted = false;
    this.canvas = Object.assign(document.createElement('canvas'), { width, height });
    // Paint on the GPU when possible; the 2D canvas is the fallback.
    try {
      this.painter = new BgraPainter(this.canvas);
    } catch (err) {
      console.warn('Página web sin WebGL2; se pinta con la CPU:', err.message);
      this.painter = null;
      this.ctx2d = this.canvas.getContext('2d');
    }
    this.lastShown = performance.now();
    this.sentFps = fps;
    registry.set(this.webId, this);
    window.studio
      .startWebInput(this.webId, url, { width, height, fps })
      .then((result) => {
        this.url = result.url; // normalised: a typed path becomes a file:// URL
      })
      .catch((err) => this.onStatus({ state: 'error', error: err.message }));
  }

  get transparent() {
    return true;
  }

  onStatus(status) {
    this.state = status.state;
    this.error = status.error ?? null;
  }

  paint(rect, pixels) {
    try {
      if (this.painter && !this.painter.lost) {
        const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        this.painter.paint(rect, bytes, pixels.byteLength / rect.height);
      } else {
        this.paint2d(rect, pixels);
      }
      this.painted = true;
    } finally {
      window.studio.ackWebInput(this.webId);
    }
  }

  /** CPU path: converts premultiplied BGRA to straight RGBA for putImageData. */
  paint2d(rect, pixels) {
    if (!this.ctx2d) {
      // The GPU context was lost: carry on with a fresh 2D canvas.
      this.canvas = Object.assign(document.createElement('canvas'), { width: rect.fullWidth, height: rect.fullHeight });
      this.ctx2d = this.canvas.getContext('2d');
      this.painter = null;
    }
    const c = this.canvas;
    if (c.width !== rect.fullWidth || c.height !== rect.fullHeight) Object.assign(c, { width: rect.fullWidth, height: rect.fullHeight });
    const raw = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const px = bgraToRgba(packRows(raw, rect.width, rect.height));
    this.ctx2d.putImageData(new ImageData(px, rect.width, rect.height), rect.x, rect.y);
  }

  draw(ctx, x, y, w, h, time, mode, ...rest) {
    // Anything but a card thumbnail means someone is watching it.
    if (mode !== 'thumb') this.lastShown = performance.now();
    return super.draw(ctx, x, y, w, h, time, mode, ...rest);
  }

  /** Full frame rate while shown (or in the multiview), a trickle otherwise. */
  updateRate(now) {
    const watched = now - this.lastShown < SHOWN_WINDOW_MS || document.querySelector('.stage')?.dataset.view === 'multiview';
    const fps = watched ? this.fps : Math.min(this.fps, IDLE_FPS);
    if (fps === this.sentFps) return;
    this.sentFps = fps;
    window.studio.setWebInputFps(this.webId, fps);
  }

  source() {
    return this.painted ? { el: this.canvas, w: this.canvas.width, h: this.canvas.height } : null;
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode === 'program') return;
    const text = this.state === 'error' ? this.error || 'No se pudo cargar' : 'Cargando página…';
    drawPlaceholder(ctx, x, y, w, h, '🌍', text);
  }

  /** Starts the page again, so its entry animation plays (like OBS's "refresh when the scene becomes active"). */
  reload() {
    if (this.painter && !this.painter.lost) this.painter.clear();
    else this.ctx2d?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // About to be shown: render at full rate straight away.
    this.lastShown = performance.now();
    this.updateRate(this.lastShown);
    window.studio.reloadWebInput(this.webId);
  }

  /** Called when the input goes on air (program or an overlay layer). */
  onShow() {
    if (this.reloadOnShow) this.reload();
  }

  controls() {
    const list = [
      ['⟳', 'Recargar la página (repite su animación)', () => this.reload()],
      ['🖱', 'Abrir la página en una ventana para hacer clic en ella', () => this.openWindow('page')],
    ];
    if (this.panelUrl) list.push(['🎛', 'Abrir el panel de control', () => this.openWindow('panel')]);
    return list;
  }

  openWindow(kind) {
    window.studio.openWebWindow(this.webId, kind, this.panelUrl).catch((err) => console.warn('No se pudo abrir la ventana', err));
  }

  serialize() {
    return {
      ...super.serialize(),
      url: this.url,
      width: this.pageWidth,
      height: this.pageHeight,
      fps: this.fps,
      panelUrl: this.panelUrl,
      reloadOnShow: this.reloadOnShow,
    };
  }

  destroy() {
    super.destroy();
    registry.delete(this.webId);
    window.studio.stopWebInput(this.webId);
  }
}
