// Drawing helpers shared by the title templates (titles.js, title-styles.js).

import { hexToRgba } from './util.js';

export const SANS = '"Segoe UI", system-ui, sans-serif';
export const SERIF = 'Georgia, "Times New Roman", serif';

export const font = (weight, px, family = SANS) => `${weight} ${Math.round(px)}px ${family}`;
export const easeOut = (p) => 1 - (1 - p) ** 3;
/** Ease-out that overshoots a little before settling (lively entries). */
export const easeOutBack = (p) => 1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2;
export const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function measure(ctx, text, f) {
  ctx.font = f;
  return text ? ctx.measureText(String(text)).width : 0;
}

/** Panel colour from the title's background colour and opacity. */
export function panel(ctx, t) {
  return hexToRgba(t.bgColor, t.bgOpacity);
}

export function mmss(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/** Splits text into at most `maxLines` lines that fit `width` (adds … if cut). */
export function wrap(ctx, text, width, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= width || !line) line = test;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (line && lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/** Filled rounded rectangle. */
export function roundBox(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}
