import { DEFAULT_FX, EffectProcessor, needsGpu, parseCube, presetLut } from './effects.js';
import { BackgroundRemover } from './segmenter.js';

const EMPTY_MASK = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
import { DEFAULT_TITLE, TITLE_TEMPLATES } from './titles.js';
import { drawChecker, drawFitted, drawPlaceholder, framedRect } from './util.js';

let seq = 0;

export function mediaUrl(path) {
  return `app://studiomix/media?p=${encodeURIComponent(path)}`;
}

function mediaHost() {
  return document.getElementById('media-host');
}

function streamAudioNode(ctx, stream) {
  const tracks = stream?.getAudioTracks() ?? [];
  return tracks.length ? ctx.createMediaStreamSource(new MediaStream(tracks)) : null;
}

function makeVideoElement(stream) {
  const video = document.createElement('video');
  video.muted = true; // audio is routed through the mixer, not the element
  video.playsInline = true;
  video.srcObject = stream;
  mediaHost().append(video);
  video.play().catch(() => {});
  return video;
}

function makeMediaElement(tag, url) {
  const el = document.createElement(tag);
  el.src = url;
  el.loop = true;
  el.preload = 'auto';
  if (tag === 'video') el.playsInline = true;
  mediaHost().append(el);
  el.play().catch(() => {});
  return el;
}

function releaseMediaElement(el) {
  el.pause();
  el.removeAttribute('src');
  el.load();
  el.remove();
}

/**
 * Base input. draw() receives:
 *  - mode: 'program' | 'preview' | 'thumb' (audio-only and loading inputs draw
 *    nothing on program; transparent ones get a checkerboard elsewhere),
 *  - frame: compositor frame number, so GPU effects run once per frame even
 *    when the input appears on program, preview and its thumbnail,
 *  - anim: 0–1 entry animation progress (overlay fade-in) used by titles.
 */
export class Input {
  constructor(type, name) {
    this.id = ++seq;
    this.type = type;
    this.name = name;
    this.fit = 'contain';
    this.layout = 'full';
    this.channel = null;
    this.stream = null;
    this.defaultAfv = false;
    this.fx = { ...DEFAULT_FX };
    this.processor = null;
    this.fxFrame = -1;
    this.fxCanvas = null;
  }

  get hasVideo() {
    return true;
  }

  get transparent() {
    return this.fx.keyOn || this.fx.opacity < 1 || !!this.fx.maskPath || this.fx.removeBg;
  }

  /** Inputs backed by a video/image element return { el, w, h } once a frame is available. */
  source() {
    return null;
  }

  draw(ctx, x, y, w, h, time, mode, frame = -1, anim = 1) {
    if (mode !== 'program' && this.transparent) drawChecker(ctx, x, y, w, h);
    if (this.fx.opacity < 1) ctx.globalAlpha *= this.fx.opacity;
    const src = this.source();
    if (src) this.drawSource(ctx, src, x, y, w, h, frame, time);
    else this.render(ctx, x, y, w, h, time, mode, anim);
  }

  /** Decoded LUT and mask image for the current fx settings (loaded lazily). */
  assets(source, frame) {
    const fx = this.fx;
    if (fx.lut !== this.lutKey) {
      const key = fx.lut;
      this.lutKey = key;
      this.lutData = null;
      if (key.startsWith('preset:')) {
        this.lutData = presetLut(key.slice(7));
      } else if (key) {
        window.studio
          .readLut(key)
          .then((text) => {
            if (this.lutKey === key) this.lutData = parseCube(text);
          })
          .catch((err) => console.warn('LUT no válida', err));
      }
    }
    if (fx.maskPath !== this.maskKey) {
      const key = fx.maskPath;
      this.maskKey = key;
      this.maskImage = null;
      if (key) {
        const img = new Image();
        img.onload = () => {
          if (this.maskKey === key) this.maskImage = img;
        };
        img.src = mediaUrl(key);
      }
    }
    if (fx.removeBg) {
      this.bgRemover ??= new BackgroundRemover();
      const mask = this.bgRemover.maskFor(source, frame);
      // Until the model is ready, show nothing rather than the full background.
      return { lut: this.lutData, mask: mask ?? EMPTY_MASK, maskDynamic: true };
    }
    return { lut: this.lutData, mask: this.maskImage };
  }

  drawSource(ctx, { el, w: sw, h: sh }, x, y, w, h, frame, time = 0) {
    const fx = this.fx;
    let image = el;
    if (needsGpu(fx)) {
      if (this.fxFrame !== frame || frame < 0) {
        try {
          this.processor ??= new EffectProcessor();
          this.fxCanvas = this.processor.process(el, sw, sh, fx, { ...this.assets(el, frame), time });
        } catch (err) {
          console.warn('Efectos desactivados:', err);
          Object.assign(fx, { ...DEFAULT_FX, opacity: fx.opacity, flip: fx.flip, cropL: fx.cropL, cropR: fx.cropR, cropT: fx.cropT, cropB: fx.cropB });
          this.fxCanvas = null;
        }
        this.fxFrame = frame;
      }
      if (this.fxCanvas) image = this.fxCanvas;
    }
    const r = framedRect(fx, sw, sh);
    drawFitted(ctx, image, r.x, r.y, r.w, r.h, x, y, w, h, this.fit, fx.flip, fx.rotate);
  }

  render() {}

  /** Live controls shown on the input card: [label, tooltip, handler]. */
  controls() {
    return [];
  }

  serialize() {
    return { type: this.type, name: this.name, fit: this.fit, layout: this.layout, fx: { ...this.fx }, audio: this.channel?.serialize() ?? null };
  }

  restore(data) {
    this.name = data.name ?? this.name;
    this.fit = data.fit ?? this.fit;
    this.layout = data.layout ?? this.layout;
    Object.assign(this.fx, data.fx ?? {});
  }

  destroy() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor?.dispose();
    this.bgRemover?.dispose();
  }
}

class MediaFileInput extends Input {
  constructor(type, file, tag) {
    super(type, file.name);
    this.path = file.path;
    this.el = makeMediaElement(tag, file.url);
  }

  get loop() {
    return this.el.loop;
  }

  set loop(value) {
    this.el.loop = value;
  }

  togglePlay() {
    if (this.el.paused) this.el.play().catch(() => {});
    else this.el.pause();
  }

  restart() {
    this.el.currentTime = 0;
    this.el.play().catch(() => {});
  }

  get progress() {
    const d = this.el.duration;
    return Number.isFinite(d) && d > 0 ? this.el.currentTime / d : 0;
  }

  get remaining() {
    const d = this.el.duration;
    return Number.isFinite(d) ? Math.max(0, d - this.el.currentTime) : 0;
  }

  controls() {
    return [
      ['⏯', 'Reproducir / pausar', () => this.togglePlay()],
      ['⏮', 'Volver al inicio', () => this.restart()],
    ];
  }

  createAudioNode(ctx) {
    return ctx.createMediaElementSource(this.el);
  }

  serialize() {
    return { ...super.serialize(), path: this.path, loop: this.loop };
  }

  restore(data) {
    super.restore(data);
    if (typeof data.loop === 'boolean') this.loop = data.loop;
  }

  destroy() {
    super.destroy();
    releaseMediaElement(this.el);
  }
}

export class VideoFileInput extends MediaFileInput {
  constructor(file) {
    super('video', file, 'video');
    this.defaultAfv = true;
    this.hold = null;
    this.holdTime = -1;
  }

  /**
   * When the clip loops (or is restarted) the element seeks back to the start
   * and drops to HAVE_METADATA until the first frame is decoded again, which
   * would show as black. Keep a copy of the last frame shown and use it while
   * the element has no frame to give.
   */
  source() {
    const v = this.el;
    if (v.readyState >= 2 && !v.seeking && v.videoWidth) {
      // Copying every frame costs a full-frame blit; only the last half second
      // before a loop needs it (restart() and replaceSource() take their own copy).
      const nearEnd = v.loop && Number.isFinite(v.duration) && v.duration - v.currentTime < 0.5;
      if ((nearEnd || !this.hold) && v.currentTime !== this.holdTime) this.updateHold(v);
      return { el: v, w: v.videoWidth, h: v.videoHeight };
    }
    return this.hold ? { el: this.hold, w: this.hold.width, h: this.hold.height } : null;
  }

  restart() {
    if (this.el.readyState >= 2 && this.el.videoWidth) this.updateHold(this.el);
    super.restart();
  }

  /** Swaps in another file (e.g. the optimised copy), keeping position and state. */
  replaceSource(file) {
    const v = this.el;
    if (v.readyState >= 2 && v.videoWidth) this.updateHold(v);
    const time = v.currentTime;
    const wasPaused = v.paused;
    this.originalPath ??= this.path;
    this.path = file.path;
    v.src = file.url;
    v.addEventListener(
      'loadedmetadata',
      () => {
        v.currentTime = Math.min(time, Math.max(0, v.duration - 0.1));
        if (!wasPaused) v.play().catch(() => {});
      },
      { once: true },
    );
  }

  serialize() {
    return { ...super.serialize(), originalPath: this.originalPath ?? null };
  }

  updateHold(v) {
    // Cap the copy at 1080p; it's only on screen for a few frames.
    const scale = Math.min(1, 1920 / v.videoWidth, 1080 / v.videoHeight);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    if (!this.hold) this.hold = document.createElement('canvas');
    if (this.hold.width !== w || this.hold.height !== h) {
      this.hold.width = w;
      this.hold.height = h;
    }
    this.hold.getContext('2d', { alpha: false }).drawImage(v, 0, 0, w, h);
    this.holdTime = v.currentTime;
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode !== 'program') drawPlaceholder(ctx, x, y, w, h, '⏳', 'Cargando…');
  }
}

export class AudioFileInput extends MediaFileInput {
  constructor(file) {
    super('audio', file, 'audio');
  }

  get hasVideo() {
    return false;
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode !== 'program') drawPlaceholder(ctx, x, y, w, h, '♪', this.name);
  }
}

export class ImageInput extends Input {
  constructor(file) {
    super('image', file.name);
    this.path = file.path;
    this.img = new Image();
    this.img.src = file.url;
    this.hasAlpha = /\.(png|gif|webp)$/i.test(file.path);
  }

  get transparent() {
    return this.hasAlpha || super.transparent;
  }

  source() {
    const img = this.img;
    return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
  }

  serialize() {
    return { ...super.serialize(), path: this.path };
  }
}

class StreamVideoInput extends Input {
  constructor(type, stream, name) {
    super(type, name);
    this.stream = stream;
    this.video = makeVideoElement(stream);
  }

  source() {
    const v = this.video;
    return v.readyState >= 2 ? { el: v, w: v.videoWidth, h: v.videoHeight } : null;
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode !== 'program') drawPlaceholder(ctx, x, y, w, h, this.type === 'camera' ? '📷' : '🖥', 'Iniciando…');
  }

  createAudioNode(ctx) {
    return streamAudioNode(ctx, this.stream);
  }

  destroy() {
    super.destroy();
    this.video.srcObject = null;
    this.video.remove();
  }
}

export class CameraInput extends StreamVideoInput {
  static async create({ videoDeviceId, audioDeviceId, name }) {
    const constraints = (exact) => ({
      video: {
        deviceId: videoDeviceId ? (exact ? { exact: videoDeviceId } : { ideal: videoDeviceId }) : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: audioDeviceId
        ? { deviceId: { ideal: audioDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(true));
    } catch (err) {
      if (err.name !== 'OverconstrainedError') throw err;
      stream = await navigator.mediaDevices.getUserMedia(constraints(false));
    }
    const input = new CameraInput(stream, name);
    input.videoDeviceId = videoDeviceId;
    input.audioDeviceId = audioDeviceId;
    return input;
  }

  constructor(stream, name) {
    super('camera', stream, name || 'Cámara');
  }

  serialize() {
    return { ...super.serialize(), videoDeviceId: this.videoDeviceId, audioDeviceId: this.audioDeviceId };
  }
}

/** A remote guest's camera and microphone, received over WebRTC. */
export class GuestInput extends StreamVideoInput {
  constructor(stream, name, guestId) {
    super('guest', stream, name || 'Invitado');
    this.guestId = guestId;
    this.defaultAfv = false;
    this.fit = 'cover';
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode !== 'program') drawPlaceholder(ctx, x, y, w, h, '👤', 'Conectando…');
  }
}

export class ScreenInput extends StreamVideoInput {
  static async create(sourceId, name) {
    await window.studio.selectDisplaySource(sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    return new ScreenInput(stream, name);
  }

  constructor(stream, name) {
    super('screen', stream, name || 'Pantalla');
  }
}

export class MicInput extends Input {
  static async create({ audioDeviceId, name }) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: audioDeviceId ? { ideal: audioDeviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const input = new MicInput(stream, name);
    input.audioDeviceId = audioDeviceId;
    return input;
  }

  constructor(stream, name) {
    super('mic', name || 'Micrófono');
    this.stream = stream;
  }

  get hasVideo() {
    return false;
  }

  createAudioNode(ctx) {
    return streamAudioNode(ctx, this.stream);
  }

  render(ctx, x, y, w, h, _time, mode) {
    if (mode !== 'program') drawPlaceholder(ctx, x, y, w, h, '🎙', this.name);
  }

  serialize() {
    return { ...super.serialize(), audioDeviceId: this.audioDeviceId };
  }
}

export class ColorInput extends Input {
  constructor(color, name) {
    super('color', name || 'Color');
    this.color = color;
    this.color2 = null;
  }

  render(ctx, x, y, w, h) {
    if (this.color2) {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, this.color);
      g.addColorStop(1, this.color2);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = this.color;
    }
    ctx.fillRect(x, y, w, h);
  }

  serialize() {
    return { ...super.serialize(), color: this.color, color2: this.color2 };
  }

  restore(data) {
    super.restore(data);
    this.color2 = data.color2 ?? null;
  }
}

/**
 * Parses a title list: one entry per line, fields separated by "|", ";" or ","
 * (CSV with optional quotes). Empty lines and a "titulo,subtitulo" header are skipped.
 */
export function parseTitleList(text) {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.includes('|') ? '|' : line.includes(';') ? ';' : ',';
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"' && quoted) {
        cur += '"';
        i++;
      } else if (c === '"') quoted = !quoted;
      else if (c === sep && !quoted) {
        cells.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    cells.push(cur.trim());
    if (rows.length === 0 && /^(t[ií]tulo|nombre|name|title)$/i.test(cells[0])) continue;
    rows.push(cells);
  }
  return rows;
}

export class TitleInput extends Input {
  constructor(fields = {}, name) {
    super('title', name || 'Título');
    this.fields = { ...DEFAULT_TITLE, ...fields };
    this.timer = { running: false, base: 0, startedAt: 0 };
  }

  get template() {
    return TITLE_TEMPLATES[this.fields.template] || TITLE_TEMPLATES.lowerThird;
  }

  get transparent() {
    return !this.template.opaque || super.transparent;
  }

  elapsed(now = performance.now()) {
    return this.timer.base + (this.timer.running ? now - this.timer.startedAt : 0);
  }

  toggleTimer() {
    const t = this.timer;
    if (t.running) t.base = this.elapsed();
    else t.startedAt = performance.now();
    t.running = !t.running;
  }

  resetTimer() {
    Object.assign(this.timer, { running: false, base: 0, startedAt: 0 });
  }

  bump(key, delta) {
    this.fields[key] = Math.max(0, (Number(this.fields[key]) || 0) + delta);
  }

  /** Rows of the title list: "Texto principal | Texto secundario" per line (or CSV). */
  get rows() {
    return parseTitleList(this.fields.list);
  }

  /** "2/7" when the title has a list, otherwise ''. */
  get listInfo() {
    const n = this.rows.length;
    return n ? `${(this.fields.listIndex ?? 0) + 1}/${n}` : '';
  }

  /** Shows row `index` of the list (wrapping around). */
  showRow(index) {
    const rows = this.rows;
    if (!rows.length) return;
    const i = ((index % rows.length) + rows.length) % rows.length;
    this.fields.listIndex = i;
    const [title, subtitle = ''] = rows[i];
    this.fields.title = title;
    this.fields.subtitle = subtitle;
  }

  controls() {
    const list = [];
    if (this.rows.length) {
      list.push(['◀', 'Rótulo anterior de la lista', () => this.showRow((this.fields.listIndex ?? 0) - 1)]);
      list.push(['▶▶', 'Siguiente rótulo de la lista', () => this.showRow((this.fields.listIndex ?? 0) + 1)]);
    }
    if (this.template.score) {
      list.push(['A+', 'Sumar punto a A', () => this.bump('scoreA', 1)]);
      list.push(['A−', 'Restar punto a A', () => this.bump('scoreA', -1)]);
      list.push(['B+', 'Sumar punto a B', () => this.bump('scoreB', 1)]);
      list.push(['B−', 'Restar punto a B', () => this.bump('scoreB', -1)]);
    }
    if (this.template.timer) {
      list.push(['⏯', 'Iniciar / pausar el cronómetro', () => this.toggleTimer()]);
      list.push(['⟲', 'Reiniciar el cronómetro', () => this.resetTimer()]);
    }
    return list;
  }

  render(ctx, x, y, w, h, time, _mode, anim = 1) {
    ctx.save();
    this.template.draw(ctx, x, y, w, h, this.fields, { time, anim, elapsed: this.elapsed(time) });
    ctx.restore();
  }

  serialize() {
    return { ...super.serialize(), fields: { ...this.fields } };
  }
}

export const INPUT_ICONS = {
  camera: '📷',
  mic: '🎙',
  video: '🎞',
  audio: '♪',
  image: '🖼',
  screen: '🖥',
  color: '■',
  title: 'T',
  scene: '▦',
  network: '🌐',
  guest: '👤',
};

export const INPUT_TYPE_LABELS = {
  camera: 'Cámara',
  mic: 'Micrófono',
  video: 'Vídeo',
  audio: 'Audio',
  image: 'Imagen',
  screen: 'Pantalla',
  color: 'Color',
  title: 'Título',
  scene: 'Escena',
  network: 'Red',
  guest: 'Invitado',
};
