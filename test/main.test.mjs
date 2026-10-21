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

test('GPU: nvidia-smi lines, including fields the card does not report', () => {
  const { parseNvidiaLine } = require('../main/gpu.js');
  assert.deepEqual(parseNvidiaLine('0, NVIDIA GeForce RTX 3060 Ti, 36, 12, 0, 815, 8192, 36'), {
    index: 0, name: 'NVIDIA GeForce RTX 3060 Ti', util: 36, encoder: 12, decoder: 0, memUsedMb: 815, memTotalMb: 8192, temp: 36,
  });
  assert.equal(parseNvidiaLine('1, Tesla T4, 5, [N/A], [N/A], 100, 15360, [N/A]').encoder, null);
  assert.equal(parseNvidiaLine('NVIDIA-SMI has failed'), null);
  assert.equal(parseNvidiaLine(''), null);
});

test('GPU: Windows engine counters add processes per engine, then take the busiest engine per type', () => {
  const { aggregateCounters } = require('../main/gpu.js');
  // Same shape as the real paths Get-Counter returns (\\host\gpu engine(...)\utilization percentage).
  const engine = (pid, eng, type, v) => ({ p: String.raw`\\nova\gpu engine(pid_${pid}_luid_0x00000000_0x00010162_phys_0_eng_${eng}_engtype_${type})\utilization percentage`, v });
  const r = aggregateCounters([
    engine(100, 0, '3d', 30),
    engine(200, 0, '3d', 25.5), // same 3D engine, another process → 55.5
    engine(100, 1, '3d', 10), // a second 3D engine, less busy
    engine(100, 7, 'videoencode', 40),
    engine(300, 8, 'videodecode', 12),
    engine(100, 4, 'copy', 90), // copy engines don't count as "GPU use"
    { p: String.raw`\\nova\gpu adapter memory(luid_0x00000000_0x00010162_phys_0)\dedicated usage`, v: 1073741824 },
  ]);
  assert.equal(r.util, 55.5);
  assert.equal(r.encoder, 40);
  assert.equal(r.decoder, 12);
  assert.equal(r.memUsedMb, 1024);
  assert.deepEqual(aggregateCounters([]), { util: 0, encoder: 0, decoder: 0, memUsedMb: null, memTotalMb: null, temp: null });
});

test('updates: versions compare by number, and release notes become plain text', () => {
  const { compareVersions, plainNotes } = require('../main/updates.js');
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('v0.3.3', '0.3.3'), 0);
  assert.equal(compareVersions('0.3.3', '0.4.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(plainNotes('<h2>Novedades</h2><ul><li>Uno &amp; dos</li><li><b>Tres</b></li></ul><script>alert(1)</script>'), 'Novedades\n• Uno & dos\n• Tres\nalert(1)');
  assert.equal(plainNotes([{ note: 'A' }, { note: 'B' }]), 'A\nB');
  assert.equal(plainNotes(null), '');
});

test('web inputs: typed addresses and paths become safe page URLs', () => {
  const { normalizeWebUrl } = require('../main/webinputs.js');
  assert.equal(normalizeWebUrl(' https://ejemplo.com/gc.html?nombre=Ana '), 'https://ejemplo.com/gc.html?nombre=Ana');
  assert.equal(normalizeWebUrl('C:\\Graficos\\gc.html?nombre=Ana%20L'), 'file:///C:/Graficos/gc.html?nombre=Ana%20L');
  assert.equal(normalizeWebUrl('C:\\Mis gráficos\\gc.htm'), 'file:///C:/Mis%20gr%C3%A1ficos/gc.htm');
  assert.throws(() => normalizeWebUrl(''), /Escribe/);
  assert.throws(() => normalizeWebUrl('javascript:alert(1)'), /http/);
  assert.throws(() => normalizeWebUrl('app://studiomix/index.html'), /http/);
  assert.throws(() => normalizeWebUrl('C:\\Windows\\win.ini'), /\.html/);
  assert.throws(() => normalizeWebUrl('no es una url'), /no es válida/);
});

test('web inputs: pages stay on their site, and paint rectangles merge and clamp', () => {
  const { sameSite, unionRect, clampRect } = require('../main/webinputs.js');
  assert.equal(sameSite('https://a.com/x.html', 'https://a.com/y.html?z=1'), true);
  assert.equal(sameSite('https://a.com/x.html', 'https://b.com/'), false);
  assert.equal(sameSite('file:///C:/g/gc.html', 'file:///C:/g/sub/control.html'), true);
  assert.equal(sameSite('file:///C:/g/gc.html', 'file:///C:/otra/x.html'), false);
  assert.equal(sameSite('file:///C:/g/gc.html', 'https://a.com/'), false);
  assert.deepEqual(unionRect(null, { x: 5, y: 5, width: 10, height: 10 }), { x: 5, y: 5, width: 10, height: 10 });
  assert.deepEqual(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 20 }), { x: 0, y: 0, width: 30, height: 25 });
  assert.deepEqual(clampRect({ x: -5, y: 1070, width: 30, height: 40 }, { width: 1920, height: 1080 }), { x: 0, y: 1070, width: 25, height: 10 });
  assert.equal(clampRect({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1920, height: 1080 }), null);
});