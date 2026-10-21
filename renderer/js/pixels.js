// Raw pixel helpers for web page inputs (no DOM, so they can be tested in Node).

/**
 * Chromium paints premultiplied BGRA; ImageData wants straight RGBA. Converts
 * `px` in place (fully transparent and fully opaque pixels skip the division).
 */
export function bgraToRgba(px) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    const b = px[i];
    if (a === 255) {
      px[i] = px[i + 2];
      px[i + 2] = b;
    } else if (a === 0) {
      px[i] = px[i + 1] = px[i + 2] = 0;
    } else {
      const k = 255 / a;
      px[i] = Math.min(255, Math.round(px[i + 2] * k));
      px[i + 1] = Math.min(255, Math.round(px[i + 1] * k));
      px[i + 2] = Math.min(255, Math.round(b * k));
    }
  }
  return px;
}

/** Pixel rows of `width` with any row padding removed. */
export function packRows(px, width, height) {
  const stride = px.length / height;
  if (stride === width * 4) return px;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) out.set(px.subarray(y * stride, y * stride + width * 4), y * width * 4);
  return out;
}
