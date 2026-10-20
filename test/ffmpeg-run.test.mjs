// Runs the bundled FFmpeg with the real command lines: what the renderer sends
// (Matroska with H.264 + Opus, like MediaRecorder) must come out as playable
// files. Everything is written to a temporary folder that is removed after.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('../main/ffmpeg.js');
const { pickReplaySegments, concatLine } = require('../main/outputs.js');

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiomix-test-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Pipes `seconds` of a test pattern (H.264 + Opus in Matroska) into FFmpeg with `args`. */
function pipeInto(args, seconds) {
  return new Promise((resolve, reject) => {
    const source = spawn(ffmpeg.FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=30:d=${seconds}`,
      '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-f', 'matroska', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const sink = spawn(ffmpeg.FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    sink.stderr.on('data', (d) => {
      errors += d;
    });
    source.stdout.pipe(sink.stdin);
    sink.stdin.on('error', () => {
      // Reported through the exit code below.
    });
    sink.on('error', reject);
    sink.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errors.slice(-500)))));
  });
}

test('record to MP4 (H.264 copied, audio to AAC) gives a playable file', { timeout: 60_000 }, async () => {
  const { args, file } = ffmpeg.outputArgs({ kind: 'record', format: 'mp4', videoCodec: 'h264' }, { recordFolder: dir });
  await pipeInto(args, 2);
  const info = ffmpeg.parseProbe(await ffmpeg.ffmpegInfo(file));
  assert.equal(info.codec, 'h264');
  assert.equal(info.width, 320);
  assert.ok(info.duration > 1.5 && info.duration < 2.5, `duration ${info.duration}`);
});

test('replay buffer segments join into one clip', { timeout: 60_000 }, async () => {
  const replayDir = path.join(dir, 'replay');
  fs.mkdirSync(replayDir);
  const { args } = ffmpeg.outputArgs({ kind: 'replay', fps: 30, replaySeconds: 6 }, { encoder: 'x264', recordFolder: dir, replayDir });
  await pipeInto(args, 7);
  const csv = fs.readFileSync(path.join(replayDir, 'list.csv'), 'utf8');
  const { picked, total } = pickReplaySegments(csv, replayDir, 4);
  assert.ok(picked.length >= 2 && total >= 4, `${picked.length} segments, ${total} s`);
  const list = path.join(replayDir, 'concat.txt');
  fs.writeFileSync(list, picked.map((p) => concatLine(p.file)).join('\n'));
  const target = path.join(dir, 'replay.mp4');
  await ffmpeg.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', target]);
  const info = ffmpeg.parseProbe(await ffmpeg.ffmpegInfo(target));
  assert.equal(info.codec, 'h264');
  assert.ok(Math.abs(info.duration - total) < 0.6, `clip ${info.duration} s, segments ${total} s`);
});
