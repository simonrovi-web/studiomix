// StudioMix guest page: camera + mic to the studio over WebRTC, and the
// program (video + mix-minus audio) back.
(() => {
  const code = new URLSearchParams(location.search).get('c') || '';
  const $ = (s) => document.querySelector(s);
  let local = null;
  let pc = null;
  let ws = null;

  async function listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind) => {
      select.replaceChildren(
        ...devices.filter((d) => d.kind === kind).map((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `${kind === 'videoinput' ? 'Cámara' : 'Micrófono'} ${i + 1}`;
          return o;
        }),
      );
    };
    fill($('#camera'), 'videoinput');
    fill($('#mic'), 'audioinput');
  }

  async function openDevices() {
    local?.getTracks().forEach((t) => t.stop());
    local = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: $('#camera').value ? { exact: $('#camera').value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { deviceId: $('#mic').value ? { exact: $('#mic').value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    $('#self').srcObject = local;
    $('#self-small').srcObject = local;
  }

  function showError(text) {
    const el = $('#join-error');
    el.textContent = text;
    el.hidden = false;
  }

  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      showError('Abre el enlace completo que empieza por https:// para poder usar la cámara.');
      return;
    }
    try {
      await openDevices();
      await listDevices();
      $('#name').value = localStorage.getItem('studiomix-guest-name') || '';
    } catch (err) {
      showError(`No se pudo abrir la cámara o el micrófono: ${err.message}`);
    }
    $('#camera').onchange = openDevices;
    $('#mic').onchange = openDevices;
  }

  function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function setStatus(text, ok) {
    const el = $('#status');
    el.textContent = text;
    el.className = `pill ${ok ? 'ok' : ''}`;
  }

  async function enter() {
    const name = $('#name').value.trim() || 'Invitado';
    localStorage.setItem('studiomix-guest-name', name);
    if (!local) return showError('Primero permite el acceso a la cámara y el micrófono.');
    // One connection per page: a repeated tap must not join a second time.
    if (ws) return undefined;
    $('#enter').disabled = true;
    $('#join').hidden = true;
    $('#call').hidden = false;
    ws = new WebSocket(`wss://${location.host}/guest-ws?c=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`);
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'welcome') {
        // Public STUN finds a direct path from other networks; on the same network local addresses win.
        pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] });
        local.getTracks().forEach((t) => pc.addTrack(t, local));
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.onicecandidate = (ev) => ev.candidate && send({ type: 'candidate', candidate: ev.candidate });
        pc.ontrack = (ev) => {
          const program = $('#program');
          program.srcObject ??= new MediaStream();
          program.srcObject.addTrack(ev.track);
        };
        pc.onconnectionstatechange = () => {
          const s = pc.connectionState;
          setStatus(s === 'connected' ? 'En el estudio' : s === 'failed' ? 'Sin conexión' : 'Conectando…', s === 'connected');
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'offer', sdp: pc.localDescription });
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === 'candidate' && msg.candidate) {
        await pc.addIceCandidate(msg.candidate).catch(() => {});
      } else if (msg.type === 'kick') {
        leave('El realizador ha cerrado tu conexión.');
      }
    };
    ws.onclose = () => setStatus('Desconectado', false);
  }

  function leave(message) {
    pc?.close();
    ws?.close();
    local?.getTracks().forEach((t) => t.stop());
    document.body.innerHTML = `<main class="card"><h1>Has salido</h1><p class="muted">${message || 'Gracias por participar.'}</p></main>`;
  }

  $('#enter').addEventListener('click', enter);
  $('#leave').addEventListener('click', () => leave());
  $('#toggle-mic').addEventListener('click', (e) => {
    const track = local?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.currentTarget.classList.toggle('off', !track.enabled);
    e.currentTarget.textContent = track.enabled ? '🎙 Silenciar' : '🎙 Activar micro';
  });
  $('#toggle-cam').addEventListener('click', (e) => {
    const track = local?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.currentTarget.classList.toggle('off', !track.enabled);
    e.currentTarget.textContent = track.enabled ? '📷 Apagar cámara' : '📷 Encender cámara';
  });

  start();
})();
