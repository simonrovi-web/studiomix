// Renderer logic that runs without a browser (parsers, audio maths, framing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleList } from '../renderer/js/titles.js';
import { parseCube } from '../renderer/js/effects.js';
import { faderToGain, gainToDbLabel, levelToDb } from '../renderer/js/audio.js';
import { clamp, fmtTime, framedRect, hexToRgba } from '../renderer/js/util.js';

test('parseTitleList accepts |, ; and CSV with quotes, and skips a header', () => {
  assert.deepEqual(parseTitleList('Ana López | Presentadora\n\nLuis | Invitado'), [['Ana López', 'Presentadora'], ['Luis', 'Invitado']]);
  assert.deepEqual(parseTitleList('titulo,subtitulo\n"Pérez, Juan","Dijo ""hola"""'), [['Pérez, Juan', 'Dijo "hola"']]);
  assert.deepEqual(parseTitleList('Uno;Dos;Tres'), [['Uno', 'Dos', 'Tres']]);
  assert.deepEqual(parseTitleList(''), []);
});

test('parseCube reads a 3D LUT into RGBA bytes', () => {
  const identity = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');
  const lut = parseCube(`# comment\nTITLE "x"\n${identity}`);
  assert.equal(lut.size, 2);
  assert.deepEqual([...lut.data.slice(0, 8)], [0, 0, 0, 255, 255, 0, 0, 255]);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0'), /incompleto/);
  assert.throws(() => parseCube('hola'), /no es un archivo .cube válido/i);
});

test('fader maths: 100 is unity, 0 is silence', () => {
  assert.equal(faderToGain(100), 1);
  assert.equal(faderToGain(0), 0);
  assert.equal(faderToGain(50), 0.25);
  assert.equal(gainToDbLabel(1), '0.0 dB');
  assert.equal(gainToDbLabel(2), '+6.0 dB');
  assert.equal(gainToDbLabel(0), '-∞ dB');
  assert.equal(gainToDbLabel(0.5), '-6.0 dB');
  assert.equal(levelToDb(0), -100);
});

test('fmtTime, clamp and hexToRgba', () => {
  assert.equal(fmtTime(3_723_000), '01:02:03');
  assert.equal(fmtTime(-5), '00:00:00');
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(hexToRgba('#ff8000', 0.5), 'rgba(255,128,0,0.5)');
  assert.equal(hexToRgba('nope'), 'rgba(0,0,0,1)');
});

test('framedRect applies crop, then zoom and pan inside the crop', () => {
  const fx = { cropL: 0.1, cropR: 0.1, cropT: 0, cropB: 0.5, zoom: 1, panX: 0, panY: 0 };
  assert.deepEqual(framedRect(fx, 1000, 1000), { x: 100, y: 0, w: 800, h: 500 });
  const zoomed = framedRect({ ...fx, zoom: 2, panX: 1, panY: -1 }, 1000, 1000);
  assert.deepEqual(zoomed, { x: 500, y: 0, w: 400, h: 250 });
});

test('every title template draws at the start, middle and end of its entry without errors', async () => {
  const { TITLE_TEMPLATES, DEFAULT_TITLE, TEMPLATE_PRESETS, FIELD_LABELS } = await import('../renderer/js/titles.js');
  // A 2D context stand-in: records nothing, measures text by length.
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 20 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  const keys = Object.keys(TITLE_TEMPLATES);
  assert.ok(keys.length >= 20, `${keys.length} templates`);
  for (const key of keys) {
    const t = TITLE_TEMPLATES[key];
    assert.ok(t.label && typeof t.draw === 'function', key);
    for (const field of t.uses) assert.ok(t.labels?.[field] ?? FIELD_LABELS[field], `${key}: label for ${field}`);
    const fields = { ...DEFAULT_TITLE, ...(TEMPLATE_PRESETS[key] ?? {}), template: key };
    for (const anim of [0, 0.5, 1]) t.draw(ctx, 0, 0, 1920, 1080, fields, { time: 1234, anim, elapsed: 65000 });
  }
  for (const key of Object.keys(TEMPLATE_PRESETS)) assert.ok(TITLE_TEMPLATES[key], `preset for unknown template ${key}`);
});

test('web input pixels: premultiplied BGRA becomes straight RGBA, padded rows are packed', async () => {
  const { bgraToRgba, packRows } = await import('../renderer/js/pixels.js');
  // opaque blue-ish, fully transparent, 50% red (premultiplied: R=128 of 255)
  const px = new Uint8ClampedArray([200, 100, 50, 255, 9, 9, 9, 0, 0, 0, 128, 128]);
  assert.deepEqual([...bgraToRgba(px)], [50, 100, 200, 255, 0, 0, 0, 0, 255, 0, 0, 128]);
  const padded = new Uint8ClampedArray([1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0]); // 1×2 with 4 bytes of padding per row
  assert.deepEqual([...packRows(padded, 1, 2)], [1, 2, 3, 4, 5, 6, 7, 8]);
  const tight = new Uint8ClampedArray(8);
  assert.equal(packRows(tight, 2, 1), tight);
});
test('T-bar: a MIDI fader pushed to the top completes once and stays; the way back is the next transition', async () => {
  const { moveTbar, settleTbar } = await import('../renderer/js/tbar.js');
  const t = { bar: 0, barFrom: 0, manual: 0, running: false, barSource: 'midi' };
  const commits = [];
  // Simulates the compositor: on 'commit' it swaps and settles like commit('bar').
  const send = (midi) => {
    if (moveTbar(t, (midi / 127) * 100) === 'commit') {
      commits.push(midi);
      t.manual = 0;
      settleTbar(t, 'bar');
    }
  };
  for (let v = 0; v <= 127; v += 8) send(v);
  send(127);
  assert.deepEqual(commits, [127], 'one transition on the way up');
  assert.equal(t.bar, 100, 'the bar stays at the top (no jump back to 0)');
  assert.equal(t.manual, 0);
  // Jitter at the top does not start anything.
  for (const v of [126, 127, 125, 127]) send(v);
  assert.equal(t.manual, 0);
  assert.equal(commits.length, 1);
  // Halfway down: progress counts from the top.
  send(64);
  assert.ok(Math.abs(t.manual - 49.6) < 0.5, `manual ${t.manual}`);
  for (let v = 64; v >= 0; v -= 8) send(v);
  assert.deepEqual(commits, [127, 0], 'the way down is the next transition');
});

test('T-bar: faders that top out at 126 still complete', async () => {
  const { moveTbar } = await import('../renderer/js/tbar.js');
  const t = { bar: 0, barFrom: 0, manual: 0, running: false };
  let result = null;
  for (let v = 0; v <= 126; v += 6) result = moveTbar(t, (v / 127) * 100) ?? result;
  assert.equal(moveTbar(t, (126 / 127) * 100), 'commit');
  assert.equal(result, 'commit');
});

test('T-bar: after AUTO mid-way a MIDI fader is picked up at an end; the on-screen bar moves to the end', async () => {
  const { moveTbar, settleTbar, displayedBar } = await import('../renderer/js/tbar.js');
  const midi = { bar: 0, barFrom: 0, manual: 0, running: false, barSource: 'midi' };
  moveTbar(midi, 40);
  assert.equal(midi.manual, 40);
  midi.manual = 0;
  settleTbar(midi, 'auto');
  assert.equal(midi.barLocked, true);
  moveTbar(midi, 60);
  assert.equal(midi.manual, 0, 'ignored while locked: no jump');
  moveTbar(midi, 100);
  assert.equal(midi.barLocked, false);
  assert.equal(midi.barFrom, 100);
  moveTbar(midi, 70);
  assert.equal(midi.manual, 30);

  const ui = { bar: 0, barFrom: 0, manual: 0, running: false, barSource: 'ui' };
  ui.running = true;
  ui.progress = 0.25;
  assert.equal(displayedBar(ui), 25, 'travels with AUTO');
  ui.running = false;
  settleTbar(ui, 'auto');
  assert.equal(ui.bar, 100);
  assert.equal(ui.barFrom, 100);
  settleTbar(ui, 'cut');
  assert.equal(ui.bar, 100, 'a CUT leaves a resting bar alone');
});
