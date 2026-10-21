'use strict';

// CPU/memory figures for the stats panel and the upload speed test.

const { app, net } = require('electron');
const os = require('node:os');
const crypto = require('node:crypto');
const gpu = require('./gpu');

/** Busy share (0–100) of the CPU time between two `os.cpus()` samples. */
function cpuPercent(prev, now) {
  let idle = 0;
  let total = 0;
  const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
  now.forEach((t, i) => {
    const p = prev[i] ?? t;
    idle += t.idle - p.idle;
    total += sum(t) - sum(p);
  });
  return total > 0 ? (1 - idle / total) * 100 : 0;
}

let lastCpuTimes = os.cpus().map((c) => c.times);

function appMetrics() {
  const metrics = app.getAppMetrics();
  const now = os.cpus().map((c) => c.times);
  const systemCpu = cpuPercent(lastCpuTimes, now);
  lastCpuTimes = now;
  const cores = now.length || 1;
  return {
    appCpu: metrics.reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0) / cores,
    memoryMb: metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024,
    systemCpu,
    gpu: gpu.monitor.current(),
  };
}

/** Uploads random data to Cloudflare's speed-test endpoint and returns Mbit/s. */
async function uploadTest() {
  const results = [];
  for (const size of [2e6, 6e6]) {
    const body = crypto.randomBytes(size);
    const t0 = performance.now();
    const res = await net.fetch('https://speed.cloudflare.com/__up', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(`El servidor de prueba respondió ${res.status}`);
    await res.arrayBuffer();
    const secs = (performance.now() - t0) / 1000;
    results.push((size * 8) / secs / 1e6);
  }
  // The larger sample is the more reliable one.
  return { mbps: results[results.length - 1] };
}

module.exports = { cpuPercent, appMetrics, uploadTest };
