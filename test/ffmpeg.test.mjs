// FFmpeg command lines and output parsing (main/ffmpeg.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('../main/ffmpeg.js');

const env = { encoder: 'x264', recordFolder: path.resolve('/rec'), replayDir: path.resolve('/tmp/replay'), now: new Date(2026, 9, 19, 9, 5, 3) };
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('timestamp is local time, zero-padded and file-name safe', () => {
  assert.equal(ffmpeg.timestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02_03-04-05');
});

test('pickEncoder: auto prefers a GPU encoder, an unavailable request falls back to x264', () => {
  assert.equal(ffmpeg.pickEncoder('auto', ['x264', 'nvenc']), 'nvenc');
  assert.equal(ffmpeg.pickEncoder(undefined, ['x264']), 'x264');
  assert.equal(ffmpeg.pickEncoder('qsv', ['x264', 'nvenc']), 'x264');
  assert.equal(ffmpeg.pickEncoder('nvenc', ['x264', 'nvenc']), 'nvenc');
});

test('videoEncoderArgs: constant bitrate with a keyframe every 2 s', () => {
  const args = ffmpeg.videoEncoderArgs('x264', 4500, 30, 'faster');
  assert.equal(valueAfter(args, '-c:v'), 'libx264');
  assert.equal(valueAfter(args, '-preset'), 'faster');
  assert.equal(valueAfter(args, '-b:v'), '4500k');
  assert.equal(valueAfter(args, '-maxrate'), '4500k');
  assert.equal(valueAfter(args, '-bufsize'), '9000k');
  assert.equal(valueAfter(args, '-g'), '60');
  assert.equal(valueAfter(ffmpeg.videoEncoderArgs('nvenc', 6000, 60), '-c:v'), 'h264_nvenc');
  assert.equal(valueAfter(ffmpeg.videoEncoderArgs('qsv', 6000, 60), '-c:v'), 'h264_qsv');
  assert.equal(valueAfter(ffmpeg.videoEncoderArgs('amf', 6000, 60), '-c:v'), 'h264_amf');
});

test('streamTargets appends the key, skips disabled destinations and validates URLs', () => {
  assert.deepEqual(
    ffmpeg.streamTargets([
      { enabled: true, url: 'rtmp://a.example/live/', key: ' abc ' },
      { enabled: false, url: 'rtmp://b.example/live', key: 'x' },
      { enabled: true, url: 'rtmps://c.example/app', key: '' },
    ]),
    ['rtmp://a.example/live/abc', 'rtmps://c.example/app'],
  );
  assert.throws(() => ffmpeg.streamTargets([]), /Activa al menos un destino/);
  assert.throws(() => ffmpeg.streamTargets([{ enabled: true, name: 'X', url: 'http://x' }]), /«X» debe empezar por rtmp/);
});

test('teeEscape escapes the tee muxer separators', () => {
  assert.equal(ffmpeg.teeEscape('rtmp://h/app/k|e[y]\\'), 'rtmp://h/app/k\\|e\\[y\\]\\\\');
});

test('stream to one destination writes FLV straight to it', () => {
  const { args, file } = ffmpeg.outputArgs({ kind: 'stream', fps: 30, destinations: [{ enabled: true, url: 'rtmp://h/app', key: 'k' }] }, env);
  assert.equal(file, null);
  assert.equal(args.at(-1), 'rtmp://h/app/k');
  assert.equal(valueAfter(args, '-f'), 'flv');
  assert.equal(valueAfter(args, '-b:a'), '160k');
});

test('stream to several destinations uses one encode and the tee muxer', () => {
  const { args } = ffmpeg.outputArgs({
    kind: 'vstream',
    fps: 30,
    videoKbps: 100, // raised to the 300 kb/s minimum
    destinations: [
      { enabled: true, url: 'rtmp://a/app', key: '1' },
      { enabled: true, url: 'rtmp://b/app', key: '2' },
    ],
  }, env);
  assert.equal(args.filter((a) => a === '-c:v').length, 1);
  assert.equal(valueAfter(args, '-b:v'), '300k');
  assert.ok(args.includes('tee'));
  assert.equal(args.at(-1), '[f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmp://a/app/1|[f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmp://b/app/2');
});

test('record: MP4 re-muxes H.264 and names the file with label and time', () => {
  const { args, file } = ffmpeg.outputArgs({ kind: 'record', format: 'mp4', videoCodec: 'h264', label: 'vertical!' }, env);
  assert.equal(file, path.join(env.recordFolder, 'StudioMix_vertical_2026-10-19_09-05-03.mp4'));
  assert.equal(valueAfter(args, '-c:v'), 'copy');
  assert.equal(valueAfter(args, '-c:a'), 'aac');
  assert.equal(args.at(-1), file);
});

test('record: MP4 from VP8/VP9 is re-encoded; MKV is copied as is', () => {
  assert.equal(valueAfter(ffmpeg.outputArgs({ kind: 'record', format: 'mp4', videoCodec: 'vp9' }, env).args, '-c:v'), 'libx264');
  const mkv = ffmpeg.outputArgs({ kind: 'record', format: 'mkv' }, env);
  assert.ok(mkv.file.endsWith('.mkv'));
  assert.equal(valueAfter(mkv.args, '-c'), 'copy');
});

test('iso: one MKV per source in the ISO folder, with a safe file name', () => {
  const { file, args } = ffmpeg.outputArgs({ kind: 'iso', label: 'Cám: 1/2?' }, env);
  assert.equal(file, path.join(env.recordFolder, 'ISO', 'Cám_ 1_2__2026-10-19_09-05-03.mkv'));
  assert.equal(valueAfter(args, '-c'), 'copy');
});

test('replay: 2 s segments, list sized to the buffer length, wrap with slack', () => {
  const { args } = ffmpeg.outputArgs({ kind: 'replay', fps: 30, replaySeconds: 20 }, env);
  assert.equal(valueAfter(args, '-segment_time'), '2');
  assert.equal(valueAfter(args, '-segment_list_size'), '12');
  assert.equal(valueAfter(args, '-segment_wrap'), '16');
  assert.equal(valueAfter(args, '-segment_list'), path.join(env.replayDir, 'list.csv'));
  // Out-of-range lengths are clamped to 5–300 s.
  assert.equal(valueAfter(ffmpeg.outputArgs({ kind: 'replay', replaySeconds: 9999 }, env).args, '-segment_list_size'), '152');
});

test('outputArgs rejects unknown kinds', () => {
  assert.throws(() => ffmpeg.outputArgs({ kind: 'nope' }, env), /Salida desconocida/);
});

test('parseStats reads FFmpeg progress lines', () => {
  const line = 'frame=  901 fps= 30 q=23.0 size=    4096KiB time=00:00:30.03 bitrate=1117.4kbits/s dup=0 drop=2 speed=1.00x';
  assert.ok(ffmpeg.isProgressLine(line));
  assert.deepEqual(ffmpeg.parseStats(line), { fps: '30', bitrate: '1117.4kbits/s', time: '00:00:30.03', speed: '1.00x', size: '4096KiB', drop: '2' });
  assert.ok(!ffmpeg.isProgressLine('[flv @ 0x1] Failed to update header'));
});

test('netInputArgs: RTSP over TCP, fragmented MP4 to stdout, GPU when available', () => {
  const rtsp = ffmpeg.netInputArgs('rtsp://cam/stream', 'x264');
  assert.equal(valueAfter(rtsp, '-rtsp_transport'), 'tcp');
  assert.equal(valueAfter(rtsp, '-c:v'), 'libx264');
  assert.equal(rtsp.at(-1), 'pipe:1');
  const srt = ffmpeg.netInputArgs('srt://0.0.0.0:9000?mode=listener', 'nvenc');
  assert.ok(!srt.includes('-rtsp_transport'));
  assert.equal(valueAfter(srt, '-c:v'), 'h264_nvenc');
});

test('parseProbe explains why phone footage may stutter', () => {
  const hevc = `Duration: 00:01:02.50, start: 0.000000, bitrate: 50000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc), 3840x2160, 48000 kb/s, 59.94 fps, 60 tbr`;
  const info = ffmpeg.parseProbe(hevc);
  assert.equal(info.codec, 'hevc');
  assert.equal(info.width, 3840);
  assert.equal(info.height, 2160);
  assert.equal(info.duration, 62.5);
  assert.deepEqual(info.reasons, ['códec HEVC', 'color de 10 bits', '2160p a 60 fps']);

  const h264 = 'Duration: 00:00:10.00\n  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 30 fps, 30 tbr';
  assert.deepEqual(ffmpeg.parseProbe(h264).reasons, []);
  assert.equal(ffmpeg.parseProbe('').codec, null);
});
