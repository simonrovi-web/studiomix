'use strict';

// Local control server: an HTTP API (for Stream Deck via Bitfocus Companion,
// macros, scripts), a WebSocket with live state, and the phone/tablet remote
// page. Disabled by default; every request needs the access token.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const REMOTE_DIR = path.join(__dirname, 'remote');
const STATIC = {
  '/remote': ['index.html', 'text/html; charset=utf-8'],
  '/remote/': ['index.html', 'text/html; charset=utf-8'],
  '/remote/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/remote/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const COMMANDS = new Set([
  'cut', 'auto', 'ftb', 'preview', 'program', 'overlay', 'stream', 'record', 'pause', 'replay', 'replaySave',
  'snapshot', 'volume', 'mute', 'masterVolume', 'transition', 'titleNext', 'titlePrev', 'guestAudio',
]);

/**
 * IPv4 addresses a phone on the same network could reach, real adapters first
 * (virtual ones from VirtualBox, Hyper-V, WSL or VPNs go last).
 */
function lanAddresses() {
  const virtualName = /virtual|vbox|vmware|vethernet|hyper-v|wsl|docker|loopback|tap|tun|vpn|zerotier|tailscale/i;
  // MAC prefixes of VirtualBox, VMware and Hyper-V adapters (their names are often just "Ethernet 2").
  const virtualMac = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d)/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const isVirtual = virtualName.test(name) || virtualMac.test(a.mac || '');
      list.push({ ip: a.address, rank: isVirtual ? 2 : /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address) ? 0 : 1 });
    }
  }
  return list.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
}

class RemoteServer {
  /**
   * @param {{ configFile: string, send: (channel: string, payload: any) => void,
   *           onUpgrade?: (req, socket, head) => boolean }} opts
   *   send forwards commands to the renderer; onUpgrade lets other features
   *   (guest signalling) claim their own WebSocket paths.
   */
  constructor(opts) {
    this.opts = opts;
    this.config = this.loadConfig();
    this.server = null;
    this.wss = null;
    this.state = null;
    this.thumbs = {};
    this.extraUpgrade = null;
  }

  loadConfig() {
    try {
      return { enabled: false, port: 8088, ...JSON.parse(fs.readFileSync(this.opts.configFile, 'utf8')) };
    } catch {
      return { enabled: false, port: 8088, token: crypto.randomBytes(8).toString('hex') };
    }
  }

  saveConfig() {
    fs.mkdirSync(path.dirname(this.opts.configFile), { recursive: true });
    fs.writeFileSync(this.opts.configFile, JSON.stringify(this.config, null, 2));
  }

  get running() {
    return !!this.server?.listening;
  }

  async info() {
    const urls = lanAddresses().map((ip) => `http://${ip}:${this.config.port}/remote?t=${this.config.token}`);
    const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220 }) : null;
    return {
      enabled: this.config.enabled,
      running: this.running,
      port: this.config.port,
      token: this.config.token,
      urls,
      apiBase: urls[0] ? `http://${urls[0].split('/')[2]}/api` : `http://localhost:${this.config.port}/api`,
      qr,
      clients: this.wss?.clients.size ?? 0,
      error: this.lastError ?? null,
    };
  }

  async configure({ enabled, port, regenerate }) {
    if (typeof port === 'number' && port >= 1024 && port <= 65535) this.config.port = port;
    if (regenerate || !this.config.token) this.config.token = crypto.randomBytes(8).toString('hex');
    if (typeof enabled === 'boolean') this.config.enabled = enabled;
    this.saveConfig();
    await this.stop();
    if (this.config.enabled) await this.start();
    return this.info();
  }

  authorized(url, req) {
    const token = url.searchParams.get('token') ?? url.searchParams.get('t') ?? req.headers['x-studiomix-token'];
    if (typeof token !== 'string' || token.length !== this.config.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.config.token));
  }

  async start() {
    this.lastError = null;
    const server = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://local');
      if (this.opts.onUpgrade?.(req, socket, head, url)) return;
      if (url.pathname !== '/ws' || !this.authorized(url, req)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
    await new Promise((resolve) => {
      server.once('error', (err) => {
        this.lastError = err.code === 'EADDRINUSE' ? `El puerto ${this.config.port} ya está en uso` : err.message;
        resolve();
      });
      server.listen(this.config.port, '0.0.0.0', resolve);
    });
    if (this.lastError) return;
    this.server = server;
    this.opts.send('api:clients', 0);
  }

  async stop() {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.wss = null;
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  connect(ws) {
    this.opts.send('api:clients', this.wss.clients.size);
    if (this.state) ws.send(JSON.stringify({ type: 'state', state: this.state }));
    if (Object.keys(this.thumbs).length) ws.send(JSON.stringify({ type: 'thumbs', thumbs: this.thumbs }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (COMMANDS.has(msg.cmd)) this.opts.send('api:command', { cmd: msg.cmd, args: msg.args ?? {} });
      } catch {
        // Ignore malformed messages.
      }
    });
    ws.on('close', () => this.opts.send('api:clients', this.wss?.clients.size ?? 0));
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.wss?.clients ?? []) if (ws.readyState === 1) ws.send(text);
  }

  setState(state) {
    this.state = state;
    this.broadcast({ type: 'state', state });
  }

  setThumbs(thumbs) {
    this.thumbs = thumbs;
    this.broadcast({ type: 'thumbs', thumbs });
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self'",
      'X-Content-Type-Options': 'nosniff',
    };
    const fileEntry = STATIC[url.pathname];
    if (fileEntry) {
      res.writeHead(200, { ...headers, 'Content-Type': fileEntry[1] });
      fs.createReadStream(path.join(REMOTE_DIR, fileEntry[0])).pipe(res);
      return;
    }
    if (!url.pathname.startsWith('/api')) {
      res.writeHead(url.pathname === '/' ? 302 : 404, { ...headers, Location: '/remote' });
      res.end();
      return;
    }
    const json = (status, body) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (!this.authorized(url, req)) return json(401, { ok: false, error: 'Token incorrecto o ausente (?token=…)' });
    const cmd = url.pathname.replace(/^\/api\/?/, '');
    if (cmd === '' || cmd === 'state') return json(200, { ok: true, state: this.state });
    if (!COMMANDS.has(cmd)) return json(404, { ok: false, error: `Comando desconocido: ${cmd}`, commands: [...COMMANDS] });
    const args = Object.fromEntries(url.searchParams);
    delete args.token;
    delete args.t;
    this.opts.send('api:command', { cmd, args });
    return json(200, { ok: true, cmd, args });
  }
}

module.exports = { RemoteServer, lanAddresses };
