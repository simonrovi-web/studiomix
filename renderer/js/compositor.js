import { LumaWipe, Stinger } from './transitions.js';

export const LAYOUTS = {
  full: { label: 'Pantalla completa', rect: [0, 0, 1, 1] },
  tr: { label: 'PiP arriba derecha', rect: [0.67, 0.04, 0.29, 0.29] },
  br: { label: 'PiP abajo derecha', rect: [0.67, 0.67, 0.29, 0.29] },
  bl: { label: 'PiP abajo izquierda', rect: [0.04, 0.67, 0.29, 0.29] },
  tl: { label: 'PiP arriba izquierda', rect: [0.04, 0.04, 0.29, 0.29] },
  left: { label: 'Mitad izquierda', rect: [0, 0, 0.5, 1] },
  right: { label: 'Mitad derecha', rect: [0.5, 0, 0.5, 1] },
  sideL: { label: 'Lado a lado izquierda', rect: [0.02, 0.24, 0.47, 0.52] },
  sideR: { label: 'Lado a lado derecha', rect: [0.51, 0.24, 0.47, 0.52] },
};

export const TRANSITIONS = {
  fade: 'Fundido',
  dip: 'Fundido a negro',
  wipe: 'Cortinilla',
  slide: 'Deslizar',
  zoom: 'Zoom',
  iris: 'Iris',
  luma: 'Luma wipe',
  stinger: 'Stinger (vídeo)',
};

const OVERLAY_FADE_MS = 350;
const FTB_FADE_MS = 800;
const THUMB_EVERY = 3;
const MULTIVIEW_EVERY = 2;

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

/**
 * Renders Program, Preview, thumbnails and the multiview from shared state:
 *   state.inputs, previewId, programId, overlays[], ftb, transition.
 * Program is the canvas that gets captured for streaming and recording.
 */
export class Compositor {
  constructor(state, programCanvas, previewCanvas, multiviewCanvas) {
    this.state = state;
    this.program = programCanvas;
    this.preview = previewCanvas;
    this.multiview = multiviewCanvas;
    this.pctx = programCanvas.getContext('2d', { alpha: false });
    this.vctx = previewCanvas.getContext('2d', { alpha: false });
    this.mctx = multiviewCanvas.getContext('2d', { alpha: false });
    this.thumbs = new Map(); // id -> { canvas, visible }
    this.multiviewCells = [];
    this.frame = 0;
    this.lastFrame = performance.now();
    this.lastTick = 0;
    this.videoTrack = null;
    this.onCommit = null;
    this.onMasterFade = null;
    this.onFrame = null;
    this.stats = { fps: 0, renderMs: 0, late: 0 };
    this.statWindow = { start: performance.now(), frames: 0, cost: 0, late: 0 };
    this.stinger = new Stinger();
    this.lumaWipe = null;
    this.offscreen = null;
    this.ticker = new Worker('js/ticker.worker.js');
    this.ticker.onmessage = () => this.tick();
  }

  byId(id) {
    return id == null ? null : this.state.inputs.find((input) => input.id === id) ?? null;
  }

  configure(width, height, fps) {
    this.fps = fps;
    this.program.width = width;
    this.program.height = height;
    this.preview.width = Math.round(width / 2);
    this.preview.height = Math.round(height / 2);
    this.videoTrack?.stop();
    this.videoTrack = this.program.captureStream(fps).getVideoTracks()[0];
    // Vertical (9:16) output, composed alongside Program when enabled.
    this.vertical ??= document.createElement('canvas');
    this.vertical.width = 1080;
    this.vertical.height = 1920;
    this.vctxV = this.vertical.getContext('2d', { alpha: false });
    this.verticalTrack?.stop();
    this.verticalTrack = this.vertical.captureStream(fps).getVideoTracks()[0];
    this.ticker.postMessage(fps);
  }

  /**
   * Vertical frame. `cfg`: { mode: 'reframe' | 'input', panX (-1…1),
   * inputId (for 'input'), overlayId (graphics layer drawn on top) }.
   */
  renderVertical(now, cfg) {
    const c = this.vertical;
    const ctx = this.vctxV;
    const W = c.width;
    const H = c.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const source = cfg.mode === 'input' ? this.byId(cfg.inputId) : null;
    if (source) {
      const fit = source.fit;
      source.fit = 'cover';
      try {
        this.drawInput(ctx, source, 0, 0, W, H, now, 'program');
      } finally {
        source.fit = fit;
      }
    } else {
      // Reframe: a 9:16 slice of Program, moved left/right with panX.
      const pw = this.program.width;
      const ph = this.program.height;
      const cw = Math.min(pw, (ph * W) / H);
      const sx = ((pw - cw) * (1 + (cfg.panX || 0))) / 2;
      ctx.drawImage(this.program, sx, 0, cw, ph, 0, 0, W, H);
    }
    const overlay = this.byId(cfg.overlayId);
    if (overlay) this.drawInput(ctx, overlay, 0, 0, W, H, now, 'program');
  }

  tick() {
    const start = performance.now();
    // Ticks queue up while the main thread is blocked (e.g. a model compiling);
    // render once and drop the backlog instead of bursting through stale frames.
    if (start - this.lastTick < 500 / this.fps) return;
    this.lastTick = start;
    this.render(start);
    const cost = performance.now() - start;
    const w = this.statWindow;
    w.frames++;
    w.cost += cost;
    if (cost > 1000 / this.fps) w.late++;
    if (start - w.start >= 1000) {
      const secs = (start - w.start) / 1000;
      this.stats = { fps: w.frames / secs, renderMs: w.cost / w.frames, late: w.late };
      this.statWindow = { start, frames: 0, cost: 0, late: 0 };
    }
  }

  // --- switching -----------------------------------------------------------

  get transitioning() {
    const s = this.state;
    return s.transition.progress > 0 && s.previewId != null && s.previewId !== s.programId;
  }

  cut() {
    const s = this.state;
    if (s.previewId == null || s.previewId === s.programId) return;
    this.commit();
  }

  auto() {
    const s = this.state;
    const t = s.transition;
    if (t.running || s.previewId == null || s.previewId === s.programId) return;
    t.running = true;
    t.startedAt = performance.now();
    t.from = t.manual / 100;
    t.activeDuration = t.duration;
    // Stinger: the cut happens at the clip's transition point; the clip keeps playing over the new shot.
    if (t.type === 'stinger' && this.stinger.ready && this.stinger.start()) {
      t.from = 0;
      t.activeDuration = Math.max(1, Math.min(t.stinger.cutPoint, this.stinger.durationMs));
    }
  }

  setManual(value) {
    const t = this.state.transition;
    if (t.running) return false;
    t.manual = value;
    if (value >= 100) {
      this.commit();
      return true;
    }
    return false;
  }

  commit() {
    const s = this.state;
    const t = s.transition;
    [s.programId, s.previewId] = [s.previewId, s.programId];
    t.running = false;
    t.manual = 0;
    t.progress = 0;
    this.onCommit?.();
  }

  toggleOverlay(index, inputId) {
    const ov = this.state.overlays[index];
    if (ov.inputId === inputId && ov.target > 0) {
      ov.target = 0;
    } else {
      if (ov.inputId !== inputId) ov.alpha = 0;
      ov.inputId = inputId;
      ov.target = 1;
    }
  }

  toggleFtb() {
    const ftb = this.state.ftb;
    ftb.target = ftb.target > 0 ? 0 : 1;
  }

  /** Index of the multiview cell under canvas coordinates, or null. */
  cellAt(x, y) {
    return this.multiviewCells.find((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) ?? null;
  }

  // --- rendering -----------------------------------------------------------

  drawInput(ctx, input, x, y, w, h, now, mode, anim = 1) {
    ctx.save();
    try {
      input.draw(ctx, x, y, w, h, now, mode, this.frame, anim);
    } catch (err) {
      console.error(`Error dibujando ${input.name}`, err);
    }
    ctx.restore();
  }

  drawTransition(ctx, from, to, p, W, H, now) {
    const e = easeInOut(p);
    const draw = (input) => input && this.drawInput(ctx, input, 0, 0, W, H, now, 'program');
    const black = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    };
    switch (this.state.transition.type) {
      case 'dip':
        ctx.globalAlpha = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2;
        draw(p < 0.5 ? from : to);
        break;
      case 'wipe':
        draw(from);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W * e, H);
        ctx.clip();
        black();
        draw(to);
        ctx.restore();
        break;
      case 'slide':
        ctx.save();
        ctx.translate(-W * e, 0);
        draw(from);
        ctx.translate(W, 0);
        black();
        draw(to);
        ctx.restore();
        break;
      case 'zoom': {
        draw(from);
        const z = 0.6 + 0.4 * e;
        ctx.save();
        ctx.globalAlpha = Math.min(1, e * 1.5);
        ctx.translate((W * (1 - z)) / 2, (H * (1 - z)) / 2);
        ctx.scale(z, z);
        black();
        draw(to);
        ctx.restore();
        break;
      }
      case 'stinger':
        // While the clip covers the switch, keep the old shot until the cut point.
        if (this.stinger.playing) {
          draw(from);
          break;
        }
        draw(from);
        ctx.globalAlpha = e;
        black();
        draw(to);
        break;
      case 'luma': {
        if (!this.offscreen || this.offscreen[0].width !== W || this.offscreen[0].height !== H) {
          this.offscreen = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: W, height: H }));
        }
        const [a, b] = this.offscreen.map((c) => c.getContext('2d', { alpha: false }));
        for (const [c, input] of [[a, from], [b, to]]) {
          c.fillStyle = '#000';
          c.fillRect(0, 0, W, H);
          if (input) this.drawInput(c, input, 0, 0, W, H, now, 'program');
        }
        try {
          this.lumaWipe ??= new LumaWipe();
          ctx.drawImage(this.lumaWipe.render(this.offscreen[0], this.offscreen[1], p, this.state.transition.luma), 0, 0, W, H);
        } catch (err) {
          console.warn('Luma wipe no disponible', err);
          draw(p < 0.5 ? from : to);
        }
        break;
      }
      case 'iris':
        draw(from);
        ctx.save();
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, Math.hypot(W, H) * 0.5 * e, 0, Math.PI * 2);
        ctx.clip();
        black();
        draw(to);
        ctx.restore();
        break;
      default:
        draw(from);
        ctx.globalAlpha = e;
        black();
        draw(to);
    }
    ctx.globalAlpha = 1;
  }

  render(now) {
    const s = this.state;
    const t = s.transition;
    const dt = Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;

    let p = t.manual / 100;
    if (t.running) {
      p = t.from + ((now - t.startedAt) / Math.max(t.activeDuration ?? t.duration, 1)) * (1 - t.from);
      if (p >= 1) {
        this.commit();
        p = 0;
      }
    }
    t.progress = p;

    for (const ov of s.overlays) {
      ov.alpha = approach(ov.alpha, ov.target, dt / OVERLAY_FADE_MS);
      if (ov.alpha === 0 && ov.target === 0) ov.inputId = null;
    }
    s.ftb.alpha = approach(s.ftb.alpha, s.ftb.target, dt / FTB_FADE_MS);

    const program = this.byId(s.programId);
    const preview = this.byId(s.previewId);
    const inTransition = p > 0 && preview && preview !== program;

    // Program
    const W = this.program.width;
    const H = this.program.height;
    const ctx = this.pctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (inTransition) this.drawTransition(ctx, program, preview, p, W, H, now);
    else if (program) this.drawInput(ctx, program, 0, 0, W, H, now, 'program');

    for (const ov of s.overlays) {
      const input = this.byId(ov.inputId);
      if (!input || ov.alpha <= 0) continue;
      const [rx, ry, rw, rh] = (LAYOUTS[input.layout] || LAYOUTS.full).rect;
      ctx.globalAlpha = ov.alpha;
      this.drawInput(ctx, input, rx * W, ry * H, rw * W, rh * H, now, 'program', ov.alpha);
    }
    ctx.globalAlpha = 1;
    this.stinger.draw(ctx, W, H);

    if (s.ftb.alpha > 0) {
      ctx.globalAlpha = s.ftb.alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // Preview
    const vctx = this.vctx;
    vctx.fillStyle = '#000';
    vctx.fillRect(0, 0, this.preview.width, this.preview.height);
    if (preview) this.drawInput(vctx, preview, 0, 0, this.preview.width, this.preview.height, now, 'preview');

    // Audio follows video: an input is audible as much as it is visible on Program,
    // including as a layer inside a scene.
    const weights = new Map();
    const show = (input, w) => {
      if (!input || w <= 0) return;
      weights.set(input.id, Math.max(weights.get(input.id) ?? 0, w));
      input.visibleInputs?.(w, weights);
    };
    show(program, inTransition ? 1 - p : 1);
    if (inTransition) show(preview, p);
    for (const ov of s.overlays) show(this.byId(ov.inputId), ov.alpha);
    for (const input of s.inputs) input.channel?.setPresence(weights.get(input.id) ?? 0);
    this.onMasterFade?.(1 - s.ftb.alpha);

    if (s.view === 'multiview' && this.frame % MULTIVIEW_EVERY === 0) this.renderMultiview(now);
    if (this.verticalConfig?.()) this.renderVertical(now, this.verticalConfig());

    if (this.frame % THUMB_EVERY === 0) {
      for (const [id, thumb] of this.thumbs) {
        if (!thumb.visible) continue;
        const input = this.byId(id);
        if (!input) continue;
        const tctx = thumb.ctx;
        tctx.fillStyle = '#000';
        tctx.fillRect(0, 0, thumb.canvas.width, thumb.canvas.height);
        this.drawInput(tctx, input, 0, 0, thumb.canvas.width, thumb.canvas.height, now, 'thumb');
      }
    }

    this.onFrame?.(now);
    this.frame++;
  }

  renderMultiview(now) {
    const s = this.state;
    const c = this.multiview;
    const ctx = this.mctx;
    const W = c.width;
    const H = c.height;
    const gap = 4;
    ctx.fillStyle = '#0a0b0e';
    ctx.fillRect(0, 0, W, H);

    const topH = Math.round(H * 0.5);
    const halfW = W / 2;
    const cells = [];

    const label = (x, y, w, h, text, color) => {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x, y + h - 26, w, 26);
      ctx.fillStyle = '#fff';
      ctx.font = '600 15px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 8, y + h - 13, w - 16);
      if (color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      }
    };

    ctx.drawImage(this.preview, gap, gap, halfW - gap * 1.5, topH - gap * 1.5);
    label(gap, gap, halfW - gap * 1.5, topH - gap * 1.5, `PREVIEW · ${this.byId(s.previewId)?.name ?? '—'}`, '#2fbf71');
    ctx.drawImage(this.program, halfW + gap / 2, gap, halfW - gap * 1.5, topH - gap * 1.5);
    label(halfW + gap / 2, gap, halfW - gap * 1.5, topH - gap * 1.5, `PROGRAM · ${this.byId(s.programId)?.name ?? '—'}`, '#e5383b');

    // Clock in the program cell.
    ctx.font = '700 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W - 128, gap + 6, 116, 32);
    ctx.fillStyle = '#fff';
    ctx.fillText(new Date().toLocaleTimeString('es-ES'), W - 18, gap + 11);

    const inputs = s.inputs;
    const cols = Math.max(4, Math.ceil(inputs.length / 2));
    const rows = 2;
    const cw = (W - gap) / cols;
    const ch = (H - topH - gap) / rows;
    inputs.forEach((input, i) => {
      const x = gap + (i % cols) * cw;
      const y = topH + Math.floor(i / cols) * ch;
      const w = cw - gap;
      const h = ch - gap;
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
      this.drawInput(ctx, input, x, y, w, h, now, 'thumb');
      let tally = null;
      if (input.id === s.programId) tally = '#e5383b';
      else if (input.id === s.previewId) tally = '#2fbf71';
      else if (s.overlays.some((ov) => ov.inputId === input.id && ov.target > 0)) tally = '#f2b33d';
      label(x, y, w, h, `${i + 1}  ${input.name}`, tally);
      // Audio level bar on the right edge.
      const levels = input.channel?.meter.levels;
      if (levels) {
        const peak = Math.max(levels[0], levels[1]);
        const db = peak > 0 ? 20 * Math.log10(peak) : -100;
        const frac = Math.min(1, Math.max(0, (db + 60) / 60));
        ctx.fillStyle = db > -6 ? '#e5383b' : db > -18 ? '#f2b33d' : '#2fbf71';
        ctx.fillRect(x + w - 8, y + (h - 26) * (1 - frac), 5, (h - 26) * frac);
      }
      cells.push({ id: input.id, x, y, w, h });
    });
    this.multiviewCells = cells;
  }
}
