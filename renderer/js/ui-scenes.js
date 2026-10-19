// Scene editing on the Preview monitor (select, move, resize, rotate with
// edge/centre snapping and guides) plus the floating "Fuentes" dock.
import { INPUT_ICONS } from './inputs.js';
import { BLEND_MODES, ITEM_FITS, SceneInput, sceneContains } from './scenes.js';
import { app, byId, changed, state } from './store.js';
import { fillSelect, openPanel } from './ui-common.js';
import { editInput } from './ui-inputs.js';
import { $, h } from './util.js';

const HANDLE = 6;
const SNAP_PX = 10;
const ROTATE_OFFSET = 26;
const HANDLES = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
];

let overlay;
let octx;
let selectedId = null;
let hoverId = null;
let drag = null;
let guides = [];

const dpr = () => window.devicePixelRatio || 1;

export function previewScene() {
  const input = byId(state.previewId);
  return state.view === 'studio' && input instanceof SceneInput ? input : null;
}

function selectedItem(scene = previewScene()) {
  return scene?.items.find((i) => i.id === selectedId) ?? null;
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

function hitItem(scene, sx, sy) {
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const item = scene.items[i];
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
function snapMove(scene, item, dx, dy) {
  const { W, H, scale } = contentRect();
  const dist = (SNAP_PX * dpr()) / scale;
  const bb = bounds(item);
  const xTargets = [0, W / 2, W];
  const yTargets = [0, H / 2, H];
  for (const other of scene.items) {
    if (other === item || !other.visible) continue;
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

function onPointerDown(e) {
  const scene = previewScene();
  if (!scene || e.button !== 0) return;
  const [sx, sy] = eventToScene(e);
  const current = selectedItem(scene);
  const handle = current && !current.locked ? hitHandle(current, sx, sy) : null;
  // Clicking inside the selected item keeps it, even under a full-frame layer (e.g. a title).
  const insideCurrent = current?.visible && (() => {
    const b = box(current);
    const [lx, ly] = local(b, sx, sy);
    return Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh;
  })();
  const item = handle || insideCurrent ? current : hitItem(scene, sx, sy);
  selectedId = item?.id ?? null;
  renderDock();
  if (!item || item.locked) return;
  try {
    overlay.setPointerCapture(e.pointerId);
  } catch {
    // Pointer already gone; dragging still works while it stays over the preview.
  }
  const b = box(item);
  drag = { item, handle: handle ?? 'move', start: [sx, sy], box: b, rect: { x: item.x, y: item.y, w: item.w, h: item.h }, rotation: item.rotation };
}

function onPointerMove(e) {
  const scene = previewScene();
  if (!scene) return;
  const [sx, sy] = eventToScene(e);
  if (!drag) {
    const item = hitItem(scene, sx, sy);
    hoverId = item?.id ?? null;
    const sel = selectedItem(scene);
    const handle = sel && !sel.locked ? hitHandle(sel, sx, sy) : null;
    overlay.style.cursor = handle === 'rotate' ? 'grab' : handle ? 'nwse-resize' : item && !item.locked ? 'move' : 'default';
    return;
  }
  const { item, handle, start, box: b } = drag;
  const { W, H } = contentRect();
  if (handle === 'move') {
    let dx = sx - start[0];
    let dy = sy - start[1];
    // Restore the starting position before measuring snaps.
    Object.assign(item, drag.rect);
    if (!e.altKey) [dx, dy] = snapMove(scene, item, dx, dy);
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
  const scene = previewScene();
  const item = selectedItem(scene);
  if (!item) return false;
  const { W, H } = contentRect();
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key] && !item.locked) {
    item.x += moves[e.key][0] / W;
    item.y += moves[e.key][1] / H;
  } else if (e.key === 'Delete') {
    scene.removeItem(item);
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
  const scene = previewScene();
  // Nothing to edit: clear once and skip the per-frame work entirely.
  if (!scene) {
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

  for (const item of scene.items) {
    if (!item.visible || item.id === selectedId) continue;
    outline(item, item.id === hoverId ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.18)', 1, [4, 4]);
  }

  const sel = selectedItem(scene);
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
  $('#btn-close-scene').addEventListener('click', () => $('#dlg-scene').close());
  app.compositor.onFrame = () => {
    if (!document.hidden) drawOverlay();
  };
}
