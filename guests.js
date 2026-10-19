'use strict';

// Remote guests over WebRTC on the local network. Browsers only allow camera
// access on secure pages, so this runs on HTTPS with a self-signed certificate
// (the guest accepts it once). The WebSocket only relays signalling between the
// guest page and the app; media flows peer to peer.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { lanAddresses } = require('./remote.js');

const GUEST_DIR = path.join(__dirname, 'guest');
const STATIC = {
  '/guest': ['index.html', 'text/html; charset=utf-8'],
  '/guest/': ['index.html', 'text/html; charset=utf-8'],
  '/guest/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/guest/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_GUESTS = 6;

class GuestServer {
  /** @param {{ dir: string, send: (channel: string, payload: any) => void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.configFile = path.join(opts.dir, 'guests.json');
    this.config = this.loadConfig();
    this.server = null;
    this.wss = null;
    this.guests = new Map(); // guestId -> { ws, name }
    this.lastError = null;
  }

  loadConfig() {
    try {
      return { port: 8089, ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) };
    } catch {
      return { port: 8089, code: crypto.randomBytes(5).toString('hex') };
    }
  }

  saveConfig() {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
  }

  async certificate() {
    const file = path.join(this.opts.dir, 'guest-cert.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.key && saved.cert && saved.expires > Date.now()) return saved;
    } catch {
      // Generate a new one below.
    }
    const selfsigned = require('selfsigned');
    const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map((ip) => ({ type: 7, ip }))];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'StudioMix' }], { days: 825, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] });
    const cert = { key: pems.private, cert: pems.cert, expires: Date.now() + 800 * 86400000 };
    fs.mkdirSync(this.opts.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cert));
    return cert;
  }

  get running() {
    return !!this.server?.listening;
  }

  async info() {
    const urls = lanAddresses().map((ip) => `https://${ip}:${this.config.port}/guest?c=${this.config.code}`);
    return {
      running: this.running,
      port: this.config.port,
      urls,
      qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220 }) : null,
      guests: [...this.guests.entries()].map(([id, g]) => ({ id, name: g.name })),
      error: this.lastError,
    };
  }

  async setEnabled(enabled, { regenerate = false } = {}) {
    if (regenerate) {
      this.config.code = crypto.randomBytes(5).toString('hex');
      this.saveConfig();
    }
    await this.stop();
    if (enabled) await this.start();
    return this.info();
  }

  async start() {
    this.lastError = null;
    const { key, cert } = await this.certificate();
    const server = https.createServer({ key, cert }, (req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'https://local');
      if (url.pathname !== '/guest-ws' || url.searchParams.get('c') !== this.config.code || this.guests.size >= MAX_GUESTS) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, url));
    });
    await new Promise((resolve) => {
      server.once('error', (err) => {
        this.lastError = err.code === 'EADDRINUSE' ? `El puerto ${this.config.port} ya está en uso` : err.message;
        resolve();
      });
      server.listen(this.config.port, '0.0.0.0', resolve);
    });
    if (!this.lastError) this.server = server;
  }

  async stop() {
    for (const [id, g] of this.guests) {
      g.ws.terminate();
      this.opts.send('guest:leave', { guestId: id });
    }
    this.guests.clear();
    this.wss?.close();
    this.wss = null;
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  connect(ws, url) {
    const guestId = crypto.randomBytes(6).toString('hex');
    const name = String(url.searchParams.get('name') || 'Invitado').slice(0, 40);
    this.guests.set(guestId, { ws, name });
    ws.send(JSON.stringify({ type: 'welcome', guestId }));
    this.opts.send('guest:join', { guestId, name });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // Only signalling messages are relayed to the app.
      if (['offer', 'answer', 'candidate', 'mute'].includes(msg.type)) this.opts.send('guest:signal', { guestId, data: msg });
    });
    ws.on('close', () => {
      this.guests.delete(guestId);
      this.opts.send('guest:leave', { guestId });
    });
  }

  signal(guestId, data) {
    const g = this.guests.get(guestId);
    if (g && g.ws.readyState === 1) g.ws.send(JSON.stringify(data));
  }

  kick(guestId) {
    this.guests.get(guestId)?.ws.close();
  }

  handle(req, res) {
    const url = new URL(req.url, 'https://local');
    const entry = STATIC[url.pathname];
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; media-src 'self' blob: mediastream:; connect-src 'self' wss:; style-src 'self'",
      'X-Content-Type-Options': 'nosniff',
    };
    if (!entry) {
      res.writeHead(404, headers);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': entry[1] });
    fs.createReadStream(path.join(GUEST_DIR, entry[0])).pipe(res);
  }
}

module.exports = { GuestServer };
