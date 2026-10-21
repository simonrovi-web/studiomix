// Title styles built around a logo (any image; PNG, WebP or SVG keep their
// transparency). The editor's "Elegir logo…" sets fields.logoPath; the logo
// arrives in env.logo once loaded. While editing, a dashed box marks its place.

import { clamp01, drawLogo, easeOut, easeOutBack, font, logoPlaceholder, logoWidth, measure, panel, roundBox } from './title-kit.js';
import { hexToRgba } from './util.js';

// One scratch canvas per logo for the light sweep, reused every frame.
const glints = new WeakMap();

function glintCanvas(logo, w, h) {
  let c = glints.get(logo);
  if (!c) {
    c = document.createElement('canvas');
    glints.set(logo, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/** Logo or, while editing, its placeholder, fitted in the box. */
function logoOrPlaceholder(ctx, logo, editing, x, y, w, h, s, align) {
  const drawn = drawLogo(ctx, logo, x, y, w, h, align);
  if (!drawn && editing) logoPlaceholder(ctx, x, y, w, h, s);
}

export const LOGO_STYLES = {
  logoLowerThird: {
    label: 'Rótulo con logo',
    logo: 'required',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim, logo, editing }) {
      const s = h / 1080;
      const titleFont = font(700, 52 * s);
      const subFont = font(400, 32 * s);
      const height = (t.subtitle ? 150 : 110) * s;
      const logoH = height - 32 * s;
      const lw = logoWidth(logo, logoH, editing);
      const pad = 30 * s;
      const textW = Math.max(measure(ctx, t.title, titleFont), measure(ctx, t.subtitle, subFont));
      const width = pad + (lw ? lw + pad : 0) + textW + pad;
      const bx = x + 100 * s;
      const by = y + h - 120 * s - height;
      const reveal = easeOut(clamp01(anim * 1.3));
      const textAlpha = clamp01((anim - 0.3) / 0.7);
      // Panel opens from the logo side.
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, width * reveal, height);
      ctx.clip();
      roundBox(ctx, bx, by, width, height, 10 * s, panel(ctx, t));
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx, by + height - 6 * s, width, 6 * s);
      ctx.restore();
      if (lw) {
        ctx.save();
        ctx.globalAlpha *= easeOut(clamp01(anim * 2));
        logoOrPlaceholder(ctx, logo, editing, bx + pad, by + 16 * s, lw, logoH, s, 'left');
        ctx.restore();
        // Thin divider between logo and text.
        ctx.fillStyle = hexToRgba(t.textColor, 0.25);
        ctx.fillRect(bx + pad + lw + pad / 2, by + 24 * s, 2 * s, height - 48 * s);
      }
      ctx.globalAlpha *= textAlpha;
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tx = bx + pad + (lw ? lw + pad : 0);
      ctx.font = titleFont;
      ctx.fillText(t.title, tx, by + (t.subtitle ? 22 : 30) * s);
      if (t.subtitle) {
        ctx.font = subFont;
        ctx.globalAlpha *= 0.85;
        ctx.fillText(t.subtitle, tx, by + 88 * s);
      }
    },
  },

  logoBug: {
    label: 'Logo en esquina (mosca)',
    logo: 'required',
    uses: ['corner', 'logoSize', 'logoOpacity'],
    draw(ctx, x, y, w, h, t, { anim, logo, editing }) {
      const s = h / 1080;
      const size = (Math.min(60, Math.max(3, Number(t.logoSize) || 12)) / 100) * h;
      const maxW = size * 3;
      const margin = 50 * s;
      const corner = ['tl', 'tr', 'bl', 'br'].includes(t.corner) ? t.corner : 'tr';
      const right = corner[1] === 'r';
      const bottom = corner[0] === 'b';
      const lx = right ? x + w - margin - maxW : x + margin;
      const ly = bottom ? y + h - margin - size : y + margin;
      ctx.globalAlpha *= clamp01((Number(t.logoOpacity) || 0) / 100) * easeOut(anim);
      logoOrPlaceholder(ctx, logo, editing, lx, ly, maxW, size, s, right ? 'right' : 'left');
    },
  },

  logoReveal: {
    label: 'Presentación con logo (intro)',
    logo: 'required',
    uses: ['title', 'subtitle'],
    draw(ctx, x, y, w, h, t, { anim, time, logo, editing }) {
      const s = h / 1080;
      // Dim the picture behind (background colour and opacity).
      ctx.fillStyle = hexToRgba(t.bgColor, t.bgOpacity * easeOut(anim));
      ctx.fillRect(x, y, w, h);
      const logoH = 360 * s;
      const logoW = 900 * s;
      const lx = x + (w - logoW) / 2;
      const ly = y + h / 2 - logoH / 2 - (t.title ? 90 * s : 0);
      const zoom = 0.7 + 0.3 * easeOutBack(clamp01(anim));
      ctx.save();
      ctx.translate(x + w / 2, ly + logoH / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-(x + w / 2), -(ly + logoH / 2));
      ctx.globalAlpha *= clamp01(anim * 1.5);
      const drawn = drawLogo(ctx, logo, lx, ly, logoW, logoH, 'center');
      if (!drawn && editing) logoPlaceholder(ctx, x + w / 2 - logoH / 2, ly, logoH, logoH, s);
      // A light sweep crosses the logo every 4 s (only where the logo is opaque).
      if (drawn) {
        const phase = ((time ?? 0) % 4000) / 4000;
        if (phase < 0.35) {
          const sx = drawn.x - drawn.w * 0.4 + (drawn.w * 1.8 * phase) / 0.35;
          const glint = glintCanvas(logo, Math.max(1, Math.ceil(drawn.w)), Math.max(1, Math.ceil(drawn.h)));
          const g = glint.getContext('2d');
          g.globalCompositeOperation = 'copy';
          g.drawImage(logo, 0, 0, glint.width, glint.height);
          g.globalCompositeOperation = 'source-in';
          const grad = g.createLinearGradient(sx - drawn.x - 80 * s, 0, sx - drawn.x + 80 * s, glint.height);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(0.5, 'rgba(255,255,255,0.75)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grad;
          g.fillRect(0, 0, glint.width, glint.height);
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(glint, drawn.x, drawn.y);
        }
      }
      ctx.restore();
      const textAlpha = clamp01((anim - 0.45) / 0.55);
      ctx.globalAlpha *= textAlpha;
      ctx.fillStyle = t.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (t.title) {
        ctx.font = font(800, 72 * s);
        ctx.fillText(t.title, x + w / 2, ly + logoH + 50 * s + (1 - textAlpha) * 20 * s);
      }
      if (t.subtitle) {
        ctx.font = font(400, 36 * s);
        ctx.fillStyle = t.accent;
        ctx.fillText(t.subtitle, x + w / 2, ly + logoH + 140 * s + (1 - textAlpha) * 20 * s);
      }
    },
  },

  sponsor: {
    label: 'Patrocinador (logo)',
    logo: 'required',
    uses: ['subtitle', 'corner'],
    labels: { subtitle: 'Texto (p. ej. Patrocinado por)' },
    draw(ctx, x, y, w, h, t, { anim, logo, editing }) {
      const s = h / 1080;
      const textFont = font(600, 26 * s);
      const logoH = 110 * s;
      const lw = Math.max(logoWidth(logo, logoH, editing), 160 * s);
      const pad = 28 * s;
      const label = String(t.subtitle ?? '').toUpperCase();
      ctx.letterSpacing = `${2 * s}px`;
      const boxW = Math.max(lw, measure(ctx, label, textFont)) + pad * 2;
      const boxH = logoH + pad * 2 + (label ? 44 * s : 0);
      const corner = ['tl', 'tr', 'bl', 'br'].includes(t.corner) ? t.corner : 'br';
      const right = corner[1] === 'r';
      const bottom = corner[0] === 'b';
      const margin = 60 * s;
      const slide = (1 - easeOut(anim)) * 60 * s * (bottom ? 1 : -1);
      const bx = right ? x + w - margin - boxW : x + margin;
      const by = (bottom ? y + h - margin - boxH : y + margin) + slide;
      ctx.globalAlpha *= easeOut(anim);
      roundBox(ctx, bx, by, boxW, boxH, 16 * s, panel(ctx, t));
      ctx.fillStyle = t.accent;
      ctx.fillRect(bx + pad, by + 14 * s, 40 * s, 4 * s);
      let top = by + pad;
      if (label) {
        ctx.fillStyle = t.textColor;
        ctx.font = textFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha *= 0.85;
        ctx.fillText(label, bx + pad, top + 4 * s);
        ctx.globalAlpha /= 0.85;
        top += 44 * s;
      }
      logoOrPlaceholder(ctx, logo, editing, bx + pad, top, boxW - pad * 2, logoH, s, 'center');
    },
  },
};

export const LOGO_PRESETS = {
  logoLowerThird: { title: 'Nombre Apellido', subtitle: 'Cargo o empresa', accent: '#e8453c', textColor: '#ffffff', bgColor: '#101218', bgOpacity: 0.85 },
  logoBug: { corner: 'tr', logoSize: 12, logoOpacity: 85 },
  logoReveal: { title: 'Bienvenidos', subtitle: 'Empezamos el directo', accent: '#7dd3fc', textColor: '#ffffff', bgColor: '#05070c', bgOpacity: 0.75 },
  sponsor: { subtitle: 'Patrocinado por', corner: 'br', accent: '#f2b33d', textColor: '#ffffff', bgColor: '#101218', bgOpacity: 0.8 },
};
