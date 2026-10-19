export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

export function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}`;
}

export function hexToRgba(hex, alpha = 1) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/**
 * Draws the source rect (sx, sy, sw, sh) of `src` into the destination rect,
 * honouring contain/cover/stretch, a rotation in 90° steps and a horizontal mirror.
 */
export function drawFitted(ctx, src, sx, sy, sw, sh, x, y, w, h, fit = 'contain', flip = false, rotate = 0) {
  if (!sw || !sh || w <= 0 || h <= 0) return;
  const quarter = (((Math.round(rotate / 90) % 4) + 4) % 4);
  const sideways = quarter % 2 === 1;
  // Size of the source as it appears on screen (after rotation).
  let vw = sideways ? sh : sw;
  let vh = sideways ? sw : sh;
  let dw = w;
  let dh = h;
  if (fit === 'cover') {
    const scale = Math.max(w / vw, h / vh);
    const keepW = w / scale;
    const keepH = h / scale;
    // Trim the source along the axes that map to the visible width/height.
    const trimX = sideways ? vh - keepH : vw - keepW;
    const trimY = sideways ? vw - keepW : vh - keepH;
    sx += trimX / 2;
    sy += trimY / 2;
    sw -= trimX;
    sh -= trimY;
    vw = keepW;
    vh = keepH;
  } else if (fit === 'contain') {
    const scale = Math.min(w / vw, h / vh);
    dw = vw * scale;
    dh = vh * scale;
  }
  if (!quarter && !flip) {
    ctx.drawImage(src, sx, sy, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    return;
  }
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (flip) ctx.scale(-1, 1);
  ctx.rotate((quarter * Math.PI) / 2);
  const bw = sideways ? dh : dw;
  const bh = sideways ? dw : dh;
  ctx.drawImage(src, sx, sy, sw, sh, -bw / 2, -bh / 2, bw, bh);
  ctx.restore();
}

/**
 * Source rect after the input's crop, zoom and pan settings (in source pixels).
 * Shared by the renderer and the crop editor so both agree.
 */
export function framedRect(fx, sw, sh) {
  const sx = sw * fx.cropL;
  const sy = sh * fx.cropT;
  const cw = Math.max(1, sw * (1 - fx.cropL - fx.cropR));
  const ch = Math.max(1, sh * (1 - fx.cropT - fx.cropB));
  const zoom = Math.max(1, fx.zoom || 1);
  const zw = cw / zoom;
  const zh = ch / zoom;
  return {
    x: sx + ((cw - zw) * (1 + (fx.panX || 0))) / 2,
    y: sy + ((ch - zh) * (1 + (fx.panY || 0))) / 2,
    w: zw,
    h: zh,
  };
}

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function drawChecker(ctx, x, y, w, h) {
  const size = Math.max(6, Math.round(h / 12));
  ctx.fillStyle = '#2a2d35';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#353943';
  for (let row = 0; row * size < h; row++) {
    for (let col = row % 2; col * size < w; col += 2) {
      ctx.fillRect(x + col * size, y + row * size, Math.min(size, w - col * size), Math.min(size, h - row * size));
    }
  }
}

export function drawPlaceholder(ctx, x, y, w, h, icon, label) {
  ctx.fillStyle = '#1b1e25';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#7d8699';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(h * 0.3)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
  ctx.fillText(icon, x + w / 2, y + h * 0.42);
  if (label) {
    ctx.font = `600 ${Math.max(10, Math.round(h * 0.09))}px "Segoe UI", sans-serif`;
    ctx.fillText(label, x + w / 2, y + h * 0.78, w * 0.9);
  }
}
