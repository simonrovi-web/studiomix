// Interactive crop editor: shows the whole source frame with the crop box on
// top. Drag edges/corners to resize, inside to move, outside to draw a new box.
// The box is stored as fractions in input.fx.cropL/R/T/B.

const HANDLE = 9;
const MIN_PX = 16;

export class CropEditor {
  constructor(canvas, input, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = input;
    this.onChange = onChange;
    this.aspect = null; // width/height on screen, or null for free
    this.drag = null;
    this.size = { w: 0, h: 0 };
    this.handlers = {
      pointerdown: (e) => this.down(e),
      pointermove: (e) => this.move(e),
      pointerup: (e) => this.up(e),
      pointercancel: (e) => this.up(e),
    };
    for (const [type, fn] of Object.entries(this.handlers)) canvas.addEventListener(type, fn);
  }

  destroy() {
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(type, fn);
  }

  /** Source frame without any effects, or null while loading. */
  frame() {
    const src = this.input.source?.();
    if (!src) return null;
    this.size = { w: src.w, h: src.h };
    return src;
  }

  /** Crop box in source pixels. */
  get box() {
    const { w, h } = this.size;
    const fx = this.input.fx;
    return { l: fx.cropL * w, t: fx.cropT * h, r: w - fx.cropR * w, b: h - fx.cropB * h };
  }

  setBox({ l, t, r, b }) {
    const { w, h } = this.size;
    l = Math.max(0, Math.min(l, w - MIN_PX));
    t = Math.max(0, Math.min(t, h - MIN_PX));
    r = Math.min(w, Math.max(r, l + MIN_PX));
    b = Math.min(h, Math.max(b, t + MIN_PX));
    Object.assign(this.input.fx, { cropL: l / w, cropT: t / h, cropR: (w - r) / w, cropB: (h - b) / h });
    this.onChange();
  }

  /** Ratio the box must keep in source pixels (rotation swaps the axes). */
  sourceAspect() {
    if (!this.aspect) return null;
    return this.input.fx.rotate % 180 ? 1 / this.aspect : this.aspect;
  }

  /** Applies the chosen proportion around the current box centre. */
  applyAspect(aspect) {
    this.aspect = aspect;
    const ratio = this.sourceAspect();
    if (!ratio || !this.size.w) return;
    const { w, h } = this.size;
    const box = this.box;
    const cx = (box.l + box.r) / 2;
    const cy = (box.t + box.b) / 2;
    let bw = box.r - box.l;
    let bh = bw / ratio;
    if (bh > h) {
      bh = h;
      bw = bh * ratio;
    }
    if (bw > w) {
      bw = w;
      bh = bw / ratio;
    }
    const l = Math.min(Math.max(0, cx - bw / 2), w - bw);
    const t = Math.min(Math.max(0, cy - bh / 2), h - bh);
    this.setBox({ l, t, r: l + bw, b: t + bh });
  }

  // --- geometry ---------------------------------------------------------------

  layout() {
    const { w, h } = this.size;
    const pad = 12;
    const scale = Math.min((this.canvas.width - pad * 2) / w, (this.canvas.height - pad * 2) / h);
    return { scale, ox: (this.canvas.width - w * scale) / 2, oy: (this.canvas.height - h * scale) / 2 };
  }

  toSource(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const cy = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    const { scale, ox, oy } = this.layout();
    return [(cx - ox) / scale, (cy - oy) / scale, scale];
  }

  hit(px, py, scale) {
    const { l, t, r, b } = this.box;
    const tol = HANDLE / scale;
    const nearX = Math.abs(px - l) < tol ? 'l' : Math.abs(px - r) < tol ? 'r' : null;
    const nearY = Math.abs(py - t) < tol ? 't' : Math.abs(py - b) < tol ? 'b' : null;
    const inX = px > l - tol && px < r + tol;
    const inY = py > t - tol && py < b + tol;
    if (nearX && nearY) return nearX + nearY;
    if (nearX && inY) return nearX;
    if (nearY && inX) return nearY;
    if (px > l && px < r && py > t && py < b) return 'move';
    return 'new';
  }

  // --- pointer ----------------------------------------------------------------

  down(e) {
    if (!this.size.w || e.button !== 0) return;
    const [px, py, scale] = this.toSource(e);
    const mode = this.hit(px, py, scale);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or vanished pointer.
    }
    this.drag = { mode, start: [px, py], box: this.box };
  }

  move(e) {
    if (!this.size.w) return;
    const [px, py, scale] = this.toSource(e);
    if (!this.drag) {
      const mode = this.hit(px, py, scale);
      const cursors = { l: 'ew-resize', r: 'ew-resize', t: 'ns-resize', b: 'ns-resize', lt: 'nwse-resize', rb: 'nwse-resize', rt: 'nesw-resize', lb: 'nesw-resize', move: 'move', new: 'crosshair' };
      this.canvas.style.cursor = cursors[mode];
      return;
    }
    const { w, h } = this.size;
    const { mode, start, box } = this.drag;
    const dx = px - start[0];
    const dy = py - start[1];
    const ratio = this.sourceAspect();
    let { l, t, r, b } = box;

    if (mode === 'move') {
      const bw = r - l;
      const bh = b - t;
      l = Math.min(Math.max(0, l + dx), w - bw);
      t = Math.min(Math.max(0, t + dy), h - bh);
      this.setBox({ l, t, r: l + bw, b: t + bh });
      return;
    }
    if (mode === 'new') {
      const x0 = Math.max(0, Math.min(w, start[0]));
      const y0 = Math.max(0, Math.min(h, start[1]));
      let x1 = Math.max(0, Math.min(w, px));
      let y1 = Math.max(0, Math.min(h, py));
      if (ratio) {
        const bw = Math.abs(x1 - x0);
        y1 = y0 + Math.sign(y1 - y0 || 1) * (bw / ratio);
      }
      if (Math.abs(x1 - x0) < MIN_PX || Math.abs(y1 - y0) < MIN_PX) return;
      this.setBox({ l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) });
      return;
    }
    if (mode.includes('l')) l = box.l + dx;
    if (mode.includes('r')) r = box.r + dx;
    if (mode.includes('t')) t = box.t + dy;
    if (mode.includes('b')) b = box.b + dy;
    if (ratio) {
      // Keep the proportion: width drives height, except on top/bottom edges.
      if (mode === 't' || mode === 'b') {
        const bw = (b - t) * ratio;
        const cx = (box.l + box.r) / 2;
        l = cx - bw / 2;
        r = cx + bw / 2;
      } else {
        const bh = (r - l) / ratio;
        if (mode.includes('t')) t = b - bh;
        else if (mode.includes('b') || mode === 'l' || mode === 'r') {
          if (mode === 'l' || mode === 'r') {
            const cy = (box.t + box.b) / 2;
            t = cy - bh / 2;
            b = cy + bh / 2;
          } else {
            b = t + bh;
          }
        }
      }
      if (l < 0 || t < 0 || r > w || b > h) return; // would leave the frame
    }
    this.setBox({ l, t, r, b });
  }

  up(e) {
    if (!this.drag) return;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Not captured.
    }
    this.drag = null;
  }

  // --- drawing ------------------------------------------------------------------

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const src = this.frame();
    if (!src) {
      ctx.fillStyle = '#8a93a4';
      ctx.font = '14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Esperando imagen…', canvas.width / 2, canvas.height / 2);
      return;
    }
    const { scale, ox, oy } = this.layout();
    const { w, h } = this.size;
    ctx.drawImage(src.el, 0, 0, w, h, ox, oy, w * scale, h * scale);

    const { l, t, r, b } = this.box;
    const X = (v) => ox + v * scale;
    const Y = (v) => oy + v * scale;
    // Dim everything outside the crop.
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(X(0), Y(0), w * scale, (t) * scale);
    ctx.fillRect(X(0), Y(b), w * scale, (h - b) * scale);
    ctx.fillRect(X(0), Y(t), l * scale, (b - t) * scale);
    ctx.fillRect(X(r), Y(t), (w - r) * scale, (b - t) * scale);
    // Box, rule-of-thirds guides and handles.
    ctx.strokeStyle = '#3b7cf6';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(l), Y(t), (r - l) * scale, (b - t) * scale);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const gx = X(l + ((r - l) * i) / 3);
      const gy = Y(t + ((b - t) * i) / 3);
      ctx.beginPath();
      ctx.moveTo(gx, Y(t));
      ctx.lineTo(gx, Y(b));
      ctx.moveTo(X(l), gy);
      ctx.lineTo(X(r), gy);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#3b7cf6';
    for (const [hx, hy] of [[l, t], [(l + r) / 2, t], [r, t], [r, (t + b) / 2], [r, b], [(l + r) / 2, b], [l, b], [l, (t + b) / 2]]) {
      ctx.fillRect(X(hx) - 4, Y(hy) - 4, 8, 8);
      ctx.strokeRect(X(hx) - 4, Y(hy) - 4, 8, 8);
    }
    // Size label.
    const label = `${Math.round(r - l)} × ${Math.round(b - t)} px  (de ${w} × ${h})`;
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(X(l), Math.max(0, Y(t) - 22), tw, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, X(l) + 6, Math.max(0, Y(t) - 22) + 4);
  }
}
