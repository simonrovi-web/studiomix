import { hexToRgba } from './util.js';

const font = (weight, px) => `${weight} ${Math.round(px)}px "Segoe UI", system-ui, sans-serif`;
const easeOut = (p) => 1 - (1 - p) ** 3;

function measure(ctx, text, f) {
  ctx.font = f;
  return text ? ctx.measureText(String(text)).width : 0;
}

function panel(ctx, t) {
  return hexToRgba(t.bgColor, t.bgOpacity);
}

function mmss(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/**
 * Title templates draw on a transparent layer (unless `opaque`).
 * draw(ctx, x, y, w, h, fields, env) with env = { time, anim, elapsed }:
 *  - anim 0–1 is the entry animation (overlay fade-in), 1 when fully shown,
 *  - elapsed is the input's stopwatch in ms (scoreboards and countdowns).
 * Sizes are authored for 1080p and scaled to the target rect.
 * `uses` lists the editor fields; `labels` renames them for the template.
 */
export const TITLE_TEMPLATES = {
  lowerThird: {
    label: 'Rótulo inferior',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const titleFont = font(700, 54 * s);
      const subFont = font(400, 34 * s);
      const pad = 30 * s;
      const width = Math.max(measure(ctx, t.title, titleFont), measure(ctx, t.subtitle, subFont)) + pad * 2;
      const height = (t.subtitle ? 150 : 98) * s;
      const bx = x + 110 * s;
      const by = y + h - 120 * s - height;
      ctx.translate(-(1 - easeOut(anim)) * (width + 160 * s), 0);
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, width, height);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx - 14 * s, by, 14 * s, height);
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = titleFont;
      ctx.fillText(t.title, bx + pad, by + 18 * s);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.globalAlpha *= 0.85;
        ctx.fillText(t.subtitle, bx + pad, by + 90 * s);
      }
    },
  },

  modern: {
    label: 'Rótulo moderno (dos franjas)',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const titleFont = font(800, 58 * s);
      const subFont = font(600, 30 * s);
      const pad = 34 * s;
      const tw = measure(ctx, t.title, titleFont) + pad * 2;
      const sw = measure(ctx, String(t.subtitle || '').toUpperCase(), subFont) + pad * 2;
      const bx = x + 100 * s;
      const by = y + h - 270 * s;
      const reveal = easeOut(Math.min(1, anim * 1.4));
      const textAlpha = Math.max(0, (anim - 0.35) / 0.65);
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, tw * reveal, 96 * s);
      if (t.subtitle) {
        ctx.fillStyle = t.accent;
        ctx.fillRect(bx, by + 96 * s, sw * reveal, 56 * s);
      }
      ctx.globalAlpha *= textAlpha;
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = titleFont;
      ctx.fillText(t.title, bx + pad, by + 50 * s);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.fillText(String(t.subtitle).toUpperCase(), bx + pad, by + 125 * s);
      }
    },
  },

  centered: {
    label: 'Título centrado',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const titleFont = font(800, 110 * s);
      const subFont = font(400, 46 * s);
      const width = Math.max(measure(ctx, t.title, titleFont), measure(ctx, t.subtitle, subFont)) + 120 * s;
      const height = (t.subtitle ? 260 : 190) * s;
      const zoom = 0.9 + 0.1 * easeOut(anim);
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-(x + w / 2), -(y + h / 2));
      const bx = x + (w - width) / 2;
      const by = y + (h - height) / 2;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, width, height);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx, by + height - 8 * s, width, 8 * s);
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = titleFont;
      ctx.fillText(t.title, x + w / 2, t.subtitle ? by + 100 * s : by + height / 2);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.globalAlpha *= 0.85;
        ctx.fillText(t.subtitle, x + w / 2, by + 195 * s);
      }
    },
  },

  cornerBug: {
    label: 'Mosca de esquina',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t) {
      const s = h / 1080;
      const titleFont = font(700, 40 * s);
      const subFont = font(400, 26 * s);
      const pad = 22 * s;
      const width = Math.max(measure(ctx, t.title, titleFont), measure(ctx, t.subtitle, subFont)) + pad * 2;
      const height = (t.subtitle ? 104 : 70) * s;
      const bx = x + w - 60 * s - width;
      const by = y + 50 * s;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, width, height);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx, by, width, 6 * s);
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.font = titleFont;
      ctx.fillText(t.title, bx + width - pad, by + 14 * s);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.globalAlpha *= 0.85;
        ctx.fillText(t.subtitle, bx + width - pad, by + 62 * s);
      }
    },
  },

  ticker: {
    label: 'Rótulo móvil (ticker)',
    uses: ['title', 'subtitle'],
    labels: { title: 'Texto que se desplaza', subtitle: 'Etiqueta (ej. ÚLTIMA HORA)' },
    draw(ctx, x, y, w, h, t, { time, anim }) {
      const s = h / 1080;
      const barH = 74 * s;
      const barY = y + h - 70 * s - barH + (1 - easeOut(anim)) * (barH + 70 * s);
      const label = t.subtitle || 'ÚLTIMA HORA';
      const labelFont = font(800, 34 * s);
      const textFont = font(500, 36 * s);
      const labelW = measure(ctx, label, labelFont) + 48 * s;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(x, barY, w, barH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + labelW, barY, w - labelW, barH);
      ctx.clip();
      const textW = measure(ctx, t.title, textFont);
      const span = textW + w - labelW;
      const offset = ((time / 1000) * 180 * s) % Math.max(span, 1);
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.title, x + w - offset, barY + barH / 2);
      ctx.restore();
      ctx.fillStyle = t.accent;
      ctx.fillRect(x, barY, labelW, barH);
      ctx.fillStyle = t.textColor;
      ctx.font = labelFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + labelW / 2, barY + barH / 2);
    },
  },

  social: {
    label: 'Redes sociales',
    uses: ['title', 'subtitle'],
    labels: { title: 'Usuario (ej. @canal)', subtitle: 'Red (ej. YouTube)' },
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const textFont = font(700, 42 * s);
      const r = 40 * s;
      const pad = 26 * s;
      const width = r * 2 + pad * 3 + measure(ctx, t.title, textFont);
      const height = r * 2 + 20 * s;
      const bx = x + w - 80 * s - width;
      const by = y + h - 150 * s - height;
      ctx.translate(0, (1 - easeOut(anim)) * 40 * s);
      ctx.fillStyle = panel(ctx, t);
      ctx.beginPath();
      ctx.roundRect(bx, by, width, height, height / 2);
      ctx.fill();
      ctx.fillStyle = t.accent;
      ctx.beginPath();
      ctx.arc(bx + 10 * s + r, by + height / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(800, 40 * s);
      ctx.fillText(String(t.subtitle || '@').trim().charAt(0).toUpperCase(), bx + 10 * s + r, by + height / 2);
      ctx.textAlign = 'left';
      ctx.font = textFont;
      ctx.fillText(t.title, bx + 10 * s + r * 2 + pad, by + height / 2);
    },
  },

  scoreboard: {
    label: 'Marcador deportivo',
    uses: ['teamA', 'scoreA', 'teamB', 'scoreB', 'subtitle'],
    labels: { subtitle: 'Periodo (ej. 1ª PARTE)' },
    score: true,
    timer: true,
    draw(ctx, x, y, w, h, t, { anim, elapsed }) {
      const s = h / 1080;
      const teamFont = font(700, 34 * s);
      const scoreFont = font(800, 40 * s);
      const infoFont = font(600, 30 * s);
      const rowH = 64 * s;
      const teamW = Math.max(measure(ctx, t.teamA, teamFont), measure(ctx, t.teamB, teamFont)) + 44 * s;
      const scoreW = 74 * s;
      const info = [t.subtitle, elapsed > 0 ? mmss(elapsed / 1000) : ''].filter(Boolean).join('  ');
      const infoW = info ? measure(ctx, info, infoFont) + 44 * s : 0;
      const bx = x + 60 * s;
      const by = y + 50 * s - (1 - easeOut(anim)) * 160 * s;
      const total = teamW * 2 + scoreW * 2 + infoW;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, total, rowH);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx + teamW, by, scoreW, rowH);
      ctx.fillRect(bx + teamW * 2 + scoreW, by, scoreW, rowH);
      ctx.fillStyle = t.textColor;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const cy = by + rowH / 2;
      ctx.font = teamFont;
      ctx.fillText(String(t.teamA), bx + teamW / 2, cy);
      ctx.fillText(String(t.teamB), bx + teamW + scoreW + teamW / 2, cy);
      ctx.font = scoreFont;
      ctx.fillText(String(t.scoreA), bx + teamW + scoreW / 2, cy);
      ctx.fillText(String(t.scoreB), bx + teamW * 2 + scoreW * 1.5, cy);
      if (info) {
        ctx.font = infoFont;
        ctx.globalAlpha *= 0.9;
        ctx.fillText(info, bx + teamW * 2 + scoreW * 2 + infoW / 2, cy);
      }
    },
  },

  clock: {
    label: 'Reloj',
    uses: ['title'],
    labels: { title: 'Etiqueta (opcional)' },
    draw(ctx, x, y, w, h, t, { anim }) {
      const s = h / 1080;
      const now = new Date();
      const time = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const timeFont = font(700, 46 * s);
      const labelFont = font(500, 26 * s);
      const pad = 26 * s;
      const width = Math.max(measure(ctx, time, timeFont), measure(ctx, t.title, labelFont)) + pad * 2;
      const height = (t.title ? 108 : 76) * s;
      const bx = x + w - 60 * s - width;
      const by = y + 50 * s - (1 - easeOut(anim)) * 160 * s;
      ctx.fillStyle = panel(ctx, t);
      ctx.fillRect(bx, by, width, height);
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx, by + height - 5 * s, width, 5 * s);
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (t.title) {
        ctx.font = labelFont;
        ctx.globalAlpha *= 0.8;
        ctx.fillText(t.title, bx + width / 2, by + 10 * s);
        ctx.globalAlpha /= 0.8;
      }
      ctx.font = timeFont;
      ctx.fillText(time, bx + width / 2, by + (t.title ? 44 : 14) * s);
    },
  },

  countdown: {
    label: 'Cuenta atrás',
    uses: ['title', 'minutes'],
    labels: { title: 'Texto (ej. Empezamos en)' },
    timer: true,
    draw(ctx, x, y, w, h, t, { anim, elapsed }) {
      const s = h / 1080;
      const remaining = Math.max(0, (Number(t.minutes) || 0) * 60 - elapsed / 1000);
      const timeText = mmss(remaining);
      const timeFont = font(800, 120 * s);
      const labelFont = font(500, 42 * s);
      const width = Math.max(measure(ctx, timeText, timeFont), measure(ctx, t.title, labelFont)) + 120 * s;
      const height = (t.title ? 250 : 180) * s;
      const bx = x + (w - width) / 2;
      const by = y + (h - height) / 2 + (1 - easeOut(anim)) * 60 * s;
      ctx.fillStyle = panel(ctx, t);
      ctx.beginPath();
      ctx.roundRect(bx, by, width, height, 18 * s);
      ctx.fill();
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (t.title) {
        ctx.font = labelFont;
        ctx.fillText(t.title, x + w / 2, by + 60 * s);
      }
      ctx.font = timeFont;
      ctx.fillStyle = remaining === 0 ? t.accent : t.textColor;
      ctx.fillText(timeText, x + w / 2, by + (t.title ? 160 : height / s / 2) * s);
    },
  },

  holding: {
    label: 'Pantalla de espera (empezamos pronto / volvemos)',
    uses: ['title', 'subtitle', 'minutes'],
    labels: { minutes: 'Cuenta atrás en minutos (0 = sin cuenta atrás)' },
    opaque: true,
    timer: true,
    draw(ctx, x, y, w, h, t, { time, elapsed }) {
      const s = h / 1080;
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, t.bgColor);
      g.addColorStop(1, t.accent);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      // Slowly drifting soft circles.
      for (let i = 0; i < 5; i++) {
        const phase = time / 9000 + i * 1.7;
        const cx = x + w * (0.5 + 0.4 * Math.sin(phase * (1 + i * 0.13)));
        const cy = y + h * (0.5 + 0.35 * Math.cos(phase * (0.8 + i * 0.11)));
        const r = h * (0.18 + 0.06 * i);
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, 'rgba(255,255,255,0.10)');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(x, y, w, h);
      }
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(800, 120 * s);
      ctx.fillText(t.title, x + w / 2, y + h * 0.42, w * 0.9);
      if (t.subtitle) {
        ctx.font = font(400, 48 * s);
        ctx.globalAlpha *= 0.85;
        ctx.fillText(t.subtitle, x + w / 2, y + h * 0.42 + 120 * s, w * 0.9);
        ctx.globalAlpha /= 0.85;
      }
      const minutes = Number(t.minutes) || 0;
      if (minutes > 0) {
        ctx.font = font(700, 72 * s);
        ctx.fillText(mmss(minutes * 60 - elapsed / 1000), x + w / 2, y + h * 0.75);
      }
    },
  },
};

/** Splits text into at most `maxLines` lines that fit `width` (adds … if cut). */
function wrap(ctx, text, width, maxLines) {
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

const PLATFORM_COLORS = { twitch: '#9146ff', youtube: '#ff0033' };

TITLE_TEMPLATES.comment = {
  label: 'Comentario del chat',
  uses: ['title', 'subtitle'],
  labels: { title: 'Mensaje', subtitle: 'Autor' },
  draw(ctx, x, y, w, h, t, { anim }) {
    const s = h / 1080;
    const msgFont = font(500, 38 * s);
    const nameFont = font(800, 30 * s);
    const maxW = Math.min(w * 0.55, 980 * s);
    ctx.font = msgFont;
    const lines = wrap(ctx, t.title, maxW, 3);
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), measure(ctx, t.subtitle, nameFont));
    const r = 34 * s;
    const pad = 26 * s;
    const boxW = r * 2 + pad * 3 + textW;
    const boxH = Math.max(r * 2 + pad, 58 * s + lines.length * 48 * s + pad);
    const bx = x + 80 * s;
    const by = y + h - 120 * s - boxH + (1 - easeOut(anim)) * 50 * s;
    const accent = PLATFORM_COLORS[t.platform] ?? t.accent;
    ctx.fillStyle = panel(ctx, t);
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 20 * s);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.fillRect(bx, by + 18 * s, 6 * s, boxH - 36 * s);
    ctx.beginPath();
    ctx.arc(bx + pad + r, by + pad + r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = font(800, 32 * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(t.subtitle || '?').trim().charAt(0).toUpperCase(), bx + pad + r, by + pad + r);
    const tx = bx + pad * 2 + r * 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = nameFont;
    ctx.fillStyle = t.nameColor || accent;
    ctx.fillText(t.subtitle, tx, by + pad - 2 * s);
    ctx.font = msgFont;
    ctx.fillStyle = t.textColor;
    lines.forEach((l, i) => ctx.fillText(l, tx, by + pad + 44 * s + i * 48 * s));
  },
};

export const FIELD_LABELS = {
  title: 'Texto principal',
  subtitle: 'Texto secundario',
  teamA: 'Equipo A',
  scoreA: 'Puntos A',
  teamB: 'Equipo B',
  scoreB: 'Puntos B',
  minutes: 'Minutos',
};

export const NUMERIC_FIELDS = new Set(['scoreA', 'scoreB', 'minutes']);

export const DEFAULT_TITLE = {
  template: 'lowerThird',
  title: 'Nombre Apellido',
  subtitle: 'Cargo o descripción',
  teamA: 'LOCAL',
  teamB: 'VISITANTE',
  scoreA: 0,
  scoreB: 0,
  minutes: 5,
  accent: '#e8453c',
  textColor: '#ffffff',
  bgColor: '#101218',
  bgOpacity: 0.85,
};

/** Sensible starting text when a template is picked in the editor. */
export const TEMPLATE_PRESETS = {
  ticker: { title: 'Última hora: escribe aquí el texto que se desplaza por la parte inferior', subtitle: 'ÚLTIMA HORA' },
  social: { title: '@micanal', subtitle: 'YouTube' },
  clock: { title: '' },
  countdown: { title: 'Empezamos en', minutes: 5 },
  holding: { title: 'Empezamos pronto', subtitle: 'La emisión comenzará en unos minutos', minutes: 5, bgColor: '#0f1830', accent: '#3b7cf6', bgOpacity: 1 },
};

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
