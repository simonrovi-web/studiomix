// More title styles: news bar, glass, neon, pop, elegant, quote, interview,
// call to action and section tag. Same contract as TITLE_TEMPLATES in
// titles.js: draw(ctx, x, y, w, h, fields, { time, anim, elapsed }), sizes
// authored for 1080p and scaled to the target rect, anim 0→1 on entry.

import { SERIF, clamp01, drawLogo, easeOut, easeOutBack, font, logoWidth, measure, panel, roundBox, wrap } from './title-kit.js';
import { hexToRgba } from './util.js';

const upper = (v) => String(v ?? '').toUpperCase();

/** Name tag used by the interview style; `side` is 'left' or 'right'. */
function nameTag(ctx, x, y, w, h, s, name, role, t, side, reveal) {
  const nameFont = font(700, 46 * s);
  const roleFont = font(400, 30 * s);
  const pad = 26 * s;
  const width = Math.max(measure(ctx, name, nameFont), measure(ctx, role, roleFont)) + pad * 2;
  const height = (role ? 122 : 80) * s;
  const by = y + h - 110 * s - height;
  const bx = side === 'left' ? x + 90 * s : x + w - 90 * s - width;
  const shown = width * reveal;
  const clipX = side === 'left' ? bx : bx + width - shown;
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX - 10 * s, by, shown + 10 * s, height);
  ctx.clip();
  ctx.fillStyle = panel(ctx, t);
  ctx.fillRect(bx, by, width, height);
  ctx.fillStyle = t.accent;
  ctx.fillRect(side === 'left' ? bx : bx + width - 8 * s, by, 8 * s, height);
  ctx.fillStyle = t.textColor;
  ctx.textAlign = side === 'left' ? 'left' : 'right';
  ctx.textBaseline = 'top';
  const tx = side === 'left' ? bx + pad : bx + width - pad;
  ctx.font = nameFont;
  ctx.fillText(name, tx, by + 16 * s);
  if (role) {
    ctx.font = roleFont;
    ctx.globalAlpha *= 0.8;
    ctx.fillText(role, tx, by + 74 * s);
  }
  ctx.restore();
}

/** A simple bell (for the call-to-action button). */
function bell(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.75, cy + r * 0.45);
  ctx.quadraticCurveTo(cx - r * 0.7, cy - r * 0.85, cx, cy - r * 0.9);
  ctx.quadraticCurveTo(cx + r * 0.7, cy - r * 0.85, cx + r * 0.75, cy + r * 0.45);
  ctx.lineTo(cx + r * 0.95, cy + r * 0.62);
  ctx.lineTo(cx - r * 0.95, cy + r * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.78, r * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

export const TITLE_STYLES = {
  news: {
    label: 'Noticiero (barra completa con hora)',
    uses: ['title', 'subtitle'],
    labels: { title: 'Titular', subtitle: 'Etiqueta (p. ej. ÚLTIMA HORA)' },
    logo: 'optional',
    draw(ctx, x, y, w, h, t, { anim, logo }) {
      const s = h / 1080;
      const barH = 112 * s;
      const by = y + h - 150 * s - barH;
      const grow = easeOut(clamp01(anim * 1.6));
      const textAlpha = clamp01((anim - 0.4) / 0.6);
      const labelFont = font(800, 34 * s);
      const titleFont = font(700, 50 * s);
      const clockFont = font(700, 38 * s);
      const labelW = t.subtitle ? measure(ctx, upper(t.subtitle), labelFont) + 60 * s : 0;
      const clockW = 170 * s;
      const left = x + 60 * s;
      const full = w - 120 * s;
      // Optional channel logo at the start of the bar, before the label.
      const logoW = logo ? logoWidth(logo, barH - 28 * s, false) + 40 * s : 0;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(left, by, full * grow, barH);
      if (labelW) {
        ctx.fillStyle = t.accent;
        ctx.fillRect(left + logoW, by, Math.max(0, Math.min(labelW, full * grow - logoW)), barH);
      }
      // Clock block on the right.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (grow > 0.98) ctx.fillRect(left + full - clockW, by, clockW, barH);
      ctx.globalAlpha *= textAlpha;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      if (logoW) drawLogo(ctx, logo, left + 20 * s, by + 14 * s, logoW - 40 * s, barH - 28 * s, 'center');
      if (labelW) {
        ctx.font = labelFont;
        ctx.textAlign = 'center';
        ctx.fillText(upper(t.subtitle), left + logoW + labelW / 2, by + barH / 2);
      }
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.font = titleFont;
      const tx = left + logoW + labelW + 34 * s;
      const maxTitle = full - logoW - labelW - clockW - 60 * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(tx, by, maxTitle, barH);
      ctx.clip();
      ctx.fillText(t.title, tx, by + barH / 2);
      ctx.restore();
      const now = new Date();
      ctx.font = clockFont;
      ctx.textAlign = 'center';
      ctx.fillText(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, left + full - clockW / 2, by + barH / 2);
    },
  },

  glass: {
    label: 'Cristal minimalista',
    uses: ['title', 'subtitle'],
    logo: 'optional',
    draw(ctx, x, y, w, h, t, { anim, logo }) {
      const s = h / 1080;
      const titleFont = font(600, 50 * s);
      const subFont = font(400, 30 * s);
      const pad = 36 * s;
      ctx.letterSpacing = `${1.5 * s}px`;
      const height = (t.subtitle ? 140 : 96) * s;
      // With a logo it takes the place of the accent dot.
      const lw = logo ? logoWidth(logo, height - 40 * s, false) : 0;
      const lead = lw ? lw + 26 * s : 30 * s;
      const width = Math.max(measure(ctx, t.title, titleFont), measure(ctx, t.subtitle, subFont)) + pad * 2 + lead;
      const bx = x + 100 * s;
      const by = y + h - 120 * s - height + (1 - easeOut(anim)) * 40 * s;
      ctx.globalAlpha *= easeOut(anim);
      const g = ctx.createLinearGradient(0, by, 0, by + height);
      g.addColorStop(0, hexToRgba(t.bgColor, Math.min(1, t.bgOpacity + 0.1)));
      g.addColorStop(1, hexToRgba(t.bgColor, Math.max(0, t.bgOpacity - 0.25)));
      roundBox(ctx, bx, by, width, height, height / 2.4, g);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5 * s;
      ctx.stroke();
      if (lw) {
        drawLogo(ctx, logo, bx + pad - 6 * s, by + 20 * s, lw, height - 40 * s, 'left');
      } else {
        ctx.fillStyle = t.accent;
        ctx.beginPath();
        ctx.arc(bx + pad, by + height / 2, 7 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tx = bx + pad + lead - (lw ? 6 * s : 0);
      ctx.font = titleFont;
      ctx.fillText(t.title, tx, t.subtitle ? by + 50 * s : by + height / 2);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.globalAlpha *= 0.75;
        ctx.fillText(t.subtitle, tx, by + 100 * s);
      }
    },
  },

  neon: {
    label: 'Neón (gaming)',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim, time }) {
      const s = h / 1080;
      const titleFont = font(900, 58 * s);
      const subFont = font(600, 30 * s);
      const pad = 36 * s;
      ctx.letterSpacing = `${3 * s}px`;
      const title = upper(t.title);
      const width = Math.max(measure(ctx, title, titleFont), measure(ctx, upper(t.subtitle), subFont)) + pad * 2;
      const height = (t.subtitle ? 150 : 104) * s;
      const bx = x + 100 * s;
      const by = y + h - 120 * s - height;
      // Switch-on flicker during the entry, then a slow glow.
      const flicker = anim < 1 ? (Math.sin(anim * 40) > -0.2 ? anim : anim * 0.3) : 1;
      const glow = 0.8 + 0.2 * Math.sin(time / 600);
      ctx.globalAlpha *= flicker;
      roundBox(ctx, bx, by, width, height, 14 * s, panel(ctx, t));
      ctx.shadowColor = t.accent;
      ctx.shadowBlur = 28 * s * glow;
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 4 * s;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = titleFont;
      ctx.fillStyle = t.textColor;
      ctx.shadowBlur = 22 * s * glow;
      ctx.fillText(title, bx + pad, t.subtitle ? by + 54 * s : by + height / 2);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.fillStyle = t.accent;
        ctx.shadowBlur = 12 * s;
        ctx.fillText(upper(t.subtitle), bx + pad, by + 112 * s);
      }
    },
  },

  pop: {
    label: 'Pop inclinado (deportes, jóvenes)',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const titleFont = `italic ${font(900, 62 * s)}`;
      const subFont = `italic ${font(700, 32 * s)}`;
      const pad = 40 * s;
      const title = upper(t.title);
      const sub = upper(t.subtitle);
      const tw = measure(ctx, title, titleFont) + pad * 2;
      const sw = sub ? measure(ctx, sub, subFont) + pad * 2 : 0;
      const bx = x + 120 * s;
      const by = y + h - 300 * s;
      const p1 = easeOutBack(clamp01(anim * 1.3));
      const p2 = easeOutBack(clamp01(anim * 1.3 - 0.25));
      ctx.transform(1, 0, -0.18, 1, 0, 0); // lean right
      const skewFix = 0.18 * (by + 60 * s);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx + skewFix - (1 - p1) * (tw + 200 * s), by, tw, 104 * s);
      if (sub) {
        ctx.fillStyle = panel(ctx, t);
        ctx.fillRect(bx + skewFix + 30 * s - (1 - p2) * (sw + 260 * s), by + 104 * s, sw, 60 * s);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = t.textColor;
      ctx.font = titleFont;
      ctx.fillText(title, bx + skewFix + pad - (1 - p1) * (tw + 200 * s), by + 54 * s);
      if (sub) {
        ctx.font = subFont;
        ctx.fillText(sub, bx + skewFix + 30 * s + pad - (1 - p2) * (sw + 260 * s), by + 136 * s);
      }
    },
  },

  elegant: {
    label: 'Elegante (bodas y eventos)',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const cx = x + w / 2;
      const baseY = y + h - 190 * s;
      // Soft dark fade at the bottom so the text reads on any picture.
      if (t.bgOpacity > 0) {
        const g = ctx.createLinearGradient(0, y + h - 420 * s, 0, y + h);
        g.addColorStop(0, hexToRgba(t.bgColor, 0));
        g.addColorStop(1, hexToRgba(t.bgColor, t.bgOpacity * 0.85 * easeOut(anim)));
        ctx.fillStyle = g;
        ctx.fillRect(x, y + h - 420 * s, w, 420 * s);
      }
      const textAlpha = clamp01((anim - 0.25) / 0.75);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.save();
      ctx.fillStyle = t.textColor;
      ctx.globalAlpha *= textAlpha;
      ctx.font = `italic ${font(400, 76 * s, SERIF)}`;
      ctx.fillText(t.title, cx, baseY);
      ctx.restore();
      if (t.subtitle) {
        ctx.letterSpacing = `${5 * s}px`;
        const subFont = font(600, 32 * s);
        const sub = upper(t.subtitle);
        const sw = measure(ctx, sub, subFont);
        const line = (160 * s) * easeOut(anim);
        const ly = baseY + 58 * s;
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.moveTo(cx - sw / 2 - 30 * s, ly - 9 * s);
        ctx.lineTo(cx - sw / 2 - 30 * s - line, ly - 9 * s);
        ctx.moveTo(cx + sw / 2 + 30 * s, ly - 9 * s);
        ctx.lineTo(cx + sw / 2 + 30 * s + line, ly - 9 * s);
        ctx.stroke();
        ctx.globalAlpha *= textAlpha;
        ctx.fillStyle = t.accent;
        ctx.fillText(sub, cx, ly);
      }
    },
  },

  quote: {
    label: 'Cita destacada',
    uses: ['title', 'subtitle'],
    labels: { title: 'Cita', subtitle: 'Autor' },
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const quoteFont = `italic ${font(400, 54 * s, SERIF)}`;
      const maxW = Math.min(w - 240 * s, 1300 * s);
      ctx.font = quoteFont;
      const lines = wrap(ctx, t.title, maxW - 140 * s, 4);
      const boxH = 120 * s + lines.length * 72 * s + (t.subtitle ? 70 * s : 0);
      const bx = x + (w - maxW) / 2;
      const by = y + (h - boxH) / 2;
      const zoom = 0.94 + 0.06 * easeOut(anim);
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-(x + w / 2), -(y + h / 2));
      ctx.globalAlpha *= easeOut(anim);
      roundBox(ctx, bx, by, maxW, boxH, 18 * s, panel(ctx, t));
      ctx.fillStyle = t.accent;
      ctx.font = font(700, 200 * s, SERIF);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('“', bx + 30 * s, by - 20 * s);
      ctx.fillStyle = t.textColor;
      ctx.font = quoteFont;
      lines.forEach((l, i) => ctx.fillText(l, bx + 140 * s, by + 60 * s + i * 72 * s));
      if (t.subtitle) {
        ctx.font = font(700, 32 * s);
        ctx.fillStyle = t.accent;
        ctx.fillText(`— ${t.subtitle}`, bx + 140 * s, by + 70 * s + lines.length * 72 * s);
      }
    },
  },

  interview: {
    label: 'Entrevista (dos nombres)',
    uses: ['title', 'subtitle', 'teamA', 'teamB'],
    labels: { title: 'Nombre (izquierda)', subtitle: 'Cargo (izquierda)', teamA: 'Nombre (derecha)', teamB: 'Cargo (derecha)' },
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      nameTag(ctx, x, y, w, h, s, t.title, t.subtitle, t, 'left', easeOut(clamp01(anim * 1.4)));
      if (t.teamA) nameTag(ctx, x, y, w, h, s, t.teamA, t.teamB, t, 'right', easeOut(clamp01(anim * 1.4 - 0.3)));
    },
  },

  subscribe: {
    label: 'Llamada a la acción (suscríbete)',
    uses: ['title', 'subtitle'],
    labels: { title: 'Texto del botón', subtitle: 'Texto pequeño' },
    draw(ctx, x, y, w, h, t, { anim, time }) {
      const s = h / 1080;
      const btnFont = font(800, 44 * s);
      const subFont = font(500, 30 * s);
      const label = upper(t.title);
      const bw = measure(ctx, label, btnFont) + 150 * s;
      const bh = 96 * s;
      const bx = x + 110 * s;
      const by = y + h - 150 * s - bh;
      const pop = easeOutBack(clamp01(anim));
      ctx.translate(bx + bw / 2, by + bh / 2);
      ctx.scale(pop, pop);
      ctx.translate(-(bx + bw / 2), -(by + bh / 2));
      // A ring pulses out of the button every 2 s.
      const phase = (time % 2000) / 2000;
      if (anim >= 1) {
        ctx.save();
        ctx.globalAlpha *= (1 - phase) * 0.6;
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = 4 * s;
        ctx.beginPath();
        ctx.roundRect(bx - phase * 24 * s, by - phase * 24 * s, bw + phase * 48 * s, bh + phase * 48 * s, (bh + phase * 48 * s) / 2);
        ctx.stroke();
        ctx.restore();
      }
      roundBox(ctx, bx, by, bw, bh, bh / 2, t.accent);
      const swing = anim >= 1 ? Math.sin(time / 90) * Math.max(0, 1 - phase * 3) * 0.35 : 0;
      ctx.save();
      ctx.translate(bx + 56 * s, by + bh / 2 - 26 * s);
      ctx.rotate(swing);
      bell(ctx, 0, 26 * s, 26 * s, t.textColor);
      ctx.restore();
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = btnFont;
      ctx.fillText(label, bx + 100 * s, by + bh / 2 + 2 * s);
      if (t.subtitle) {
        ctx.font = subFont;
        const sw = measure(ctx, t.subtitle, subFont) + 40 * s;
        roundBox(ctx, bx + 20 * s, by + bh + 14 * s, sw, 50 * s, 12 * s, panel(ctx, t));
        ctx.fillStyle = t.textColor;
        ctx.fillText(t.subtitle, bx + 40 * s, by + bh + 40 * s);
      }
    },
  },

  sectionTag: {
    label: 'Etiqueta superior (sección o EN DIRECTO)',
    uses: ['title'],
    logo: 'optional',
    draw(ctx, x, y, w, h, t, { anim, time, logo }) {
      const s = h / 1080;
      const tagFont = font(800, 32 * s);
      ctx.letterSpacing = `${2 * s}px`;
      const label = upper(t.title);
      const th = 64 * s;
      // A logo goes first; the live dot stays after it.
      const lw = logo ? logoWidth(logo, th - 20 * s, false) + 18 * s : 0;
      const tw = measure(ctx, label, tagFont) + 100 * s + lw;
      const bx = x + 60 * s;
      const by = y + 50 * s - (1 - easeOut(anim)) * 120 * s;
      roundBox(ctx, bx, by, tw, th, 8 * s, panel(ctx, t));
      if (lw) drawLogo(ctx, logo, bx + 16 * s, by + 10 * s, lw - 18 * s, th - 20 * s, 'left');
      // Pulsing dot, like a "live" light.
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(time / 500));
      ctx.fillStyle = t.accent;
      ctx.globalAlpha *= pulse;
      ctx.beginPath();
      ctx.arc(bx + lw + 36 * s, by + th / 2, 11 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha /= pulse;
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = tagFont;
      ctx.fillText(label, bx + lw + 66 * s, by + th / 2 + 1 * s);
    },
  },
};

/** Starting text and colours for each style when it is picked in the editor. */
export const STYLE_PRESETS = {
  news: { title: 'Aquí va el titular de la noticia', subtitle: 'Última hora', accent: '#d7263d', bgColor: '#0b1d3a', bgOpacity: 0.95, textColor: '#ffffff' },
  glass: { title: 'Nombre Apellido', subtitle: 'Cargo o descripción', accent: '#7dd3fc', bgColor: '#1b2333', bgOpacity: 0.55, textColor: '#ffffff' },
  neon: { title: 'Jugador 1', subtitle: 'En directo', accent: '#00e5ff', bgColor: '#05060a', bgOpacity: 0.85, textColor: '#ffffff' },
  pop: { title: '¡Golazo!', subtitle: 'Minuto 23', accent: '#ffcc00', textColor: '#111111', bgColor: '#ffffff', bgOpacity: 1 },
  elegant: { title: 'Laura y Daniel', subtitle: '12 de octubre de 2026', accent: '#d4af37', bgColor: '#000000', bgOpacity: 0.6, textColor: '#ffffff' },
  quote: { title: 'La creatividad es la inteligencia divirtiéndose.', subtitle: 'Albert Einstein', accent: '#f2b33d', bgColor: '#101218', bgOpacity: 0.85, textColor: '#ffffff' },
  interview: { title: 'Ana García', subtitle: 'Presentadora', teamA: 'Luis Pérez', teamB: 'Invitado especial', textColor: '#ffffff' },
  subscribe: { title: 'Suscríbete', subtitle: 'y activa la campanita', accent: '#e62117', bgColor: '#101218', bgOpacity: 0.8, textColor: '#ffffff' },
  sectionTag: { title: 'En directo', accent: '#e62117', bgColor: '#101218', bgOpacity: 0.85, textColor: '#ffffff' },
};
