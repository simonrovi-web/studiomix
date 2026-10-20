// Transitions that need more than 2D canvas compositing:
//  - Luma wipe: reveals the next shot following a greyscale pattern (generated
//    procedurally on the GPU), with softness and inversion.
//  - Stinger: a video (ideally with alpha, e.g. WebM VP9) played over the
//    switch; the cut happens at a chosen point while the clip keeps playing.

export const LUMA_PATTERNS = {
  linearH: 'Lineal horizontal',
  linearV: 'Lineal vertical',
  diagonal: 'Diagonal',
  barndoorH: 'Puertas horizontales',
  barndoorV: 'Puertas verticales',
  iris: 'Círculo',
  box: 'Caja',
  diamond: 'Diamante',
  clock: 'Reloj',
  blinds: 'Persianas',
  checker: 'Tablero',
  spiral: 'Espiral',
  dissolve: 'Disolución en bloques',
};

const PATTERN_IDS = Object.fromEntries(Object.keys(LUMA_PATTERNS).map((k, i) => [k, i]));

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D fromTex;
uniform sampler2D toTex;
uniform float progress;
uniform float softness;
uniform bool invert;
uniform int pattern;
uniform float aspect;

const float PI = 3.14159265;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float luma(vec2 t) {
  vec2 c = vec2((t.x - 0.5) * aspect, t.y - 0.5);
  float top = 1.0 - t.y;
  if (pattern == 0) return t.x;
  if (pattern == 1) return top;
  if (pattern == 2) return (t.x + top) * 0.5;
  if (pattern == 3) return abs(t.x - 0.5) * 2.0;
  if (pattern == 4) return abs(t.y - 0.5) * 2.0;
  if (pattern == 5) return length(c) / length(vec2(aspect * 0.5, 0.5));
  if (pattern == 6) return max(abs(c.x) / (aspect * 0.5), abs(c.y) / 0.5);
  if (pattern == 7) return (abs(c.x) / aspect + abs(c.y)) ;
  if (pattern == 8) return fract(atan(c.x, c.y) / (2.0 * PI) + 1.0);
  if (pattern == 9) return fract(top * 8.0);
  if (pattern == 10) {
    float cell = mod(floor(t.x * 8.0) + floor(t.y * 4.5), 2.0);
    return clamp(cell * 0.5 + fract(t.x * 8.0) * 0.5, 0.0, 1.0);
  }
  if (pattern == 11) return fract(atan(c.x, c.y) / (2.0 * PI) + length(c) * 1.5);
  return hash(floor(t * vec2(64.0, 36.0)));
}

void main() {
  float v = luma(uv);
  if (invert) v = 1.0 - v;
  float edge = progress * (1.0 + softness);
  float reveal = 1.0 - smoothstep(edge - softness, edge, v);
  color = mix(texture(fromTex, uv), texture(toTex, uv), reveal);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class LumaWipe {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.u = Object.fromEntries(['fromTex', 'toTex', 'progress', 'softness', 'invert', 'pattern', 'aspect'].map((n) => [n, gl.getUniformLocation(program, n)]));
    for (const [unit, name] of [[0, 'fromTex'], [1, 'toTex']]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(this.u[name], unit);
    }
  }

  render(from, to, progress, { pattern = 'linearH', softness = 0.1, invert = false } = {}) {
    const { gl, u } = this;
    const { width, height } = from;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from);
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, to);
    gl.uniform1f(u.progress, progress);
    gl.uniform1f(u.softness, Math.max(0.001, softness));
    gl.uniform1i(u.invert, invert ? 1 : 0);
    gl.uniform1i(u.pattern, PATTERN_IDS[pattern] ?? 0);
    gl.uniform1f(u.aspect, width / height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

/** Stinger clip: plays over Program and tells the compositor when to cut. */
export class Stinger {
  constructor() {
    this.el = null;
    this.path = '';
    this.playing = false;
    this.onAudioElement = null;
  }

  /** Loads (or clears) the clip; `file` is a media descriptor { path, url }. */
  load(file) {
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
      this.el.remove();
      this.el = null;
    }
    // A converted clip (MOV with alpha, HTML) remembers the file the user picked.
    this.path = file?.source ?? file?.path ?? '';
    this.playing = false;
    if (!file) return;
    const el = document.createElement('video');
    el.src = file.url;
    el.preload = 'auto';
    el.playsInline = true;
    el.addEventListener('ended', () => {
      this.playing = false;
    });
    document.getElementById('media-host').append(el);
    this.el = el;
    this.onAudioElement?.(el);
  }

  get ready() {
    return !!this.el && this.el.readyState >= 1 && Number.isFinite(this.el.duration);
  }

  get durationMs() {
    return this.ready ? this.el.duration * 1000 : 0;
  }

  start() {
    if (!this.el) return false;
    this.el.currentTime = 0;
    this.el.play().catch(() => {});
    this.playing = true;
    return true;
  }

  draw(ctx, w, h) {
    const v = this.el;
    if (!this.playing || !v || v.readyState < 2) return;
    ctx.drawImage(v, 0, 0, w, h);
  }
}
