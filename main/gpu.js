'use strict';

// GPU load for the stats panel: overall use, video encoder (NVENC, Quick Sync,
// AMF) and decoder, video memory and temperature. NVIDIA cards report through
// nvidia-smi (one long-running process, one line per second); other GPUs on
// Windows through the "GPU Engine" performance counters that Task Manager
// shows. The monitor starts on first use and owns its child process.

const { app } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const log = require('./log').scope('gpu');

const NVIDIA_FIELDS = ['index', 'name', 'utilization.gpu', 'utilization.encoder', 'utilization.decoder', 'memory.used', 'memory.total', 'temperature.gpu'];

/** One nvidia-smi CSV line (fields above, no units) → sample, or null. */
function parseNvidiaLine(line) {
  const parts = String(line).split(',').map((p) => p.trim());
  if (parts.length < NVIDIA_FIELDS.length) return null;
  const num = (v) => (/^\d+(\.\d+)?$/.test(v) ? Number(v) : null); // "[N/A]" → null
  const [index, name, gpu, encoder, decoder, memUsed, memTotal, temp] = parts;
  if (num(index) === null) return null;
  return { index: num(index), name, util: num(gpu), encoder: num(encoder), decoder: num(decoder), memUsedMb: num(memUsed), memTotalMb: num(memTotal), temp: num(temp) };
}

/**
 * Windows "GPU Engine" samples ({ p: counter path, v: value }) → per-engine-type
 * use, the way Task Manager adds them up: each engine sums the processes using
 * it, and each type (3D, encode, decode) shows its busiest engine.
 */
function aggregateCounters(samples) {
  const engines = new Map(); // engine instance → { type, total }
  let memBytes = 0;
  for (const { p, v } of samples ?? []) {
    const path = String(p).toLowerCase();
    const value = Number(v) || 0;
    const engine = /gpu engine\(pid_\d+_(luid_\w+?_phys_\d+_eng_\d+)_engtype_([\w ]+)\)/.exec(path);
    if (engine) {
      const key = engine[1];
      const entry = engines.get(key) ?? { type: engine[2].trim(), total: 0 };
      entry.total += value;
      engines.set(key, entry);
    } else if (/gpu adapter memory\(.*\)\\dedicated usage/.test(path)) {
      memBytes = Math.max(memBytes, value);
    }
  }
  const busiest = (pattern) => Math.min(100, Math.max(0, ...[...engines.values()].filter((e) => pattern.test(e.type)).map((e) => e.total)));
  return {
    util: busiest(/^3d$/),
    encoder: busiest(/videoencode/),
    decoder: busiest(/videodecode/),
    memUsedMb: memBytes ? Math.round(memBytes / 1048576) : null,
    memTotalMb: null,
    temp: null,
  };
}

const COUNTER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $s = (Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples |
    Where-Object { $_.CookedValue -gt 0 } |
    ForEach-Object { @{ p = $_.Path; v = [math]::Round($_.CookedValue, 2) } }
  ConvertTo-Json -Compress -Depth 3 -InputObject @($s)
  Start-Sleep -Milliseconds 1000
}`;

class GpuMonitor {
  constructor() {
    this.proc = null;
    this.source = null; // 'nvidia' | 'counters' | null
    this.sample = null;
    this.sampleAt = 0;
    this.info = null; // { name, accelerated, problems }
    this.retryTimer = null;
    this.stopped = false;
    this.preferredName = null;
  }

  /** Starts measuring on first call; returns the latest data (null fields while unknown). */
  current() {
    if (!this.proc && !this.retryTimer && !this.stopped) this.start();
    // Old samples mean the reader died or stalled: report "unknown", not stale numbers.
    const fresh = this.sample && Date.now() - this.sampleAt < 5000;
    return { ...(fresh ? this.sample : {}), source: this.source, name: this.sample?.name ?? this.info?.name ?? null, accelerated: this.info?.accelerated ?? null, problems: this.info?.problems ?? [] };
  }

  start() {
    if (!this.info) this.readRenderer();
    if (this.hasNvidiaSmi()) this.startNvidia();
    else if (process.platform === 'win32') this.startCounters();
  }

  hasNvidiaSmi() {
    if (this.nvidiaChecked !== undefined) return this.nvidiaChecked;
    const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    this.nvidiaChecked = r.status === 0 && !!r.stdout.trim();
    return this.nvidiaChecked;
  }

  /** Which GPU Chromium draws with, and whether hardware acceleration is on. */
  async readRenderer() {
    try {
      const status = app.getGPUFeatureStatus();
      const problems = ['gpu_compositing', 'webgl2', 'video_decode', 'rasterization']
        .filter((k) => status[k] && !String(status[k]).startsWith('enabled'))
        .map((k) => `${k}: ${status[k]}`);
      const info = await app.getGPUInfo('complete');
      const renderer = info?.auxAttributes?.glRenderer ?? '';
      // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 …)" → the card name.
      const name = /ANGLE \([^,]+,\s*([^(,]+)/.exec(renderer)?.[1]?.trim() || renderer || null;
      this.info = { name, accelerated: problems.length === 0, problems };
      this.preferredName = name;
      if (problems.length) log.warn('Aceleración por GPU incompleta:', problems.join(', '));
      else log.info('Dibujando con la GPU:', name);
    } catch (err) {
      log.warn('No se pudo leer la información de la GPU:', err.message);
    }
  }

  spawnReader(cmd, args, onLine, label) {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    });
    proc.on('error', (err) => log.warn(`${label} no se pudo iniciar:`, err.message));
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      log.warn(`${label} terminó (código ${code}); se reintenta en 30 s`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
      }, 30000);
    });
  }

  startNvidia() {
    this.source = 'nvidia';
    const latest = new Map();
    this.spawnReader('nvidia-smi', [`--query-gpu=${NVIDIA_FIELDS.join(',')}`, '--format=csv,noheader,nounits', '-lms', '1000'], (line) => {
      const s = parseNvidiaLine(line);
      if (!s) return;
      latest.set(s.index, s);
      // With several cards, follow the one Chromium draws with (else the first).
      const pick = [...latest.values()].find((g) => this.preferredName && g.name.includes(this.preferredName)) ?? latest.get(0) ?? s;
      this.sample = pick;
      this.sampleAt = Date.now();
    }, 'nvidia-smi');
  }

  startCounters() {
    this.source = 'counters';
    this.spawnReader('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', COUNTER_SCRIPT], (line) => {
      try {
        this.sample = aggregateCounters(JSON.parse(line));
        this.sampleAt = Date.now();
      } catch {
        // A partial or odd line; the next one comes in a second.
      }
    }, 'Contadores de GPU');
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.proc?.kill();
    this.proc = null;
  }
}

const monitor = new GpuMonitor();

module.exports = { monitor, parseNvidiaLine, aggregateCounters, NVIDIA_FIELDS };
