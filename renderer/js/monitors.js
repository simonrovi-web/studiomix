// Phone monitors: a phone with the remote page open asks for Program, Preview
// or Multiview and gets it over WebRTC (signalling relayed by the remote
// server), with the program sound it can unmute. Low latency, LAN only.

import { app } from './store.js';

const MAX_MONITORS = 4;
const MAX_HEIGHT = 720;
const MAX_BITRATE = 2_500_000;
const SOURCES = new Set(['program', 'preview', 'multiview']);

const peers = new Map(); // clientId -> { pc, source, video: RTCRtpSender }
let onChange = null;

const send = (clientId, data) => window.studio.monitorSignal(clientId, data);

function canvasHeight(source) {
  const { compositor } = app;
  return { program: compositor.program, preview: compositor.preview, multiview: compositor.multiview }[source].height;
}

/** Scales big sources down to 720p: plenty for a phone, and cheap to encode. */
async function tuneVideo(sender, source) {
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  params.encodings[0].scaleResolutionDownBy = Math.max(1, canvasHeight(source) / MAX_HEIGHT);
  params.encodings[0].maxBitrate = MAX_BITRATE;
  params.encodings[0].maxFramerate = 30;
  await sender.setParameters(params);
}

function stop(clientId) {
  const peer = peers.get(clientId);
  if (!peer) return;
  peers.delete(clientId);
  peer.pc.close();
  app.compositor.watch(peer.source, -1);
  onChange?.();
}

async function start(clientId, source) {
  stop(clientId);
  if (peers.size >= MAX_MONITORS) {
    send(clientId, { type: 'error', message: `Ya hay ${MAX_MONITORS} monitores conectados.` });
    return;
  }
  const { compositor, audio } = app;
  const pc = new RTCPeerConnection({ iceServers: [] });
  compositor.watch(source, 1);
  // Watching Preview makes it full size, so measure after watch().
  const stream = new MediaStream();
  const video = pc.addTransceiver(compositor.monitorTrack(source), {
    direction: 'sendonly',
    streams: [stream],
    sendEncodings: [{ maxBitrate: MAX_BITRATE, maxFramerate: 30, scaleResolutionDownBy: Math.max(1, canvasHeight(source) / MAX_HEIGHT) }],
  }).sender;
  pc.addTransceiver(audio.outputTrack, { direction: 'sendonly', streams: [stream] });
  const peer = { pc, source, video };
  peers.set(clientId, peer);
  pc.onicecandidate = (e) => e.candidate && send(clientId, { type: 'candidate', candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      console.warn('Monitor del móvil: la conexión WebRTC falló', clientId);
      send(clientId, { type: 'error', message: 'No se pudo conectar el vídeo. ¿Está el móvil en la misma red?' });
      stop(clientId);
    }
    onChange?.();
  };
  await pc.setLocalDescription(await pc.createOffer());
  send(clientId, { type: 'offer', sdp: pc.localDescription.toJSON() });
  onChange?.();
}

async function switchSource(clientId, source) {
  const peer = peers.get(clientId);
  if (!peer || peer.source === source) return;
  app.compositor.watch(source, 1);
  await peer.video.replaceTrack(app.compositor.monitorTrack(source));
  app.compositor.watch(peer.source, -1);
  peer.source = source;
  await tuneVideo(peer.video, source);
  onChange?.();
}

async function onSignal({ clientId, data }) {
  try {
    const source = SOURCES.has(data.source) ? data.source : 'program';
    switch (data.type) {
      case 'start':
        await start(clientId, source);
        break;
      case 'source':
        await switchSource(clientId, source);
        break;
      case 'answer':
        await peers.get(clientId)?.pc.setRemoteDescription(data.sdp);
        break;
      case 'candidate':
        if (data.candidate) await peers.get(clientId)?.pc.addIceCandidate(data.candidate);
        break;
      case 'stop':
        stop(clientId);
        break;
      default:
    }
  } catch (err) {
    console.warn('Monitor del móvil', data?.type, err);
    send(clientId, { type: 'error', message: err.message });
  }
}

/** Connected phone monitors and what each one watches. */
export function monitorList() {
  return [...peers.values()].map((p) => ({ source: p.source, state: p.pc.connectionState }));
}

export function initMonitors(listener) {
  onChange = listener;
  window.studio.onMonitorSignal(onSignal);
  // Phones that were watching before a reload ask again for a fresh connection.
  send('*', { type: 'restart' });
}
