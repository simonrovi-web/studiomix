// Scenes: an input made of layered items, each showing another input inside a
// transformable box (position, size, rotation, opacity, blend mode).
import { Input } from './inputs.js';
import { byId, state } from './store.js';
import { drawChecker } from './util.js';

export const BLEND_MODES = {
  normal: ['Normal', 'source-over'],
  add: ['Aditivo', 'lighter'],
  screen: ['Trama', 'screen'],
  multiply: ['Multiplicar', 'multiply'],
  overlay: ['Superponer', 'overlay'],
  lighten: ['Aclarar', 'lighten'],
  darken: ['Oscurecer', 'darken'],
  difference: ['Diferencia', 'difference'],
};

export const ITEM_FITS = {
  contain: 'Ajustar dentro de la caja',
  cover: 'Rellenar la caja (recortar)',
  stretch: 'Estirar a la caja',
};

const MAX_DEPTH = 4;
let itemSeq = 0;
let depth = 0;

export class SceneItem {
  constructor(inputId, rect = {}) {
    this.id = ++itemSeq;
    this.inputId = inputId;
    // Box in canvas fractions (0–1), rotation in degrees around the box centre.
    this.x = rect.x ?? 0;
    this.y = rect.y ?? 0;
    this.w = rect.w ?? 1;
    this.h = rect.h ?? 1;
    this.rotation = rect.rotation ?? 0;
    this.opacity = rect.opacity ?? 1;
    this.blend = rect.blend ?? 'normal';
    this.fit = rect.fit ?? 'contain';
    this.visible = rect.visible ?? true;
    this.locked = rect.locked ?? false;
  }

  serialize(inputs) {
    const { x, y, w, h, rotation, opacity, blend, fit, visible, locked } = this;
    return { input: inputs.findIndex((i) => i.id === this.inputId), x, y, w, h, rotation, opacity, blend, fit, visible, locked };
  }
}

/** True if `scene` shows `target` somewhere in its tree (prevents loops). */
export function sceneContains(scene, target, seen = new Set()) {
  if (scene === target) return true;
  if (!(scene instanceof SceneInput) || seen.has(scene)) return false;
  seen.add(scene);
  return scene.items.some((item) => sceneContains(byId(item.inputId), target, seen));
}

export class SceneInput extends Input {
  constructor(name) {
    super('scene', name || 'Escena');
    this.items = []; // bottom → top
    this.pendingItems = null;
  }

  get transparent() {
    return true;
  }

  addItem(inputId, rect) {
    const item = new SceneItem(inputId, rect);
    this.items.push(item);
    return item;
  }

  removeItem(item) {
    this.items = this.items.filter((i) => i !== item);
  }

  /** Moves an item one step up (+1) or down (-1) in the stack. */
  moveItem(item, delta) {
    const i = this.items.indexOf(item);
    const j = Math.min(this.items.length - 1, Math.max(0, i + delta));
    if (i < 0 || i === j) return;
    this.items.splice(i, 1);
    this.items.splice(j, 0, item);
  }

  /** Visible inputs with their effective opacity, for audio-follows-video. */
  visibleInputs(weight = 1, out = new Map()) {
    if (depth > MAX_DEPTH) return out;
    depth++;
    try {
      for (const item of this.items) {
        const input = byId(item.inputId);
        if (!item.visible || !input || input === this) continue;
        const w = weight * item.opacity;
        out.set(input.id, Math.max(out.get(input.id) ?? 0, w));
        if (input instanceof SceneInput) input.visibleInputs(w, out);
      }
    } finally {
      depth--;
    }
    return out;
  }

  draw(ctx, x, y, w, h, time, mode, frame = -1, anim = 1) {
    if (mode !== 'program') drawChecker(ctx, x, y, w, h);
    if (depth > MAX_DEPTH) return;
    depth++;
    try {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      for (const item of this.items) {
        const input = byId(item.inputId);
        if (!item.visible || !input || input === this) continue;
        const iw = item.w * w;
        const ih = item.h * h;
        ctx.save();
        ctx.globalAlpha *= item.opacity;
        ctx.globalCompositeOperation = BLEND_MODES[item.blend]?.[1] ?? 'source-over';
        ctx.translate(x + item.x * w + iw / 2, y + item.y * h + ih / 2);
        if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);
        const fit = input.fit;
        input.fit = item.fit;
        try {
          // Children draw as on Program: no checkerboards or placeholders inside a scene.
          input.draw(ctx, -iw / 2, -ih / 2, iw, ih, time, 'program', frame, anim);
        } finally {
          input.fit = fit;
          ctx.restore();
        }
      }
      ctx.restore();
    } finally {
      depth--;
    }
  }

  serialize() {
    return { ...super.serialize(), items: this.items.map((item) => item.serialize(state.inputs)) };
  }

  restore(data) {
    super.restore(data);
    this.pendingItems = Array.isArray(data.items) ? data.items : null;
  }

  /** Second pass of project loading, once every input exists: map indexes to ids. */
  resolveItems(created) {
    if (!this.pendingItems) return;
    for (const raw of this.pendingItems) {
      const input = created[raw.input];
      if (input) this.addItem(input.id, raw);
    }
    this.pendingItems = null;
  }
}
