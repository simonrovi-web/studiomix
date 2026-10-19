// Vertical (9:16) output: second canvas composed alongside Program, with its
// own destinations, stream and recording.
import { app, byId, saveSettings, state } from './store.js';
import { fillSelect, toast } from './ui-common.js';
import { $, fmtTime, h } from './util.js';

const runtime = { inputId: null, overlayId: null };

const validUrl = (url) => /^rtmps?:\/\/.+/i.test(url || '');

function verticalActive() {
  return state.view === 'vertical' || !!app.outputs.get('vstream') || !!app.outputs.get('vrecord');
}

function config() {
  if (!verticalActive()) return null;
  const v = state.settings.vertical;
  return { mode: v.mode, panX: v.panX, inputId: runtime.inputId, overlayId: runtime.overlayId };
}

function renderDestinations() {
  const list = state.settings.verticalDestinations;
  $('#v-dests').replaceChildren(
    ...(list.length
      ? list.map((d, i) =>
          h('div', { class: 'dest-row' },
            h('input', { type: 'checkbox', checked: d.enabled, title: 'Activo', onchange: (e) => { d.enabled = e.target.checked; saveSettings(); render(); } }),
            h('input', { value: d.name, placeholder: 'Nombre', oninput: (e) => { d.name = e.target.value; saveSettings(); } }),
            h('input', { value: d.url, placeholder: 'rtmp://servidor/app', oninput: (e) => { d.url = e.target.value.trim(); saveSettings(); render(); } }),
            h('button', { type: 'button', title: 'Quitar destino', onclick: () => { list.splice(i, 1); saveSettings(); renderDestinations(); render(); } }, '✕'),
            h('span'),
            h('input', { class: 'key', type: 'password', value: d.key, placeholder: 'Clave de emisión', autocomplete: 'off', oninput: (e) => { d.key = e.target.value.trim(); saveSettings(); render(); } }),
          ),
        )
      : [h('p', { class: 'muted small' }, 'Sin destinos verticales.')]),
  );
}

function renderSelects() {
  const visual = state.inputs.filter((i) => i.hasVideo);
  if (runtime.inputId != null && !byId(runtime.inputId)) runtime.inputId = null;
  if (runtime.overlayId != null && !byId(runtime.overlayId)) runtime.overlayId = null;
  const options = visual.map((i) => [String(i.id), i.name]);
  const inputSel = $('#v-input');
  const overlaySel = $('#v-overlay');
  if (document.activeElement !== inputSel) fillSelect(inputSel, [['', 'Elige una entrada…'], ...options], String(runtime.inputId ?? ''));
  if (document.activeElement !== overlaySel) fillSelect(overlaySel, [['', 'Ninguna'], ...options], String(runtime.overlayId ?? ''));
}

function ready() {
  return state.settings.verticalDestinations.some((d) => d.enabled && d.key && validUrl(d.url));
}

export function render() {
  const v = state.settings.vertical;
  $('#v-mode').value = v.mode;
  $('#v-pan').value = v.panX;
  $('#v-pan-field').hidden = v.mode !== 'reframe';
  $('#v-input-field').hidden = v.mode !== 'input';
  $('#v-kbps').value = state.settings.verticalKbps;
  renderSelects();

  const stream = app.outputs.get('vstream');
  const record = app.outputs.get('vrecord');
  const reconnecting = app.outputs.isReconnecting('vstream');
  const sBtn = $('#btn-vstream');
  sBtn.textContent = stream ? (reconnecting ? 'Reconectando… (parar)' : `■ Parar vertical ${fmtTime(app.outputs.elapsed(stream))}`) : '● Emitir vertical';
  sBtn.disabled = !!stream?.stopping || (!stream && !ready());
  sBtn.title = !stream && !ready() ? 'Añade un destino vertical con su clave' : '';
  const rBtn = $('#btn-vrecord');
  rBtn.textContent = record ? `■ Parar ${fmtTime(app.outputs.elapsed(record))}` : '⏺ Grabar vertical';
  rBtn.classList.toggle('on', !!record);
  $('.vertical-mon').classList.toggle('live', !!stream);
  $('#view-vertical').classList.toggle('live', !!stream || !!record);
  $('#vertical-status').textContent = [stream ? 'EN DIRECTO' : '', record ? 'GRABANDO' : ''].filter(Boolean).join(' · ');
  $('#v-info').textContent = stream?.stats?.bitrate ? `Enviando ${stream.stats.bitrate}` : '';
}

export function initVertical() {
  app.compositor.verticalConfig = config;
  // Show the composed vertical canvas itself in its monitor (no extra copy).
  $('#vertical-screen').append(app.compositor.vertical);

  $('#v-mode').addEventListener('change', (e) => {
    state.settings.vertical.mode = e.target.value;
    saveSettings();
    render();
  });
  $('#v-pan').addEventListener('input', (e) => {
    state.settings.vertical.panX = Number(e.target.value);
    saveSettings();
  });
  $('#v-input').addEventListener('change', (e) => {
    runtime.inputId = e.target.value ? Number(e.target.value) : null;
  });
  $('#v-overlay').addEventListener('change', (e) => {
    runtime.overlayId = e.target.value ? Number(e.target.value) : null;
  });
  $('#v-kbps').addEventListener('change', (e) => {
    state.settings.verticalKbps = Math.min(20000, Math.max(1000, Number(e.target.value) || 4500));
    saveSettings();
  });
  $('#v-dest-preset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [name, url] = e.target.value.split('|');
    state.settings.verticalDestinations.push({ id: Date.now(), enabled: true, name, url, key: '' });
    e.target.value = '';
    saveSettings();
    renderDestinations();
    render();
  });
  $('#btn-vstream').addEventListener('click', async () => {
    try {
      if (app.outputs.get('vstream')) {
        if (confirm('¿Detener la emisión vertical?')) await app.outputs.stop('vstream');
      } else {
        app.audio.resume();
        await app.outputs.start('vstream');
        toast('Emisión vertical en directo.');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-vrecord').addEventListener('click', async () => {
    try {
      if (app.outputs.get('vrecord')) await app.outputs.stop('vrecord');
      else await app.outputs.start('vrecord', { kind: 'record', label: 'vertical', tracks: [app.compositor.verticalTrack, app.audio.outputTrack] });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  renderDestinations();
  render();
}
