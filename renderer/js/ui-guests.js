// Remote guests: accepts WebRTC connections relayed by the main process,
// turns each guest into an input, and sends them the program video plus a
// mix-minus (the show's audio without their own voice).
import { GuestInput } from './inputs.js';
import { app, changed, state } from './store.js';
import { ask, confirmAction, toast } from './ui-common.js';
import { $, h } from './util.js';

const peers = new Map(); // guestId -> { pc, name, stream, input, mixMinus }
// Public STUN lets guests on other networks find a direct path (most home and
// mobile networks). Same network keeps using local addresses.
export const ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

function createPeer(guestId) {
  const peer = peers.get(guestId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer.pc = pc;
  peer.stream = new MediaStream();
  peer.mixMinus = app.audio.createMixMinus();
  // Return feed: what goes on air, and the mix without the guest.
  pc.addTrack(app.compositor.videoTrack, new MediaStream([app.compositor.videoTrack]));
  pc.addTrack(peer.mixMinus.track, new MediaStream([peer.mixMinus.track]));
  pc.onicecandidate = (e) => e.candidate && window.studio.guestSignal(guestId, { type: 'candidate', candidate: e.candidate.toJSON() });
  pc.ontrack = (e) => {
    peer.stream.addTrack(e.track);
    // Create the input once video has arrived (audio may come first or not at all).
    if (e.track.kind === 'video' && !peer.input) {
      setTimeout(() => addGuestInput(guestId), 150);
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toast(`No se pudo conectar con ${peer.name}. Su red no permite la conexión directa; prueba con otra red (por ejemplo, datos móviles) o con Tailscale.`, 'error');
  };
  return pc;
}

function addGuestInput(guestId) {
  const peer = peers.get(guestId);
  if (!peer || peer.input) return;
  const input = new GuestInput(peer.stream, peer.name, guestId);
  peer.input = input;
  app.actions.addInput(input, { select: false });
  if (input.channel) peer.mixMinus.exclude(input.channel);
  toast(`${peer.name} se ha unido como invitado.`);
  changed();
}

async function onSignal({ guestId, data }) {
  const peer = peers.get(guestId);
  if (!peer) return;
  try {
    if (data.type === 'offer') {
      const pc = createPeer(guestId);
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      window.studio.guestSignal(guestId, { type: 'answer', sdp: pc.localDescription.toJSON() });
    } else if (data.type === 'candidate' && data.candidate && peer.pc) {
      await peer.pc.addIceCandidate(data.candidate).catch((err) => console.warn('Candidato ICE rechazado', guestId, err));
    }
  } catch (err) {
    console.warn('Invitado', err);
  }
}

function onJoin({ guestId, name }) {
  peers.set(guestId, { name, pc: null, stream: null, input: null, mixMinus: null });
  renderDialog();
}

function onLeave({ guestId }) {
  const peer = peers.get(guestId);
  if (!peer) return;
  peers.delete(guestId);
  peer.pc?.close();
  peer.mixMinus?.dispose();
  if (peer.input && state.inputs.includes(peer.input)) {
    app.actions.removeInput(peer.input);
    toast(`${peer.name} ha salido.`);
  }
  renderDialog();
}

let dialogOpen = false;

const copyable = (u) => h('code', { class: 'copyable', title: 'Clic para copiar', onclick: () => navigator.clipboard.writeText(u).then(() => toast('Enlace copiado')) }, u);

async function openTunnel(tunnel) {
  if (!tunnel.installed) {
    const ok = await confirmAction(`Para el enlace por internet se descarga una vez cloudflared (de Cloudflare, en GitHub, ${tunnel.downloadMB} MB) y se comprueba su firma SHA-256. No necesita cuenta. ¿Descargar y abrir el enlace?`, { ok: 'Descargar y abrir' });
    if (!ok) return;
  }
  renderDialog(await window.studio.guestsTunnel(true));
}

/** Link through a Cloudflare tunnel: the guest only opens it, from any network. */
function internetSection(tunnel, info) {
  const title = h('h4', {}, 'Invitados por internet (sin instalar nada)');
  if (tunnel.state === 'ready' && info.publicUrl) {
    return h('div', { class: 'stack' }, title,
      h('div', { class: 'remote-qr' },
        info.publicQr ? h('img', { src: info.publicQr, alt: 'Código QR de invitación por internet' }) : null,
        h('div', { class: 'stack' },
          copyable(info.publicUrl),
          h('p', { class: 'muted small' }, 'Envía este enlace a tu invitado (WhatsApp, correo…). Lo abre en el navegador del móvil o del ordenador, desde cualquier red, sin avisos de seguridad. Quien tenga el enlace puede entrar: compártelo solo con tus invitados. El enlace cambia cada vez que lo abres.'),
          h('button', { type: 'button', onclick: async () => renderDialog(await window.studio.guestsTunnel(false)) }, 'Cerrar el enlace por internet'),
        ),
      ),
    );
  }
  const busy = tunnel.state === 'downloading' ? `Descargando cloudflared… ${tunnel.progress}%` : tunnel.state === 'starting' ? 'Publicando el enlace en Cloudflare (puede tardar hasta un minuto)…' : null;
  return h('div', { class: 'stack' }, title,
    h('p', { class: 'muted small' }, 'Crea un enlace público https para invitados de otras casas o ciudades. El vídeo y el audio van directos entre los equipos; algunas redes muy cerradas (empresas, ciertas operadoras) no lo permiten y entonces queda Tailscale.'),
    tunnel.state === 'error' ? h('p', { class: 'warn-text' }, tunnel.error) : null,
    busy ? h('p', {}, busy) : h('button', { type: 'button', class: 'accent', onclick: () => openTunnel(tunnel) }, tunnel.state === 'error' ? 'Reintentar' : 'Abrir enlace por internet'),
  );
}

async function renderDialog(info) {
  if (!dialogOpen) return;
  info ??= await window.studio.guestsInfo();
  const box = $('#guests-body');
  $('#guests-enabled').checked = info.running;
  if (!info.running) {
    box.replaceChildren(
      h('p', { class: 'muted' }, 'Activa los invitados para que alguien entre en el directo desde el navegador de su móvil u ordenador, sin instalar nada. Funciona en la misma red (wifi o cable).'),
      info.error ? h('p', { class: 'warn-text' }, `No se pudo iniciar: ${info.error}`) : null,
    );
    return;
  }
  box.replaceChildren(
    h('div', { class: 'remote-qr' },
      info.qr ? h('img', { src: info.qr, alt: 'Código QR de invitación' }) : null,
      h('div', { class: 'stack' },
        h('strong', {}, 'Enlace de invitación'),
        ...info.urls.map((u) => h('code', { class: 'copyable', title: 'Clic para copiar', onclick: () => navigator.clipboard.writeText(u).then(() => toast('Enlace copiado')) }, u)),
        h('p', { class: 'muted small' }, 'El invitado verá un aviso de seguridad la primera vez (el certificado es de este equipo): debe pulsar «Configuración avanzada» → «Continuar». Recibe lo que se emite y oye el programa sin su propia voz.'),
      ),
    ),
    internetSection(info.tunnel, info),
    h('h4', {}, 'Invitados fuera de tu red (Tailscale)'),
    info.tailscaleUrls?.length
      ? h('div', { class: 'remote-qr' },
          info.tailscaleQr ? h('img', { src: info.tailscaleQr, alt: 'Código QR de invitación por Tailscale' }) : null,
          h('div', { class: 'stack' },
            ...info.tailscaleUrls.map((u) => h('code', { class: 'copyable', title: 'Clic para copiar', onclick: () => navigator.clipboard.writeText(u).then(() => toast('Enlace copiado')) }, u)),
            h('p', { class: 'muted small' }, 'Para quien está en otra casa o ciudad: debe tener Tailscale instalado y abierto, unido a tu red de Tailscale (invítalo desde tu cuenta). Después abre este enlace como cualquier invitado.'),
          ),
        )
      : h('p', { class: 'muted small' },
          'Para traer invitados desde fuera de tu red sin servidor: instala Tailscale (gratis para uso personal) en este equipo y en el del invitado, y únelo a tu red. Cuando Tailscale esté activo aparecerá aquí su enlace. ',
          h('a', { href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener' }, 'Descargar Tailscale'),
        ),
    h('h4', {}, `Conectados (${peers.size})`),
    ...(peers.size
      ? [...peers.entries()].map(([id, p]) =>
          h('div', { class: 'row nowrap guest-row' },
            h('span', { class: 'grow' }, `👤 ${p.name}`),
            h('span', { class: 'muted small' }, p.pc?.connectionState ?? 'esperando…'),
            h('button', { type: 'button', onclick: () => window.studio.guestKick(id) }, 'Expulsar'),
          ),
        )
      : [h('p', { class: 'muted small' }, 'Nadie conectado todavía.')]),
    h('button', { type: 'button', onclick: async () => renderDialog(await window.studio.guestsEnable(true, { regenerate: true })) }, 'Crear un enlace nuevo (invalida el anterior)'),
  );
}

export async function openGuests() {
  const dlg = $('#dlg-guests');
  dialogOpen = true;
  $('#guests-enabled').onchange = async (e) => renderDialog(await window.studio.guestsEnable(e.target.checked));
  const timer = setInterval(() => renderDialog(), 2000);
  await renderDialog();
  await ask(dlg);
  clearInterval(timer);
  dialogOpen = false;
}

export function initGuests() {
  window.studio.onGuests({ join: onJoin, leave: onLeave, signal: onSignal });
  window.studio.onTunnelStatus(() => renderDialog());
  app.actions.openGuests = openGuests;
}
