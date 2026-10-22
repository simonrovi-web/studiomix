'use strict';

// Guests from anywhere: a Cloudflare quick tunnel (no account) gives the local
// guest server a public https://….trycloudflare.com address with a valid
// certificate. Only signalling and the guest page go through it; media still
// flows peer to peer. cloudflared is downloaded on first use, pinned and
// checked against its published SHA-256.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const dns = require('node:dns');

const log = require('./log').scope('tunnel');

const CLOUDFLARED = {
  version: '2026.10.0',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe',
  size: 55365048,
  sha256: '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c',
};
const READY_TIMEOUT_MS = 45000;
const PUBLISH_TIMEOUT_MS = 90000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Public URL announced by cloudflared, or null. */
function parseTunnelUrl(line) {
  return URL_RE.exec(line)?.[0] ?? null;
}

class GuestTunnel {
  /** @param {{ dir: string, onChange: (status: object) => void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.binary = path.join(opts.dir, 'bin', `cloudflared-${CLOUDFLARED.version}.exe`);
    this.child = null;
    this.status = { state: 'off', url: null, progress: 0, error: null };
  }

  get installed() {
    try {
      return fs.statSync(this.binary).size === CLOUDFLARED.size;
    } catch {
      return false;
    }
  }

  info() {
    return { ...this.status, installed: this.installed, downloadMB: Math.round(CLOUDFLARED.size / 1048576) };
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.opts.onChange(this.info());
  }

  /** Downloads cloudflared once; the file only takes its final name after the hash matches. */
  async download() {
    if (this.installed) return;
    this.set({ state: 'downloading', progress: 0, error: null });
    const res = await fetch(CLOUDFLARED.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`No se pudo descargar cloudflared (HTTP ${res.status}).`);
    fs.mkdirSync(path.dirname(this.binary), { recursive: true });
    const part = `${this.binary}.part`;
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let received = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (received > CLOUDFLARED.size) throw new Error('La descarga de cloudflared es más grande de lo esperado.');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const progress = Math.floor((received / CLOUDFLARED.size) * 100);
        if (progress !== this.status.progress) this.set({ progress });
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (received !== CLOUDFLARED.size || hash.digest('hex') !== CLOUDFLARED.sha256) {
        throw new Error('La descarga de cloudflared no coincide con la versión publicada; se ha descartado.');
      }
      fs.renameSync(part, this.binary);
      log.info(`cloudflared ${CLOUDFLARED.version} descargado y verificado`);
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw err;
    }
  }

  /** Starts a quick tunnel to the local guest server and resolves with its public URL. */
  async start(port) {
    await this.stop();
    try {
      await this.download();
      this.set({ state: 'starting', url: null, error: null });
      const url = await this.launch(port);
      await this.waitUntilPublished(url);
      this.set({ state: 'ready', url });
      log.info(`Túnel listo: ${url}`);
      return url;
    } catch (err) {
      log.warn('Túnel:', err.message);
      await this.stop({ keepStatus: true });
      this.set({ state: 'error', url: null, error: err.message });
      return null;
    }
  }

  /**
   * A new quick-tunnel name takes a while to exist everywhere in DNS; a guest
   * who opens it earlier gets an error page. Waits until the guest page answers
   * through the tunnel, asking DNS servers directly first (c-ares) so that an
   * early miss is not kept by the system cache.
   */
  async waitUntilPublished(url) {
    const { hostname } = new URL(url);
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
    let resolved = false;
    for (;;) {
      try {
        resolved ||= (await dns.promises.resolve4(hostname)).length > 0;
        if (resolved && (await fetch(`${url}/guest`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).ok) return;
      } catch {
        // Not published yet.
      }
      if (Date.now() > deadline) throw new Error('El enlace de Cloudflare no llegó a publicarse. Inténtalo de nuevo.');
      if (!this.child) throw new Error('El túnel se cerró mientras se publicaba el enlace.');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  launch(port) {
    const child = spawn(this.binary, ['tunnel', '--no-autoupdate', '--url', `https://127.0.0.1:${port}`, '--no-tls-verify'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    return new Promise((resolve, reject) => {
      let url = null;
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Cloudflare no respondió a tiempo. Comprueba la conexión a internet.')), READY_TIMEOUT_MS);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text) => {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          url ??= parseTunnelUrl(line);
          // The address only answers once an edge connection is registered.
          if (url && /Registered tunnel connection/i.test(line)) {
            clearTimeout(timer);
            resolve(url);
          }
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          if (this.status.state === 'ready') this.set({ state: 'error', url: null, error: `El túnel se cerró (código ${code}).` });
        }
        reject(new Error(`cloudflared terminó antes de estar listo (código ${code}).`));
      });
    });
  }

  async stop({ keepStatus = false } = {}) {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
    if (!keepStatus && this.status.state !== 'off') this.set({ state: 'off', url: null, error: null });
  }
}

module.exports = { GuestTunnel, parseTunnelUrl, CLOUDFLARED };
