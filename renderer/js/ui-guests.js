// Remote guests: accepts WebRTC connections relayed by the main process,
// turns each guest into an input, and sends them the program video plus a
// mix-minus (the show's audio without their own voice).
import { GuestInput } from './inputs.js';
import { app, changed, state } from './store.js';
import { ask, toast } from './ui-common.js';
import { $, h } from './util.js';

const peers = new Map(); // guestId -> { pc, name, stream, input, mixMinus }

function createPeer(guestId) {
  const peer = peers.get(guestId);
  const pc = new RTCPeerConnection({ iceServers: [] });
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
    if (pc.connectionState === 'failed') toast(`No se pudo conectar con ${peer.name}. ¿Está en la misma red?`, 'error');
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
  app.actions.openGuests = openGuests;
}
