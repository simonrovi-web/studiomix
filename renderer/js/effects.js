// GPU video filters for one input, rendered with WebGL2 into a canvas the 2D
// compositor then draws. One shader pass applies, in order:
//   scroll → sharpen → key (chroma / colour / luma) → colour correction →
//   LUT colour grade → image mask.

export const DEFAULT_FX = {
  keyOn: false,
  keyType: 'chroma', // 'chroma' | 'color' | 'luma'
  keyColor: '#00ff00',
  similarity: 0.4,
  smoothness: 0.08,
  spill: 0.1,
  lumaMin: 0.1,
  lumaMax: 1,
  lumaSmooth: 0.05,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  hue: 0,
  sharpen: 0,
  lut: '', // '' | 'preset:<id>' | absolute path to a .cube file
  lutAmount: 1,
  maskPath: '',
  removeBg: false, // person segmentation instead of a chroma key
  maskMode: 'alpha', // 'alpha' | 'luma'
  maskInvert: false,
  scrollX: 0, // frame widths per second
  scrollY: 0,
  opacity: 1,
  // Framing ("Ajuste y recorte"): rotation in 90° steps, zoom into the cropped
  // area and where to centre that zoom (-1…1 on each axis).
  rotate: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  flip: false,
  cropL: 0,
  cropR: 0,
  cropT: 0,
  cropB: 0,
};

export function needsGpu(fx) {
  return (
    fx.keyOn ||
    fx.brightness !== 0 ||
    fx.contrast !== 1 ||
    fx.saturation !== 1 ||
    fx.gamma !== 1 ||
    fx.hue !== 0 ||
    fx.sharpen > 0 ||
    !!fx.lut ||
    !!fx.maskPath ||
    fx.removeBg ||
    fx.scrollX !== 0 ||
    fx.scrollY !== 0
  );
}

// ---------------------------------------------------------------------------
// LUTs
// ---------------------------------------------------------------------------

const LUT_GRID = 33;

function buildLut(fn, size = LUT_GRID) {
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[i++] = Math.round(Math.min(1, Math.max(0, out[0])) * 255);
        data[i++] = Math.round(Math.min(1, Math.max(0, out[1])) * 255);
        data[i++] = Math.round(Math.min(1, Math.max(0, out[2])) * 255);
        data[i++] = 255;
      }
    }
  }
  return { size, data };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Built-in looks, generated as 3D LUTs. */
export const LUT_PRESETS = {
  bw: { label: 'Blanco y negro', fn: (r, g, b) => Array(3).fill(smooth(0.02, 0.98, luma(r, g, b))) },
  sepia: {
    label: 'Sepia',
    fn: (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b],
  },
  tealOrange: {
    label: 'Cine (verde azulado y naranja)',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const shadow = 1 - smooth(0.1, 0.6, l);
      const high = smooth(0.4, 0.9, l);
      return [r + 0.08 * high - 0.06 * shadow, g + 0.02 * high + 0.02 * shadow, b - 0.08 * high + 0.08 * shadow];
    },
  },
  warm: { label: 'Cálido', fn: (r, g, b) => [r * 1.08 + 0.02, g * 1.02, b * 0.88] },
  cool: { label: 'Frío', fn: (r, g, b) => [r * 0.9, g * 1.0, b * 1.1 + 0.02] },
  vivid: {
    label: 'Vívido',
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const s = 1.35;
      return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s].map((v) => smooth(-0.05, 1.05, v));
    },
  },
  faded: { label: 'Desvaído', fn: (r, g, b) => [0.08 + r * 0.86, 0.08 + g * 0.84, 0.1 + b * 0.8] },
  invert: { label: 'Negativo', fn: (r, g, b) => [1 - r, 1 - g, 1 - b] },
};

const presetCache = new Map();

export function presetLut(id) {
  if (!presetCache.has(id)) presetCache.set(id, buildLut(LUT_PRESETS[id].fn));
  return presetCache.get(id);
}

/** Parses an Adobe/Resolve .cube file (3D, or 1D expanded to 3D). */
export function parseCube(text) {
  let size3 = 0;
  let size1 = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'LUT_3D_SIZE') size3 = Number(parts[1]);
    else if (key === 'LUT_1D_SIZE') size1 = Number(parts[1]);
    else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (/^[-\d.]/.test(parts[0]) && parts.length >= 3) values.push(parts.slice(0, 3).map(Number));
  }
  const norm = (v, c) => (v - min[c]) / (max[c] - min[c] || 1);
  if (size3 >= 2) {
    if (values.length < size3 ** 3) throw new Error('El archivo .cube está incompleto');
    const data = new Uint8Array(size3 ** 3 * 4);
    values.slice(0, size3 ** 3).forEach((v, i) => {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, norm(v[c], c))) * 255);
      data[i * 4 + 3] = 255;
    });
    return { size: size3, data };
  }
  if (size1 >= 2) {
    if (values.length < size1) throw new Error('El archivo .cube está incompleto');
    const curve = (x, c) => {
      const pos = x * (size1 - 1);
      const i = Math.min(size1 - 2, Math.floor(pos));
      const t = pos - i;
      return norm(values[i][c] * (1 - t) + values[i + 1][c] * t, c);
    };
    return buildLut((r, g, b) => [curve(r, 0), curve(g, 1), curve(b, 2)]);
  }
  throw new Error('No es un archivo .cube válido');
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision mediump sampler3D;
in vec2 uv;
out vec4 color;
uniform sampler2D tex;
uniform vec2 texel;
uniform vec2 scroll;
uniform bool wrap;
uniform float sharpen;
uniform bool keyOn;
uniform int keyType;
uniform vec3 keyColor;
uniform float similarity;
uniform float smoothness;
uniform float spill;
uniform vec3 lumaRange; // min, max, smoothing
uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float gamma;
uniform float hue;
uniform bool lutOn;
uniform sampler3D lut;
uniform float lutSize;
uniform float lutAmount;
uniform bool maskOn;
uniform sampler2D mask;
uniform bool maskLuma;
uniform bool maskInvert;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec4 fetch(vec2 p) {
  return texture(tex, wrap ? fract(p) : clamp(p, 0.0, 1.0));
}

vec2 chroma(vec3 c) {
  return vec2(c.r * -0.169 + c.g * -0.331 + c.b * 0.5 + 0.5,
              c.r * 0.5 + c.g * -0.419 + c.b * -0.081 + 0.5);
}

vec3 rotateHue(vec3 c, float angle) {
  // Rotate around the grey axis in YIQ space.
  mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYiq * c;
  float s = sin(angle), co = cos(angle);
  yiq.yz = mat2(co, s, -s, co) * yiq.yz;
  return toRgb * yiq;
}

void main() {
  vec2 p = uv + scroll;
  vec4 c = fetch(p);
  vec3 rgb = c.rgb;
  float alpha = c.a;

  if (sharpen > 0.0) {
    vec3 around = fetch(p + vec2(texel.x, 0.0)).rgb + fetch(p - vec2(texel.x, 0.0)).rgb
                + fetch(p + vec2(0.0, texel.y)).rgb + fetch(p - vec2(0.0, texel.y)).rgb;
    rgb = clamp(rgb + (rgb * 4.0 - around) * sharpen, 0.0, 1.0);
  }

  if (keyOn) {
    float a = 1.0;
    if (keyType == 0) {
      float base = distance(chroma(rgb), chroma(keyColor)) - similarity;
      a = pow(clamp(base / max(smoothness, 0.0001), 0.0, 1.0), 1.5);
      float keep = pow(clamp(base / max(spill, 0.0001), 0.0, 1.0), 1.5);
      rgb = mix(vec3(dot(rgb, LUMA)), rgb, keep);
    } else if (keyType == 1) {
      float base = distance(rgb, keyColor) - similarity;
      a = clamp(base / max(smoothness, 0.0001), 0.0, 1.0);
    } else {
      float l = dot(rgb, LUMA);
      // Keep pixels whose brightness is inside [min, max]; darker or brighter ones fade out.
      a = smoothstep(lumaRange.x - lumaRange.z, lumaRange.x, l) * (1.0 - smoothstep(lumaRange.y, lumaRange.y + lumaRange.z, l));
    }
    alpha *= a;
  }

  rgb = pow(max(rgb, 0.0), vec3(1.0 / gamma));
  rgb = (rgb + brightness - 0.5) * contrast + 0.5;
  if (hue != 0.0) rgb = rotateHue(rgb, hue);
  float l = dot(rgb, LUMA);
  rgb = clamp(mix(vec3(l), rgb, saturation), 0.0, 1.0);

  if (lutOn) {
    vec3 graded = texture(lut, rgb * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize).rgb;
    rgb = mix(rgb, graded, lutAmount);
  }

  if (maskOn) {
    vec4 m = texture(mask, uv);
    float f = maskLuma ? dot(m.rgb, LUMA) * m.a : m.a;
    alpha *= maskInvert ? 1.0 - f : f;
  }

  color = vec4(rgb * alpha, alpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex) || [0, 'ff', 'ff', 'ff'];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

const UNIFORMS = [
  'tex', 'texel', 'scroll', 'wrap', 'sharpen', 'keyOn', 'keyType', 'keyColor', 'similarity', 'smoothness', 'spill',
  'lumaRange', 'brightness', 'contrast', 'saturation', 'gamma', 'hue', 'lutOn', 'lut', 'lutSize', 'lutAmount',
  'maskOn', 'mask', 'maskLuma', 'maskInvert',
];

export class EffectProcessor {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.gl = gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)]));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.sourceTex = this.makeTexture(gl.TEXTURE0, gl.TEXTURE_2D, gl.REPEAT);
    this.maskTex = this.makeTexture(gl.TEXTURE1, gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
    this.lutTex = this.makeTexture(gl.TEXTURE2, gl.TEXTURE_3D, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.u.tex, 0);
    gl.uniform1i(this.u.mask, 1);
    gl.uniform1i(this.u.lut, 2);
    this.loadedMask = null;
    this.loadedLut = null;
  }

  makeTexture(unit, target, wrapMode) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(target, tex);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapMode);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrapMode);
    return tex;
  }

  /**
   * Processes one frame of `source` and returns the canvas holding the result.
   * `assets` carries the decoded LUT ({ size, data }) and mask image, if any.
   */
  process(source, width, height, fx, { lut = null, mask = null, maskDynamic = false, time = 0 } = {}) {
    const { gl, u } = this;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // Dynamic masks (person segmentation) change every frame; image masks only once.
    if (mask && (maskDynamic || mask !== this.loadedMask)) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      this.loadedMask = mask;
    }
    if (lut && lut !== this.loadedLut) {
      gl.activeTexture(gl.TEXTURE2);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.loadedLut = lut;
    }

    const scrolling = fx.scrollX !== 0 || fx.scrollY !== 0;
    const t = time / 1000;
    gl.uniform2f(u.texel, 1 / width, 1 / height);
    gl.uniform2f(u.scroll, scrolling ? (fx.scrollX * t) % 1 : 0, scrolling ? (-fx.scrollY * t) % 1 : 0);
    gl.uniform1i(u.wrap, scrolling ? 1 : 0);
    gl.uniform1f(u.sharpen, fx.sharpen);
    gl.uniform1i(u.keyOn, fx.keyOn ? 1 : 0);
    gl.uniform1i(u.keyType, { chroma: 0, color: 1, luma: 2 }[fx.keyType] ?? 0);
    gl.uniform3fv(u.keyColor, hexToRgb(fx.keyColor));
    gl.uniform1f(u.similarity, fx.similarity);
    gl.uniform1f(u.smoothness, fx.smoothness);
    gl.uniform1f(u.spill, fx.spill);
    gl.uniform3f(u.lumaRange, fx.lumaMin, fx.lumaMax, fx.lumaSmooth);
    gl.uniform1f(u.brightness, fx.brightness);
    gl.uniform1f(u.contrast, fx.contrast);
    gl.uniform1f(u.saturation, fx.saturation);
    gl.uniform1f(u.gamma, Math.max(0.1, fx.gamma));
    gl.uniform1f(u.hue, (fx.hue * Math.PI) / 180);
    gl.uniform1i(u.lutOn, lut ? 1 : 0);
    gl.uniform1f(u.lutSize, lut?.size ?? 2);
    gl.uniform1f(u.lutAmount, fx.lutAmount);
    gl.uniform1i(u.maskOn, mask ? 1 : 0);
    gl.uniform1i(u.maskLuma, !maskDynamic && fx.maskMode === 'luma' ? 1 : 0);
    gl.uniform1i(u.maskInvert, !maskDynamic && fx.maskInvert ? 1 : 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
