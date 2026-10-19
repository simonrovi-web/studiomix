// Bridge between the local control server (HTTP API / WebSocket / phone remote)
// and the app: runs incoming commands, publishes state and thumbnails.
import { FADER_MAX } from './audio.js';
import { app, byId, changed, onChange, state } from './store.js';
import { ask, toast } from './ui-common.js';
import { $, debounce, fmtTime, h } from './util.js';

let clients = 0;

/** Finds an input by 1-based number or by (case-insensitive) name. */
function resolveInput(ref) {
  if (ref == null || ref === '') return null;
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1) return state.inputs[n - 1] ?? null;
  const name = String(ref).toLowerCase();
  return state.inputs.find((i) => i.name.toLowerCase() === name) ?? null;
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(FADER_MAX, Math.max(0, n))) : null;
}

const HANDLERS = {
  cut: () => app.actions.cut(),
  auto: () => app.actions.auto(),
  ftb: () => app.actions.ftb(),
  preview: ({ input }) => {
    const i = resolveInput(input);
    if (i) app.actions.setPreview(i.id);
  },
  program: ({ input }) => {
    const i = resolveInput(input);
    if (i) app.actions.cutTo(i.id);
  },
  overlay: ({ layer, input }) => {
    const index = Number(layer) - 1;
    if (!(index >= 0 && index < state.overlays.length)) return;
    const i = resolveInput(input);
    if (i) app.actions.toggleOverlay(index, i.id);
    else app.actions.overlayButton(index);
  },
  stream: ({ state: want = 'toggle' }) => {
    const live = !!app.outputs.get('stream');
    if (want === 'toggle' || (want === 'start' && !live) || (want === 'stop' && live)) {
      if (live) app.outputs.stop('stream');
      else app.actions.toggleOutput('stream');
    }
  },
  record: ({ state: want = 'toggle' }) => {
    const on = !!app.outputs.get('record');
    if (want === 'toggle' || (want === 'start' && !on) || (want === 'stop' && on)) app.actions.toggleOutput('record');
  },
  pause: () => app.actions.togglePause(),
  replay: () => app.actions.toggleReplay(),
  replaySave: () => app.actions.saveReplay(),
  snapshot: () => app.actions.snapshot(),
  volume: ({ input, channel, value }) => {
    const i = resolveInput(input ?? channel);
    const v = clampVolume(value);
    if (!i?.channel || v == null) return;
    i.channel.volume = v;
    i.channel.apply();
  },
  mute: ({ input, channel, state: want = 'toggle' }) => {
    const ch = resolveInput(input ?? channel)?.channel;
    if (!ch) return;
    ch.muted = want === 'toggle' ? !ch.muted : want === 'on';
    ch.apply();
  },
  masterVolume: ({ value }) => {
    const v = clampVolume(value);
    if (v == null) return;
    app.audio.volume = v;
    app.audio.applyMaster();
  },
  transition: ({ type, duration }) => {
    if (type) state.transition.type = type;
    if (Number(duration) > 0) state.transition.duration = Math.min(5000, Math.max(100, Number(duration)));
  },
  titleNext: ({ input }) => {
    const i = resolveInput(input);
    if (i?.showRow) i.showRow((i.fields.listIndex ?? 0) + 1);
  },
  titlePrev: ({ input }) => {
    const i = resolveInput(input);
    if (i?.showRow) i.showRow((i.fields.listIndex ?? 0) - 1);
  },
};

function snapshotState() {
  const stream = app.outputs.get('stream');
  const record = app.outputs.get('record');
  const layerOf = (id) => state.overlays.findIndex((ov) => ov.inputId === id && ov.target > 0) + 1;
  return {
    programName: byId(state.programId)?.name ?? null,
    previewName: byId(state.previewId)?.name ?? null,
    inputs: state.inputs.map((input, index) => ({
      n: index + 1,
      id: input.id,
      name: input.name,
      type: input.type,
      hasVideo: input.hasVideo,
      hasAudio: !!input.channel,
      program: input.id === state.programId,
      preview: input.id === state.previewId,
      overlay: layerOf(input.id),
      volume: input.channel?.volume ?? null,
      muted: input.channel?.muted ?? null,
      list: input.listInfo || null,
    })),
    overlays: state.overlays.map((ov) => ({ active: ov.inputId != null && ov.target > 0, input: byId(ov.inputId)?.name ?? null })),
    ftb: state.ftb.target > 0,
    transition: { type: state.transition.type, duration: state.transition.duration },
    stream: { live: !!stream, reconnecting: app.outputs.isReconnecting('stream'), time: stream ? fmtTime(app.outputs.elapsed(stream)) : null },
    record: { on: !!record, paused: app.outputs.isPaused('record'), time: record ? fmtTime(app.outputs.elapsed(record)) : null },
    replay: !!app.outputs.get('replay'),
    masterVolume: app.audio.volume,
  };
}

const publish = debounce(() => window.studio.publishState(snapshotState()), 120);

function publishThumbs() {
  if (!clients) return;
  const thumbs = {};
  for (const [id, thumb] of app.compositor.thumbs) {
    try {
      thumbs[id] = thumb.canvas.toDataURL('image/jpeg', 0.55);
    } catch {
      // Canvas not ready.
    }
  }
  window.studio.publishThumbs(thumbs);
}

function renderChip(info) {
  const chip = $('#chip-remote');
  chip.hidden = !info?.running;
  chip.textContent = clients ? `Remoto · ${clients}` : 'Remoto';
  chip.className = `chip ${clients ? 'good' : ''}`;
}

export async function openRemoteDialog() {
  const dlg = $('#dlg-remote');
  const form = dlg.querySelector('form');
  const render = async (info) => {
    info ??= await window.studio.remoteInfo();
    form.enabled.checked = info.enabled;
    form.port.value = info.port;
    renderChip(info);
    const box = $('#remote-body');
    if (!info.enabled) {
      box.replaceChildren(h('p', { class: 'muted' }, 'Actívalo para controlar StudioMix desde el móvil, una tablet, un Stream Deck (con Bitfocus Companion) o tus propios scripts. Solo es accesible en tu red local y pide un código.'));
      return;
    }
    if (!info.running) {
      box.replaceChildren(h('p', { class: 'warn-text' }, `No se pudo iniciar: ${info.error ?? 'error desconocido'}`));
      return;
    }
    const api = (cmd, q = '') => `${info.apiBase}/${cmd}?token=${info.token}${q}`;
    box.replaceChildren(
      h('div', { class: 'remote-qr' },
        info.qr ? h('img', { src: info.qr, alt: 'Código QR del mando' }) : null,
        h('div', { class: 'stack' },
          h('strong', {}, 'Mando en el móvil'),
          h('p', { class: 'muted small' }, 'Escanea el código con la cámara del móvil (en la misma red wifi) o abre esta dirección:'),
          ...info.urls.map((u) => h('code', { class: 'copyable', title: 'Clic para copiar', onclick: () => navigator.clipboard.writeText(u).then(() => toast('Dirección copiada')) }, u)),
          h('p', { class: 'muted small' }, `Conectados ahora: ${info.clients}. La primera vez, Windows puede pedir permiso en el cortafuegos: acepta para redes privadas.`),
        ),
      ),
      h('details', {},
        h('summary', {}, 'API para Stream Deck, Companion y scripts'),
        h('p', { class: 'muted small' }, 'En Bitfocus Companion usa el módulo «Generic HTTP» con peticiones GET. Las entradas se indican por número o por nombre.'),
        h('table', { class: 'api-table' },
          ...[
            ['Cut', api('cut')],
            ['Auto', api('auto')],
            ['Entrada 2 a Preview', api('preview', '&input=2')],
            ['Entrada 2 al aire', api('program', '&input=2')],
            ['Capa 1 (con Preview)', api('overlay', '&layer=1')],
            ['Negro', api('ftb')],
            ['Grabar / parar', api('record')],
            ['Emitir / parar', api('stream')],
            ['Guardar repetición', api('replaySave')],
            ['Volumen entrada 3 a 80', api('volume', '&input=3&value=80')],
            ['Silenciar entrada 3', api('mute', '&input=3')],
            ['Siguiente rótulo de la lista', api('titleNext', '&input=4')],
            ['Estado (JSON)', api('state')],
          ].map(([label, url]) => h('tr', {}, h('td', {}, label), h('td', {}, h('code', { class: 'copyable', onclick: () => navigator.clipboard.writeText(url).then(() => toast('URL copiada')) }, url)))),
        ),
      ),
      h('button', {
        type: 'button',
        onclick: async () => render(await window.studio.remoteConfigure({ regenerate: true })),
      }, 'Cambiar el código de acceso'),
    );
  };
  form.onchange = async () => {
    const info = await window.studio.remoteConfigure({ enabled: form.enabled.checked, port: Number(form.port.value) });
    render(info);
  };
  await render();
  await ask(dlg);
  form.onchange = null;
}

export function initRemote() {
  window.studio.onApiCommand(({ cmd, args }) => {
    try {
      HANDLERS[cmd]?.(args ?? {});
      changed();
    } catch (err) {
      console.warn('Comando remoto', cmd, err);
    }
  });
  window.studio.onApiClients((count) => {
    clients = count;
    renderChip({ running: true });
    publish();
  });
  onChange(publish);
  setInterval(() => {
    publish();
    publishThumbs();
  }, 1000);
  window.studio.remoteInfo().then(renderChip);
  app.actions.openRemote = openRemoteDialog;
}
