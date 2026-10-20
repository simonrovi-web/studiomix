// Live performance charts: output FPS, render time, CPU, stream bitrate,
// dropped frames and master level, sampled once per second (last 2 minutes).
import { levelToDb } from './audio.js';
import { app } from './store.js';
import { $, h } from './util.js';

const HISTORY = 120;

const CHARTS = [
  { id: 'fps', label: 'FPS salida', color: '#2fbf71', min: 0, max: () => app.state.settings.fps * 1.1, fmt: (v) => v.toFixed(1) },
  { id: 'render', label: 'Render', color: '#3b7cf6', min: 0, max: () => 1000 / app.state.settings.fps, fmt: (v) => `${v.toFixed(1)} ms` },
  { id: 'cpu', label: 'CPU sistema / app', color: '#f2b33d', color2: '#c08cff', min: 0, max: () => 100, fmt: (v, v2) => `${v.toFixed(0)}% / ${v2.toFixed(0)}%` },
  { id: 'bitrate', label: 'Bitrate emisión', color: '#e5383b', min: 0, max: null, fmt: (v) => (v ? `${Math.round(v)} kbps` : '—') },
  { id: 'audio', label: 'Nivel master', color: '#2fbf71', min: -60, max: () => 0, fmt: (v) => (v <= -60 ? '-∞ dB' : `${v.toFixed(1)} dB`) },
  { id: 'memory', label: 'Memoria', color: '#8a93a4', min: 0, max: null, fmt: (v) => `${Math.round(v)} MB` },
];

const series = Object.fromEntries(CHARTS.map((c) => [c.id, []]));
const series2 = { cpu: [] };
const views = new Map();
let audioPeak = 0;

function push(arr, value) {
  arr.push(value);
  if (arr.length > HISTORY) arr.shift();
}

function draw(chart) {
  const view = views.get(chart.id);
  const canvas = view.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const hgt = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, hgt);
  const data = series[chart.id];
  const data2 = series2[chart.id];
  const max = chart.max ? chart.max() : Math.max(1, ...data) * 1.2;
  const min = chart.min;
  const y = (v) => hgt - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (hgt - 2) - 1;
  const x = (i, n) => w - (n - 1 - i) * (w / (HISTORY - 1));

  const line = (values, color, fill) => {
    if (values.length < 2) return;
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(x(i, values.length), y(v)) : ctx.moveTo(x(i, values.length), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(x(values.length - 1, values.length), hgt);
      ctx.lineTo(x(0, values.length), hgt);
      ctx.closePath();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };
  line(data, chart.color, true);
  if (data2) line(data2, chart.color2, false);

  const last = data[data.length - 1] ?? 0;
  view.value.textContent = chart.fmt(last, data2?.[data2.length - 1] ?? 0);
}

const COLLAPSE_KEY = 'studiomix.statsCollapsed';

function initCollapse() {
  const panel = $('.stats');
  const btn = $('#btn-stats-toggle');
  let collapsed;
  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY);
  } catch {
    collapsed = null;
  }
  // Without a saved choice, start folded on short screens where height is precious.
  const apply = (value) => {
    panel.classList.toggle('collapsed', value);
    btn.setAttribute('aria-expanded', String(!value));
  };
  apply(collapsed == null ? window.innerHeight < 880 : collapsed === '1');
  btn.addEventListener('click', () => {
    const value = !panel.classList.contains('collapsed');
    apply(value);
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
    } catch {
      // Preference won't persist.
    }
  });
}

export function initStats() {
  initCollapse();
  const box = $('#charts');
  for (const chart of CHARTS) {
    const canvas = h('canvas');
    const value = h('b', {}, '—');
    box.append(h('div', { class: 'chart', title: chart.label }, h('div', { class: 'chart-head' }, h('span', {}, chart.label), value), canvas));
    views.set(chart.id, { canvas, value });
  }

  // Track the master peak between samples.
  setInterval(() => {
    audioPeak = Math.max(audioPeak, ...app.audio.meter.levels);
  }, 100);

  setInterval(async () => {
    const stats = app.compositor.stats;
    let metrics = { appCpu: 0, systemCpu: 0, memoryMb: 0 };
    try {
      metrics = await window.studio.metrics();
    } catch {
      // Main process busy; keep the previous sample shape.
    }
    const stream = app.outputs.get('stream');
    const bitrate = stream?.stats?.bitrate ? parseFloat(stream.stats.bitrate) : 0;
    push(series.fps, stats.fps);
    push(series.render, stats.renderMs);
    push(series.cpu, metrics.systemCpu);
    push(series2.cpu, metrics.appCpu);
    push(series.bitrate, bitrate);
    push(series.audio, Math.max(-60, levelToDb(audioPeak)));
    push(series.memory, metrics.memoryMb);
    audioPeak = 0;
    if (!document.hidden && !$('.stats').classList.contains('collapsed')) CHARTS.forEach(draw);
    updateChips(stats, metrics, stream);
  }, 1000);
}

function updateChips(stats, metrics, stream) {
  const fps = app.state.settings.fps;
  const chipFps = $('#chip-fps');
  chipFps.textContent = `${stats.fps.toFixed(0)} fps`;
  chipFps.className = `chip ${stats.fps < fps * 0.9 ? 'bad' : 'good'}`;
  const chipRender = $('#chip-render');
  chipRender.textContent = `render ${stats.renderMs.toFixed(1)} ms`;
  chipRender.className = `chip ${stats.renderMs > 1000 / fps ? 'bad' : stats.renderMs > 500 / fps ? 'warn' : ''}`;
  const chipCpu = $('#chip-cpu');
  chipCpu.textContent = `CPU ${metrics.systemCpu.toFixed(0)}%`;
  chipCpu.className = `chip ${metrics.systemCpu > 90 ? 'bad' : metrics.systemCpu > 75 ? 'warn' : ''}`;
  const drop = Number(stream?.stats?.drop ?? 0);
  if (drop > 0) chipFps.title = `Fotogramas descartados por el codificador: ${drop}`;
}
