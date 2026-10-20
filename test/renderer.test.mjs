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
