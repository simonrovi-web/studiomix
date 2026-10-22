// Editing on the Preview monitor: a scene's items, or the layer box of the
// input in Preview over a dimmed Program (select, move, resize, rotate with
// edge/centre snapping and guides; Alt+drag on a handle crops), plus the
// floating "Fuentes" dock for scenes and the layer toolbar.
import { layerBox } from './compositor.js';
import { INPUT_ICONS } from './inputs.js';
import { BLEND_MODES, ITEM_FITS, SceneInput, sceneContains } from './scenes.js';
import { app, byId, changed, state } from './store.js';
import { fillSelect, openPanel, toast } from './ui-common.js';
import { editInput } from './ui-inputs.js';
import { $, framedRect, h } from './util.js';

const HANDLE = 6;
const SNAP_PX = 10;
const ROTATE_OFFSET = 26;
const HANDLES = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
];
const LAYER_ITEM = 'layer';
const MIN_CROP_PX = 16;

let overlay;
let octx;
let selectedId = null;
let hoverId = null;
let drag = null;
let guides = [];
// Input whose layer box is being placed on the Preview, or null.
let layerEditId = null;

const dpr = () => window.devicePixelRatio || 1;

export function previewScene() {
  const input = byId(state.previewId);
  return state.view === 'studio' && input instanceof SceneInput ? input : null;
}

/** The input in Preview while its layer box is being placed. */
function layerInput() {
  const input = layerEditId != null && state.view === 'studio' ? byId(state.previewId) : null;
  return input?.id === layerEditId ? input : null;
}

/** The layer box seen as an editor item (reads and writes input.box). */
function layerItem(input) {
  const box = input.box;
  const item = { id: LAYER_ITEM, inputId: input.id, visible: true, locked: false };
  for (const key of ['x', 'y', 'w', 'h', 'rotation']) {
    Object.defineProperty(item, key, { get: () => box[key], set: (v) => { box[key] = v; }, enumerable: true });
  }
  return item;
}

/** What the Preview edits now: a scene's items or one layer box. */
function editTarget() {
  const scene = previewScene();
  if (scene) return { items: scene.items, scene };
  const input = layerInput();
  return input ? { items: [layerItem(input)], layer: input } : null;
}

function selectedItem(target = editTarget()) {
  return target?.items.find((i) => i.id === selectedId) ?? null;
}

// --- geometry -----------------------------------------------------------------

/** Where the preview image sits inside the overlay (object-fit: contain), in device px. */
function contentRect() {
  const W = state.settings.width;
  const H = state.settings.height;
  const scale = Math.min(overlay.width / W, overlay.height / H);
  return { ox: (overlay.width - W * scale) / 2, oy: (overlay.height - H * scale) / 2, scale, W, H };
}

/** Item box in scene pixels: centre, half sizes and angle (radians). */
function box(item) {
  const { W, H } = contentRect();
  return {
    cx: (item.x + item.w / 2) * W,
    cy: (item.y + item.h / 2) * H,
    hw: (item.w * W) / 2,
    hh: (item.h * H) / 2,
    a: (item.rotation * Math.PI) / 180,
  };
}

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

function toScreen(sx, sy) {
  const r = contentRect();
  return [r.ox + sx * r.scale, r.oy + sy * r.scale];
}

function eventToScene(e) {
  const rect = overlay.getBoundingClientRect();
  const r = contentRect();
  const px = (e.clientX - rect.left) * dpr();
  const py = (e.clientY - rect.top) * dpr();
  return [(px - r.ox) / r.scale, (py - r.oy) / r.scale];
}

function local(b, sx, sy) {
  return rot(sx - b.cx, sy - b.cy, -b.a);
}

function hitItem(target, sx, sy) {
  for (let i = target.items.length - 1; i >= 0; i--) {
    const item = target.items[i];
    if (!item.visible) continue;
    const b = box(item);
    const [lx, ly] = local(b, sx, sy);
    if (Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh) return item;
  }
  return null;
}

function hitHandle(item, sx, sy) {
  const b = box(item);
  const r = contentRect();
  const tol = ((HANDLE + 4) * dpr()) / r.scale;
  const [rx, ry] = rot(0, -b.hh - ROTATE_OFFSET / r.scale * dpr(), b.a);
  if (Math.hypot(sx - (b.cx + rx), sy - (b.cy + ry)) <= tol * 1.4) return 'rotate';
  for (const [hx, hy] of HANDLES) {
    const [dx, dy] = rot(hx * b.hw, hy * b.hh, b.a);
    if (Math.hypot(sx - (b.cx + dx), sy - (b.cy + dy)) <= tol) return [hx, hy];
  }
  return null;
}

function setBox(item, cx, cy, w, hgt) {
  const { W, H } = contentRect();
  item.w = Math.max(8, w) / W;
  item.h = Math.max(8, hgt) / H;
  item.x = cx / W - item.w / 2;
  item.y = cy / H - item.h / 2;
}

/** Axis-aligned bounds of an item (rotated boxes included), in scene px. */
function bounds(item) {
  const b = box(item);
  const xs = [];
  const ys = [];
  for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [dx, dy] = rot(hx * b.hw, hy * b.hh, b.a);
    xs.push(b.cx + dx);
    ys.push(b.cy + dy);
  }
  return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
}

/** Snaps a moving item to the canvas edges/centre and to other items' edges. */
function snapMove(target, item, dx, dy) {
  const { W, H, scale } = contentRect();
  const dist = (SNAP_PX * dpr()) / scale;
  const bb = bounds(item);
  const xTargets = [0, W / 2, W];
  const yTargets = [0, H / 2, H];
  for (const other of target.items) {
    if (other.id === item.id || !other.visible) continue;
    const o = bounds(other);
    xTargets.push(o.l, o.r);
    yTargets.push(o.t, o.b);
  }
  const best = (edges, targets) => {
    let pick = null;
    for (const e of edges) {
      for (const t of targets) {
        const d = t - e;
        if (Math.abs(d) <= dist && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d, t };
      }
    }
    return pick;
  };
  const sx = best([bb.l + dx, (bb.l + bb.r) / 2 + dx, bb.r + dx], xTargets);
  const sy = best([bb.t + dy, (bb.t + bb.b) / 2 + dy, bb.b + dy], yTargets);
  guides = [];
  if (sx) guides.push(['v', sx.t]);
  if (sy) guides.push(['h', sy.t]);
  return [dx + (sx?.d ?? 0), dy + (sy?.d ?? 0)];
}

// --- pointer interaction ---------------------------------------------------------

/** Displayed shape (width/height) of an input after its crop, zoom and rotation, if known. */
function contentAspect(input) {
  const src = input?.source?.();
  if (!src) return null;
  const r = framedRect(input.fx, src.w, src.h);
  const a = r.w / r.h;
  return input.fx.rotate % 180 ? 1 / a : a;
}

/** Shrinks a box to the picture it shows ("contain"), so cropping trims the picture, not bands. */
function fitBoxToContent(item, input) {
  const aspect = contentAspect(input);
  if (!aspect) return;
  const b = box(item);
  const bw = b.hw * 2;
  const bh = b.hh * 2;
  const [w, hgt] = bw / bh > aspect ? [bh * aspect, bh] : [bw, bw / aspect];
  if (Math.abs(w - bw) > 1 || Math.abs(hgt - bh) > 1) setBox(item, b.cx, b.cy, w, hgt);
}

/** Starts an Alt+drag crop on a handle; null when this input can't be cropped here. */
function startCrop(item, side) {
  const input = byId(item.inputId);
  if (!input?.source?.()) {
    toast('Esta fuente no se puede recortar (rótulos, colores y escenas no tienen imagen que recortar).', 'error');
    return null;
  }
  if (input.fx.rotate) {
    toast('Para recortar aquí, quita antes la rotación de 90° (⚙ → Ajuste y recorte).', 'error');
    return null;
  }
  const fit = item.id === LAYER_ITEM ? input.fit : item.fit;
  if (fit === 'contain') fitBoxToContent(item, input);
  const { cropL, cropR, cropT, cropB } = input.fx;
  return { item, handle: 'crop', side, input, box: box(item), crop: { cropL, cropR, cropT, cropB } };
}

/**
 * Moves the dragged edge(s) to the pointer and crops the picture by the same
 * amount, so what stays keeps its size and place (like cropping in OBS).
 */
function dragCrop(sx, sy) {
  const { item, side: [hx, hy], box: b, crop: c, input } = drag;
  const fx = input.fx;
  const { scale } = contentRect();
  const min = (MIN_CROP_PX * dpr()) / scale;
  const [lx, ly] = rot(sx - b.cx, sy - b.cy, -b.a);
  const zoom = Math.max(1, fx.zoom || 1);
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  let [left, right, top, bottom] = [-b.hw, b.hw, -b.hh, b.hh];
  // A mirrored picture shows its right side on the left of the box.
  const [kL, kR] = fx.flip ? ['cropR', 'cropL'] : ['cropL', 'cropR'];
  const cw = (1 - c.cropL - c.cropR) / zoom;
  const ch = (1 - c.cropT - c.cropB) / zoom;
  if (hx === -1) {
    fx[kL] = clamp(c[kL] + ((Math.min(lx, right - min) - left) / (2 * b.hw)) * cw, 1 - c[kR] - 0.02);
    left += ((fx[kL] - c[kL]) / cw) * 2 * b.hw;
  } else if (hx === 1) {
    fx[kR] = clamp(c[kR] + ((right - Math.max(lx, left + min)) / (2 * b.hw)) * cw, 1 - c[kL] - 0.02);
    right -= ((fx[kR] - c[kR]) / cw) * 2 * b.hw;
  }
  if (hy === -1) {
    fx.cropT = clamp(c.cropT + ((Math.min(ly, bottom - min) - top) / (2 * b.hh)) * ch, 1 - c.cropB - 0.02);
    top += ((fx.cropT - c.cropT) / ch) * 2 * b.hh;
  } else if (hy === 1) {
    fx.cropB = clamp(c.cropB + ((bottom - Math.max(ly, top + min)) / (2 * b.hh)) * ch, 1 - c.cropT - 0.02);
    bottom -= ((fx.cropB - c.cropB) / ch) * 2 * b.hh;
  }
  const [cx, cy] = rot((left + right) / 2, (top + bottom) / 2, b.a);
  setBox(item, b.cx + cx, b.cy + cy, right - left, bottom - top);
}

function onPointerDown(e) {
  const target = editTarget();
  if (!target || e.button !== 0) return;
  const [sx, sy] = eventToScene(e);
  const current = selectedItem(target);
  const handle = current && !current.locked ? hitHandle(current, sx, sy) : null;
  // Clicking inside the selected item keeps it, even under a full-frame layer (e.g. a title).
  const insideCurrent = current?.visible && (() => {
    const b = box(current);
    const [lx, ly] = local(b, sx, sy);
    return Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh;
  })();
  const item = handle || insideCurrent ? current : hitItem(target, sx, sy);
  selectedId = item?.id ?? null;
  renderDock();
  if (!item || item.locked) return;
  if (e.altKey && Array.isArray(handle)) {
    drag = startCrop(item, handle);
    if (!drag) return;
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone.
    }
    return;
  }
  try {
    overlay.setPointerCapture(e.pointerId);
  } catch {
    // Pointer already gone; dragging still works while it stays over the preview.
  }
  const b = box(item);
  drag = { item, handle: handle ?? 'move', start: [sx, sy], box: b, rect: { x: item.x, y: item.y, w: item.w, h: item.h }, rotation: item.rotation };
}

function onPointerMove(e) {
  const target = editTarget();
  if (!target) return;
  const [sx, sy] = eventToScene(e);
  if (!drag) {
    const item = hitItem(target, sx, sy);
    hoverId = item?.id ?? null;
    const sel = selectedItem(target);
    const handle = sel && !sel.locked ? hitHandle(sel, sx, sy) : null;
    overlay.style.cursor = handle === 'rotate' ? 'grab' : handle ? (e.altKey ? 'crosshair' : 'nwse-resize') : item && !item.locked ? 'move' : 'default';
    return;
  }
  const { item, handle, start, box: b } = drag;
  const { W, H } = contentRect();
  if (handle === 'crop') {
    dragCrop(sx, sy);
  } else if (handle === 'move') {
    let dx = sx - start[0];
    let dy = sy - start[1];
    // Restore the starting position before measuring snaps.
    Object.assign(item, drag.rect);
    if (!e.altKey) [dx, dy] = snapMove(target, item, dx, dy);
    else guides = [];
    item.x = drag.rect.x + dx / W;
    item.y = drag.rect.y + dy / H;
  } else if (handle === 'rotate') {
    const a0 = Math.atan2(start[1] - b.cy, start[0] - b.cx);
    const a1 = Math.atan2(sy - b.cy, sx - b.cx);
    let deg = drag.rotation + ((a1 - a0) * 180) / Math.PI;
    deg = ((deg % 360) + 540) % 360 - 180;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    else for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 3) deg = snap;
    item.rotation = deg;
  } else {
    // Resize in the item's own (rotated) frame, anchored at the opposite handle.
    const [hx, hy] = handle;
    const [lx, ly] = rot(sx - b.cx, sy - b.cy, -b.a);
    const ax = -hx * b.hw;
    const ay = -hy * b.hh;
    let w = hx ? Math.abs(lx - ax) : b.hw * 2;
    let hgt = hy ? Math.abs(ly - ay) : b.hh * 2;
    if (hx && hy && !e.shiftKey) {
      const s = Math.max(w / (b.hw * 2), hgt / (b.hh * 2));
      w = b.hw * 2 * s;
      hgt = b.hh * 2 * s;
    }
    const [cxl, cyl] = [ax + (hx * w) / 2, ay + (hy * hgt) / 2];
    const [cx, cy] = rot(hx ? cxl : 0, hy ? cyl : 0, b.a);
    setBox(item, b.cx + cx, b.cy + cy, w, hgt);
  }
  renderDock(true);
  renderLayerTools(true);
}

function onPointerUp(e) {
  if (!drag) return;
  try {
    overlay.releasePointerCapture(e.pointerId);
  } catch {
    // Not captured.
  }
  drag = null;
  guides = [];
  changed();
}

function onDoubleClick(e) {
  const scene = previewScene();
  if (!scene) return;
  const item = hitItem(scene, ...eventToScene(e));
  const input = item && byId(item.inputId);
  if (input) editInput(input);
}

/** Arrow keys / Delete / Escape for the selected item; returns true if handled. */
export function handleSceneKey(e) {
  const target = editTarget();
  if (target?.layer && e.key === 'Escape') {
    stopLayerEdit();
    e.preventDefault();
    return true;
  }
  const item = selectedItem(target);
  if (!item) return false;
  const { W, H } = contentRect();
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key] && !item.locked) {
    item.x += moves[e.key][0] / W;
    item.y += moves[e.key][1] / H;
  } else if (e.key === 'Delete' && target.scene) {
    target.scene.removeItem(item);
    selectedId = null;
  } else if (e.key === 'Escape') {
    selectedId = null;
  } else {
    return false;
  }
  e.preventDefault();
  changed();
  return true;
}

// --- overlay drawing ---------------------------------------------------------------

let overlayDirty = true;
let overlaySize = { width: 0, height: 0 };

function drawOverlay() {
  // The Preview moved on to another input: placing that layer is over.
  if (layerEditId != null && !layerInput()) stopLayerEdit();
  const target = editTarget();
  // Nothing to edit: clear once and skip the per-frame work entirely.
  if (!target) {
    if (overlayDirty) {
      octx.clearRect(0, 0, overlay.width, overlay.height);
      overlay.style.pointerEvents = 'none';
      overlayDirty = false;
    }
    return;
  }
  overlayDirty = true;
  overlay.style.pointerEvents = 'auto';
  const w = Math.round(overlaySize.width * dpr());
  const hgt = Math.round(overlaySize.height * dpr());
  if (overlay.width !== w || overlay.height !== hgt) {
    overlay.width = w;
    overlay.height = hgt;
  }
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const r = contentRect();
  const d = dpr();

  const outline = (item, color, width, dash = []) => {
    const b = box(item);
    octx.beginPath();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([hx, hy], i) => {
      const [dx, dy] = rot(hx * b.hw, hy * b.hh, b.a);
      const [px, py] = toScreen(b.cx + dx, b.cy + dy);
      if (i) octx.lineTo(px, py);
      else octx.moveTo(px, py);
    });
    octx.closePath();
    octx.setLineDash(dash.map((v) => v * d));
    octx.strokeStyle = color;
    octx.lineWidth = width * d;
    octx.stroke();
    octx.setLineDash([]);
  };

  for (const item of target.items) {
    if (!item.visible || item.id === selectedId) continue;
    outline(item, item.id === hoverId ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.18)', 1, [4, 4]);
  }

  const sel = selectedItem(target);
  if (sel?.visible) {
    const color = sel.locked ? '#8a93a4' : '#e5383b';
    outline(sel, color, 2);
    if (!sel.locked) {
      const b = box(sel);
      octx.fillStyle = '#fff';
      octx.strokeStyle = color;
      octx.lineWidth = 1.5 * d;
      for (const [hx, hy] of HANDLES) {
        const [dx, dy] = rot(hx * b.hw, hy * b.hh, b.a);
        const [px, py] = toScreen(b.cx + dx, b.cy + dy);
        octx.fillRect(px - HANDLE * d * 0.5, py - HANDLE * d * 0.5, HANDLE * d, HANDLE * d);
        octx.strokeRect(px - HANDLE * d * 0.5, py - HANDLE * d * 0.5, HANDLE * d, HANDLE * d);
      }
      const [tx, ty] = rot(0, -b.hh, b.a);
      const [rx, ry] = rot(0, -b.hh - (ROTATE_OFFSET / r.scale) * d, b.a);
      const [p1x, p1y] = toScreen(b.cx + tx, b.cy + ty);
      const [p2x, p2y] = toScreen(b.cx + rx, b.cy + ry);
      octx.beginPath();
      octx.moveTo(p1x, p1y);
      octx.lineTo(p2x, p2y);
      octx.stroke();
      octx.beginPath();
      octx.arc(p2x, p2y, HANDLE * d * 0.75, 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }
    const input = byId(sel.inputId);
    const bb = bounds(sel);
    const [lx, ly] = toScreen(bb.l, bb.t);
    const text = `${input?.name ?? '?'}  ${Math.round(sel.w * r.W)}×${Math.round(sel.h * r.H)}${sel.rotation ? `  ${Math.round(sel.rotation)}°` : ''}`;
    octx.font = `600 ${11 * d}px "Segoe UI", sans-serif`;
    const tw = octx.measureText(text).width + 10 * d;
    octx.fillStyle = color;
    octx.fillRect(lx, Math.max(0, ly - 18 * d), tw, 16 * d);
    octx.fillStyle = '#fff';
    octx.textBaseline = 'middle';
    octx.fillText(text, lx + 5 * d, Math.max(0, ly - 18 * d) + 8 * d);
  }

  octx.strokeStyle = '#ff3df2';
  octx.lineWidth = 1 * d;
  for (const [axis, v] of guides) {
    octx.beginPath();
    if (axis === 'v') {
      const [px] = toScreen(v, 0);
      octx.moveTo(px, r.oy);
      octx.lineTo(px, r.oy + r.H * r.scale);
    } else {
      const [, py] = toScreen(0, v);
      octx.moveTo(r.ox, py);
      octx.lineTo(r.ox + r.W * r.scale, py);
    }
    octx.stroke();
  }
}

// --- dock ----------------------------------------------------------------------------

let dockSilent = false;

function itemRow(scene, item) {
  const input = byId(item.inputId);
  const toggle = (label, title, on, fn) => h('button', { type: 'button', class: `icon ${on ? 'on' : ''}`, title, onclick: (e) => { e.stopPropagation(); fn(); changed(); } }, label);
  return h(
    'div',
    {
      class: `scene-item ${item.id === selectedId ? 'selected' : ''} ${item.visible ? '' : 'hidden-item'}`,
      onclick: () => {
        selectedId = item.id;
        renderDock();
      },
      ondblclick: () => input && editInput(input),
    },
    toggle(item.visible ? '👁' : '—', 'Mostrar u ocultar', item.visible, () => (item.visible = !item.visible)),
    toggle(item.locked ? '🔒' : '🔓', 'Bloquear', item.locked, () => (item.locked = !item.locked)),
    h('span', { class: 'scene-item-name' }, `${INPUT_ICONS[input?.type] ?? ''} ${input?.name ?? '(entrada eliminada)'}`),
    toggle('↑', 'Subir', false, () => scene.moveItem(item, 1)),
    toggle('↓', 'Bajar', false, () => scene.moveItem(item, -1)),
    toggle('✕', 'Quitar de la escena', false, () => {
      scene.removeItem(item);
      if (selectedId === item.id) selectedId = null;
    }),
  );
}

function numberField(label, value, onInput, attrs = {}) {
  return h('label', { class: 'field' }, label, h('input', { type: 'number', value: Math.round(value * 100) / 100, oninput: (e) => onInput(Number(e.target.value)), ...attrs }));
}

export function renderDock(geometryOnly = false) {
  const dlg = $('#dlg-scene');
  if (!dlg?.open || dockSilent) return;
  const scene = previewScene();
  const body = $('#scene-body');
  $('#scene-title').textContent = scene ? `Escena · ${scene.name}` : 'Fuentes de escena';
  if (!scene) {
    body.replaceChildren(h('p', { class: 'muted' }, 'Pon una escena en Preview para editarla aquí. Crea una con «+ Añadir entrada → Escena».'));
    return;
  }
  const item = selectedItem(scene);
  const { W, H } = contentRect();
  if (geometryOnly && item) {
    // Update numbers in place while dragging so focus isn't lost.
    const set = (name, v) => {
      const el = body.querySelector(`[data-geo=${name}]`);
      if (el && document.activeElement !== el) el.value = Math.round(v);
    };
    set('x', item.x * W);
    set('y', item.y * H);
    set('w', item.w * W);
    set('h', item.h * H);
    set('r', item.rotation);
    return;
  }

  const candidates = state.inputs.filter((i) => i !== scene && i.hasVideo && !sceneContains(i, scene));
  const addSelect = h('select', {}, ...candidates.map((i) => h('option', { value: i.id }, i.name)));
  const addBtn = h('button', {
    type: 'button',
    class: 'accent',
    disabled: !candidates.length,
    onclick: () => {
      const id = Number(addSelect.value);
      const first = scene.items.length === 0;
      const added = scene.addItem(id, first ? {} : { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
      selectedId = added.id;
      changed();
    },
  }, 'Añadir');

  const list = [...scene.items].reverse().map((it) => itemRow(scene, it));
  const props = [];
  if (item) {
    const geo = (name, label, value, apply) => {
      const field = numberField(label, value, (v) => {
        apply(v);
        dockSilent = true;
        changed();
        dockSilent = false;
      });
      field.querySelector('input').dataset.geo = name;
      return field;
    };
    const blend = h('select', { onchange: (e) => { item.blend = e.target.value; changed(); } });
    fillSelect(blend, Object.entries(BLEND_MODES).map(([k, [label]]) => [k, label]), item.blend);
    const fit = h('select', { onchange: (e) => { item.fit = e.target.value; changed(); } });
    fillSelect(fit, Object.entries(ITEM_FITS), item.fit);
    props.push(
      h('div', { class: 'grid-2' },
        geo('x', 'X (px)', item.x * W, (v) => (item.x = v / W)),
        geo('y', 'Y (px)', item.y * H, (v) => (item.y = v / H)),
        geo('w', 'Ancho (px)', item.w * W, (v) => (item.w = Math.max(8, v) / W)),
        geo('h', 'Alto (px)', item.h * H, (v) => (item.h = Math.max(8, v) / H)),
        geo('r', 'Rotación (°)', item.rotation, (v) => (item.rotation = v)),
        h('label', { class: 'field' }, 'Opacidad', h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: item.opacity, oninput: (e) => { item.opacity = Number(e.target.value); dockSilent = true; changed(); dockSilent = false; } })),
      ),
      h('label', { class: 'field' }, 'Modo de fusión', blend),
      h('label', { class: 'field' }, 'Encaje', fit),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => { Object.assign(item, { x: 0, y: 0, w: 1, h: 1, rotation: 0 }); changed(); } }, 'Pantalla completa'),
        h('button', { type: 'button', onclick: () => { item.x = (1 - item.w) / 2; item.y = (1 - item.h) / 2; changed(); } }, 'Centrar'),
        h('button', { type: 'button', onclick: () => { item.rotation = 0; changed(); } }, 'Sin rotación'),
      ),
    );
  }

  body.replaceChildren(
    h('label', { class: 'field' }, 'Nombre', h('input', { value: scene.name, oninput: (e) => { scene.name = e.target.value; dockSilent = true; changed(); dockSilent = false; } })),
    h('div', { class: 'row nowrap' }, addSelect, addBtn),
    h('div', { class: 'scene-items' }, list.length ? list : h('div', { class: 'muted small' }, 'Escena vacía: añade fuentes arriba.')),
    item ? h('div', { class: 'stack' }, h('h4', {}, 'Elemento seleccionado'), ...props) : h('p', { class: 'muted small' }, 'Selecciona un elemento en la lista o haz clic sobre él en Preview. Arrastra para mover, las esquinas para escalar (Shift: libre) y el círculo para rotar. Alt desactiva el imán; flechas para ajustar al píxel.'),
  );
}

/** True when the input in Preview can be placed as a free layer. */
export function layerEditable() {
  const input = byId(state.previewId);
  return state.view === 'studio' && !!input && !(input instanceof SceneInput) && input.hasVideo;
}

/** Places the input in Preview as a layer over Program, starting from its current position. */
export function startLayerEdit() {
  if (!layerEditable()) return;
  const input = byId(state.previewId);
  if (input.layout !== 'custom' || !input.box) {
    const { W, H } = { W: state.settings.width, H: state.settings.height };
    let { x, y, w, h: hgt } = layerBox(input);
    // Start with the picture's own shape inside the preset's area.
    const aspect = contentAspect(input);
    if (aspect) {
      const fitH = (w * W) / aspect / H;
      if (fitH <= hgt) {
        y += (hgt - fitH) / 2;
        hgt = fitH;
      } else {
        const fitW = (hgt * H * aspect) / W;
        x += (w - fitW) / 2;
        w = fitW;
      }
    }
    input.box = { x, y, w, h: hgt, rotation: 0 };
    input.layout = 'custom';
  }
  layerEditId = input.id;
  selectedId = LAYER_ITEM;
  app.compositor.layerEditId = input.id;
  toast('Coloca la capa: arrastra para moverla, las esquinas la escalan (Mayús: libre) y Alt+arrastrar un borde o esquina la recorta. Esc o «Listo» para terminar.');
  renderLayerTools();
  changed();
}

export function stopLayerEdit() {
  if (layerEditId == null) return;
  layerEditId = null;
  if (selectedId === LAYER_ITEM) selectedId = null;
  app.compositor.layerEditId = null;
  guides = [];
  renderLayerTools();
  changed();
}

/** Numbers and shortcuts for the layer being placed (X, Y, size, rotation). */
function renderLayerTools(geometryOnly = false) {
  const bar = $('#layer-tools');
  const input = layerInput();
  $('#btn-layer-edit')?.classList.toggle('on', !!input);
  if (!bar) return;
  bar.hidden = !input;
  if (!input) {
    bar.replaceChildren();
    return;
  }
  const W = state.settings.width;
  const H = state.settings.height;
  const b = input.box;
  if (geometryOnly) {
    for (const [name, v] of [['x', b.x * W], ['y', b.y * H], ['w', b.w * W], ['h', b.h * H]]) {
      const el = bar.querySelector(`[data-geo=${name}]`);
      if (el && document.activeElement !== el) el.value = Math.round(v);
    }
    return;
  }
  const geo = (name, label, value, apply) => {
    const field = numberField(label, value, (v) => {
      apply(v);
      changed();
    });
    field.querySelector('input').dataset.geo = name;
    return field;
  };
  const act = (label, title, fn) => h('button', { type: 'button', class: 'ghost small', title, onclick: () => { fn(); renderLayerTools(); changed(); } }, label);
  bar.replaceChildren(
    geo('x', 'X', b.x * W, (v) => (b.x = v / W)),
    geo('y', 'Y', b.y * H, (v) => (b.y = v / H)),
    geo('w', 'Ancho', b.w * W, (v) => (b.w = Math.max(8, v) / W)),
    geo('h', 'Alto', b.h * H, (v) => (b.h = Math.max(8, v) / H)),
    act('Pantalla completa', 'Ocupa todo el cuadro', () => Object.assign(b, { x: 0, y: 0, w: 1, h: 1, rotation: 0 })),
    act('Centrar', 'Centra la capa', () => Object.assign(b, { x: (1 - b.w) / 2, y: (1 - b.h) / 2 })),
    act('Sin recorte', 'Quita el recorte de esta fuente', () => Object.assign(input.fx, { cropL: 0, cropR: 0, cropT: 0, cropB: 0 })),
    h('button', { type: 'button', class: 'accent small', onclick: stopLayerEdit }, 'Listo'),
  );
}

export function openSceneDock() {
  const dlg = $('#dlg-scene');
  openPanel(dlg);
  renderDock();
}

export function initSceneEditor() {
  overlay = $('#preview-overlay');
  octx = overlay.getContext('2d');
  new ResizeObserver(([entry]) => {
    overlaySize = { width: entry.contentRect.width, height: entry.contentRect.height };
  }).observe(overlay);
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('dblclick', onDoubleClick);
  overlay.addEventListener('pointerleave', () => {
    hoverId = null;
  });
  $('#btn-scene-dock').addEventListener('click', openSceneDock);
  $('#btn-layer-edit').addEventListener('click', () => (layerEditId != null ? stopLayerEdit() : startLayerEdit()));
  $('#btn-close-scene').addEventListener('click', () => $('#dlg-scene').close());
  app.compositor.onFrame = () => {
    if (!document.hidden) drawOverlay();
  };
}
