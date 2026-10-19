// StudioMix phone/tablet remote. Talks to the app over the local WebSocket.
(() => {
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (s) => document.querySelector(s);
  let ws = null;
  let state = null;
  let thumbs = {};
  let retry = 0;

  function send(cmd, args = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd, args }));
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      retry = 0;
      setConn('Conectado', 'ok');
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.state;
        render();
      } else if (msg.type === 'thumbs') {
        thumbs = msg.thumbs;
        renderThumbs();
      }
    };
    ws.onclose = () => {
      setConn(token ? 'Sin conexión' : 'Falta el token', 'bad');
      retry = Math.min(retry + 1, 5);
      setTimeout(connect, retry * 1000);
    };
  }

  function setConn(text, cls) {
    const el = $('#conn');
    el.textContent = text;
    el.className = `pill ${cls}`;
  }

  function tile(input) {
    const btn = document.createElement('button');
    btn.className = 'tile';
    btn.dataset.id = input.id;
    const img = document.createElement('img');
    img.alt = '';
    const tally = document.createElement('span');
    tally.className = 'tally';
    const label = document.createElement('span');
    label.className = 'label';
    btn.append(img, tally, label);
    // Tap = Preview; long press = straight to Program.
    let timer = 0;
    let long = false;
    btn.addEventListener('pointerdown', () => {
      long = false;
      timer = setTimeout(() => {
        long = true;
        send('program', { input: input.n });
      }, 550);
    });
    btn.addEventListener('pointerup', () => {
      clearTimeout(timer);
      if (!long) send('preview', { input: input.n });
    });
    btn.addEventListener('pointerleave', () => clearTimeout(timer));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    return btn;
  }

  function render() {
    if (!state) return;
    $('#pvw-name').textContent = state.previewName || '—';
    $('#pgm-name').textContent = state.programName || '—';
    $('#live').classList.toggle('on', !!state.stream.live);
    $('#live').textContent = state.stream.reconnecting ? 'RECONECTANDO' : state.stream.live ? `EN DIRECTO ${state.stream.time}` : 'EMISIÓN';
    $('#rec').classList.toggle('on', !!state.record.on);
    $('#rec').textContent = state.record.on ? `REC ${state.record.time}` : 'REC';

    const box = $('#inputs');
    const visual = state.inputs.filter((i) => i.hasVideo);
    const existing = new Map([...box.children].map((el) => [Number(el.dataset.id), el]));
    const wanted = visual.map((input) => {
      const el = existing.get(input.id) ?? tile(input);
      el.className = `tile ${input.program ? 'program' : input.preview ? 'preview' : input.overlay ? 'overlay' : ''}`;
      el.querySelector('.tally').textContent = input.program ? 'AL AIRE' : input.preview ? 'PREVIEW' : input.overlay ? `CAPA ${input.overlay}` : '';
      el.querySelector('.label').textContent = `${input.n}  ${input.name}`;
      return el;
    });
    if (wanted.length !== box.children.length || wanted.some((el, i) => box.children[i] !== el)) box.replaceChildren(...wanted);
    renderThumbs();

    document.querySelectorAll('[data-layer]').forEach((btn) => {
      btn.classList.toggle('on', state.overlays[Number(btn.dataset.layer) - 1]?.active);
    });
    $('#ftb').classList.toggle('on', state.ftb);
    $('#stream').textContent = state.stream.live ? '■ Parar emisión' : '● Emitir';
    $('#stream').classList.toggle('live', !!state.stream.live);
    $('#record').textContent = state.record.on ? '■ Parar grabación' : '⏺ Grabar';
    $('#record').classList.toggle('on', !!state.record.on);
    $('#replay-save').disabled = !state.replay;

    const master = $('#master');
    if (document.activeElement !== master) master.value = state.masterVolume;
    const chBox = $('#channels');
    const audioInputs = state.inputs.filter((i) => i.hasAudio);
    if (chBox.children.length !== audioInputs.length) {
      chBox.replaceChildren(
        ...audioInputs.map((input) => {
          const label = document.createElement('label');
          label.className = 'fader';
          label.dataset.id = input.id;
          const name = document.createElement('span');
          const range = document.createElement('input');
          range.type = 'range';
          range.min = 0;
          range.max = 125;
          range.addEventListener('input', () => send('volume', { input: input.n, value: Number(range.value) }));
          const mute = document.createElement('button');
          mute.type = 'button';
          mute.textContent = 'M';
          mute.addEventListener('click', () => send('mute', { input: input.n }));
          label.append(name, range, mute);
          return label;
        }),
      );
    }
    audioInputs.forEach((input, i) => {
      const row = chBox.children[i];
      row.querySelector('span').textContent = input.name;
      const range = row.querySelector('input');
      if (document.activeElement !== range) range.value = input.volume;
      row.querySelector('button').classList.toggle('on', input.muted);
    });
  }

  function renderThumbs() {
    for (const el of $('#inputs').children) {
      const src = thumbs[el.dataset.id];
      const img = el.querySelector('img');
      if (src && img.src !== src) img.src = src;
    }
  }

  $('#cut').addEventListener('click', () => send('cut'));
  $('#auto').addEventListener('click', () => send('auto'));
  $('#ftb').addEventListener('click', () => send('ftb'));
  $('#snapshot').addEventListener('click', () => send('snapshot'));
  $('#replay-save').addEventListener('click', () => send('replaySave'));
  document.querySelectorAll('[data-layer]').forEach((btn) => btn.addEventListener('click', () => send('overlay', { layer: Number(btn.dataset.layer) })));
  $('#master').addEventListener('input', (e) => send('masterVolume', { value: Number(e.target.value) }));
  $('#record').addEventListener('click', () => send('record', { state: 'toggle' }));
  $('#stream').addEventListener('click', () => {
    const live = state?.stream.live;
    if (confirm(live ? '¿Detener la emisión en directo?' : '¿Empezar a emitir en directo?')) send('stream', { state: live ? 'stop' : 'start' });
  });

  connect();
})();
