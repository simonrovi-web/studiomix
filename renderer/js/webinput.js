// Web page input: an HTML graphic with a transparent background (OBS-style
// browser source). The main process renders the page offscreen and sends the
// rectangles that change as premultiplied BGRA; they are painted here onto a
// canvas that is drawn like any other source.
import { Input } from './inputs.js';
import { bgraToRgba, packRows } from './pixels.js';
import { drawPlaceholder } from './util.js';

const registry = new Map();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.studio.onWebInput(
    (id, rect, pixels) => registry.get(id)?.paint(rect, pixels),
    (status) => registry.get(status.id)?.onStatus(status),
  );
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
    this.ctx2d = this.canvas.getContext('2d');
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
      const c = this.canvas;
      if (c.width !== rect.fullWidth || c.height !== rect.fullHeight) Object.assign(c, { width: rect.fullWidth, height: rect.fullHeight });
      const raw = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const px = bgraToRgba(packRows(raw, rect.width, rect.height));
      this.ctx2d.putImageData(new ImageData(px, rect.width, rect.height), rect.x, rect.y);
      this.painted = true;
    } finally {
      window.studio.ackWebInput(this.webId);
    }
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
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
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
