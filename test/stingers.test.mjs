// Stinger preparation: which files need converting, and a real MOV with alpha
// (ProRes 4444) to transparent WebM with the bundled FFmpeg.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('../main/ffmpeg.js');
const { stingerPlan, hasAlpha, webmArgs } = require('../main/stingers.js');

const probe = (codec, pixFmt, extra = '') => `Duration: 00:00:02.00\n  Stream #0:0: Video: ${codec}, ${pixFmt}(progressive), 1920x1080, 30 fps, 30 tbr\n${extra}`;

test('hasAlpha recognises alpha pixel formats and WebM alpha', () => {
  assert.ok(hasAlpha('', 'yuva444p12le'));
  assert.ok(hasAlpha('', 'argb'));
  assert.ok(hasAlpha('', 'rgba'));
  assert.ok(hasAlpha('      alpha_mode      : 1', 'yuv420p'));
  assert.ok(!hasAlpha('', 'yuv420p'));
});

test('stingerPlan: WebM and H.264 play as is, MOV with alpha and HTML are converted', () => {
  assert.equal(stingerPlan('a.webm', probe('vp9 (Profile 0)', 'yuv420p', '      alpha_mode      : 1')), 'use');
  assert.equal(stingerPlan('a.mp4', probe('h264 (High)', 'yuv420p')), 'use');
  assert.equal(stingerPlan('a.mov', probe('prores (4444) (ap4h / 0x68347061)', 'yuva444p12le')), 'alpha');
  assert.equal(stingerPlan('a.mov', probe('qtrle (rle  / 0x20656C72)', 'argb')), 'alpha');
  assert.equal(stingerPlan('a.mov', probe('png (png  / 0x20676E70)', 'rgba')), 'alpha');
  assert.equal(stingerPlan('a.mov', probe('prores (HQ)', 'yuv422p10le')), 'convert');
  assert.equal(stingerPlan('C:\\anim\\intro.HTML', ''), 'html');
});

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiomix-stinger-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MOV ProRes 4444 with alpha becomes WebM VP9 that keeps the alpha', { timeout: 60_000 }, async () => {
  const mov = path.join(dir, 'stinger.mov');
  // Opaque, 50 % and fully transparent thirds.
  await ffmpeg.runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=96x96:r=30:d=1,format=rgba',
    '-f', 'lavfi', '-i', 'color=c=red@0.5:s=96x96:r=30:d=1,format=rgba',
    '-f', 'lavfi', '-i', 'color=c=black@0:s=96x96:r=30:d=1,format=rgba',
    '-filter_complex', '[0][1][2]hstack=3',
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov,
  ]);
  const movInfo = await ffmpeg.ffmpegInfo(mov);
  assert.equal(stingerPlan(mov, movInfo), 'alpha');

  const webm = path.join(dir, 'stinger.webm');
  await ffmpeg.runFfmpeg(webmArgs(['-i', mov], webm, { alpha: true, fps: 30 }));
  const out = await ffmpeg.ffmpegInfo(webm);
  assert.equal(ffmpeg.parseProbe(out).codec, 'vp9');
  assert.match(out, /alpha_mode\s*:\s*1/);
  assert.equal(stingerPlan(webm, out), 'use');

  // Decode with libvpx (the alpha lives in a side stream) and read the alpha of each third.
  const alphas = [];
  for (const x of [48, 144, 240]) {
    const raw = path.join(dir, `px${x}.raw`);
    await ffmpeg.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', webm, '-frames:v', '1', '-vf', `format=rgba,crop=1:1:${x}:48`, '-f', 'rawvideo', raw]);
    alphas.push(fs.readFileSync(raw)[3]);
  }
  assert.ok(alphas[0] > 245, `opaque ${alphas[0]}`);
  assert.ok(Math.abs(alphas[1] - 128) < 12, `half ${alphas[1]}`);
  assert.ok(alphas[2] < 10, `transparent ${alphas[2]}`);
});
