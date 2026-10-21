// Main-process helpers that don't need Electron running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const media = require('../main/media.js');
const outputs = require('../main/outputs.js');
const session = require('../main/session.js');
const system = require('../main/system.js');
const netinputs = require('../main/netinputs.js');
const log = require('../main/log.js');

test('parseRange handles open, closed and suffix ranges', () => {
  assert.deepEqual(media.parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(media.parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(media.parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(media.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(media.parseRange('bytes=1000-', 1000), null);
  assert.equal(media.parseRange('bytes=5-2', 1000), null);
  assert.equal(media.parseRange('bytes=-', 1000), null);
  assert.equal(media.parseRange('items=0-1', 1000), null);
});

test('inside keeps paths in their folder', () => {
  const base = path.resolve('/app/renderer');
  assert.equal(media.inside(base, '/js/app.js'), path.join(base, 'js', 'app.js'));
  // URL paths start at the root, so "/.." can't climb above it.
  assert.equal(media.inside(base, '/../main.js'), path.join(base, 'main.js'));
  assert.equal(media.inside(base, '../main.js'), null);
  assert.equal(media.inside(base, 'js/../../package.json'), null);
});

test('mediaDescriptor allows the file and builds an app:// URL', () => {
  const file = path.resolve('/videos/clip one.mp4');
  const d = media.mediaDescriptor(file);
  assert.equal(d.name, 'clip one');
  assert.equal(d.url, `app://studiomix/media?p=${encodeURIComponent(file)}`);
  assert.ok(media.allowedMedia.has(file));
});

test('pickReplaySegments takes the newest segments covering the requested time', () => {
  const dir = path.resolve('/replay');
  const csv = 'seg001.ts,0.0,2.0\nseg002.ts,2.0,4.0\nseg003.ts,4.0,6.0\nseg004.ts,6.0,8.0\n';
  const { picked, total } = outputs.pickReplaySegments(csv, dir, 5, () => true);
  assert.deepEqual(picked.map((p) => path.basename(p.file)), ['seg002.ts', 'seg003.ts', 'seg004.ts']);
  assert.equal(total, 6);
  // Segments overwritten since the list was written are skipped.
  const missing = outputs.pickReplaySegments(csv, dir, 4, (f) => !f.endsWith('seg004.ts'));
  assert.deepEqual(missing.picked.map((p) => path.basename(p.file)), ['seg002.ts', 'seg003.ts']);
  assert.deepEqual(outputs.pickReplaySegments('', dir, 10, () => true).picked, []);
});

test('concatLine uses forward slashes and escapes quotes', () => {
  assert.equal(outputs.concatLine("C:\\tmp\\it's.ts"), "file 'C:/tmp/it'\\''s.ts'");
});

test('projectMediaPaths finds input, mask, title logo and stinger files and ignores junk', () => {
  const data = {
    inputs: [{ path: 'a.mp4', fx: { maskPath: 'm.png' } }, { path: '' }, null, { fx: {} }, { type: 'title', fields: { logoPath: 'logo.png' } }],
    transition: { stinger: { path: 's.webm' } },
  };
  assert.deepEqual(session.projectMediaPaths(data), ['a.mp4', 'm.png', 'logo.png', 's.webm']);
  assert.deepEqual(session.projectMediaPaths({}), []);
  assert.deepEqual(session.projectMediaPaths(null), []);
});

test('cpuPercent is the busy share between two samples', () => {
  const t = (busy, idle) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });
  assert.equal(system.cpuPercent([t(0, 0), t(0, 0)], [t(50, 50), t(25, 75)]), 37.5);
  assert.equal(system.cpuPercent([t(1, 1)], [t(1, 1)]), 0);
});

test('redact hides credentials in network input URLs', () => {
  assert.equal(netinputs.redact('rtsp://admin:secret@192.168.1.5/live'), 'rtsp://***@192.168.1.5/live');
  assert.equal(netinputs.redact('srt://0.0.0.0:9000'), 'srt://0.0.0.0:9000');
});

test('log lines carry time, level, scope and error stacks', () => {
  const line = log.format('warn', 'outputs', ['falló', new Error('boom'), { a: 1 }], new Date('2026-10-19T10:00:00Z'));
  assert.match(line, /^2026-10-19T10:00:00\.000Z WARN \[outputs\] falló Error: boom/);
  assert.match(line, /\{"a":1\}$/);
});

test('parseOutputUrl accepts only output pages with a known source', () => {
  const screens = require('../main/screens.js');
  assert.deepEqual(screens.parseOutputUrl('app://studiomix/output.html?source=preview&display=123'), { source: 'preview', display: '123' });
  assert.deepEqual(screens.parseOutputUrl('app://studiomix/output.html?source=program'), { source: 'program', display: 'window' });
  assert.equal(screens.parseOutputUrl('app://studiomix/output.html?source=desktop'), null);
  assert.equal(screens.parseOutputUrl('app://studiomix/index.html?source=program'), null);
  assert.equal(screens.parseOutputUrl('https://example.com/output.html?source=program'), null);
  assert.equal(screens.parseOutputUrl('not a url'), null);
});

test('Tailscale addresses (100.64.0.0/10) are told apart from the local network', () => {
  const { isTailscaleIp } = require('../main/remote.js');
  for (const ip of ['100.64.0.1', '100.101.5.9', '100.127.255.254']) assert.ok(isTailscaleIp(ip), ip);
  for (const ip of ['100.63.255.255', '100.128.0.1', '192.168.1.7', '10.0.0.5']) assert.ok(!isTailscaleIp(ip), ip);
});
