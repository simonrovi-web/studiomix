// Top-bar output buttons (stream, record, replay) and the settings dialog.

import { DEFAULT_SETTINGS, app, changed, saveSettings, state } from './store.js';
import { ask, fillSelect, toast } from './ui-common.js';
import { setLimiter } from './ui-mixer.js';
import { destinationReady } from './ui-guide.js';
import { render as renderVertical } from './ui-vertical.js';
import { $, fmtTime, h } from './util.js';

export const ENCODER_LABELS = {
  auto: 'Automático (GPU si está disponible)',
  x264: 'x264 (CPU)',
  nvenc: 'NVIDIA NVENC (GPU)',
  qsv: 'Intel Quick Sync (GPU)',
  amf: 'AMD AMF (GPU)',
};

// Filled in at start-up from the main process.
const system = { info: { defaultRecordFolder: '', ffmpeg: '' }, encoders: ['x264'] };

export function initOutputs() {
  window.studio.info().then((info) => {
    system.info = info;
    renderOutputs();
  });
  window.studio.encoders().then((list) => {
    system.encoders = list;
  });
  $('#btn-settings').addEventListener('click', openSettings);
  setInterval(renderOutputs, 500);
  renderOutputs();
}

function describeOutput(kind) {
  const { outputs } = app;
  const entry = outputs.get(kind);
  const s = state.settings;
  if (!entry) {
    if (kind === 'record') {
      const folder = s.recordFolder || system.info.defaultRecordFolder;
      return `Detenido · ${s.recordFormat.toUpperCase()} · ${folder}`;
    }
    const active = s.destinations.filter((d) => d.enabled);
    return active.length ? `Detenido · ${active.map((d) => d.name).join(', ')}` : 'Configura los destinos en Ajustes';
  }
  if (entry.stopping) return 'Deteniendo…';
  if (outputs.isReconnecting(kind)) {
    if (!entry.retryAt) return `Reconectando (intento ${entry.attempt})… · ${fmtTime(outputs.elapsed(entry))}`;
    const secs = Math.max(0, Math.ceil((entry.retryAt - performance.now()) / 1000));
    return `Reconectando en ${secs} s (intento ${entry.attempt}) · ${fmtTime(outputs.elapsed(entry))}`;
  }
  const st = entry.stats;
  if (kind === 'replay') return `Guardando los últimos ${s.replaySeconds} s · pulsa 💾 o R`;
  const parts = [fmtTime(outputs.elapsed(entry))];
  if (outputs.isPaused(kind)) parts.unshift('EN PAUSA');
  if (st?.bitrate) parts.push(st.bitrate);
  if (st?.speed) parts.push(st.speed);
  if (Number(st?.drop) > 0) parts.push(`${st.drop} descartados`);
  if (kind === 'stream' && entry.encoder) parts.push(ENCODER_LABELS[entry.encoder]?.replace(/ \(.*\)/, '') ?? entry.encoder);
  if (kind === 'record' && entry.file) parts.push(entry.file.split(/[\\/]/).pop());
  return parts.join(' · ');
}

/**
 * Each button shows its state in place (one location for starting and
 * monitoring an output); the long description goes in the tooltip.
 */
export function renderOutputs() {
  const { outputs } = app;
  const stream = outputs.get('stream');
  const streamBtn = $('#btn-stream');
  const reconnecting = outputs.isReconnecting('stream');
  streamBtn.classList.toggle('on', !!stream && !reconnecting);
  streamBtn.classList.toggle('reconnecting', reconnecting);
  streamBtn.classList.toggle('ready', !stream && destinationReady());
  streamBtn.disabled = !!stream?.stopping;
  $('.out-label', streamBtn).textContent = reconnecting ? 'RECONECTANDO' : stream ? 'EN DIRECTO' : 'Emitir';
  $('#stream-info').textContent = stream && !stream.stopping
    ? [fmtTime(outputs.elapsed(stream)), stream.stats?.bitrate?.replace(/kbits\/s/, ' kb/s')].filter(Boolean).join(' · ')
    : '';
  streamBtn.title = `${describeOutput('stream')}${stream ? '\nClic para detener' : '\nClic para preparar la emisión'}`;

  const record = outputs.get('record');
  const paused = outputs.isPaused('record');
  const recordBtn = $('#btn-record');
  recordBtn.classList.toggle('on', !!record && !paused);
  recordBtn.classList.toggle('paused', paused);
  recordBtn.disabled = !!record?.stopping;
  $('.out-label', recordBtn).textContent = record ? (paused ? 'PAUSA' : 'REC') : 'Grabar';
  $('#record-info').textContent = record && !record.stopping ? fmtTime(outputs.elapsed(record)) : '';
  recordBtn.title = `${describeOutput('record')}${record ? '\nClic para detener' : ''}`;
  const pause = $('#btn-record-pause');
  pause.hidden = !record;
  pause.classList.toggle('on', paused);
  pause.textContent = paused ? '▶' : '⏸';

  const replay = outputs.get('replay');
  const replayBtn = $('#btn-replay');
  replayBtn.classList.toggle('on', !!replay);
  replayBtn.disabled = !!replay?.stopping;
  $('#replay-info').textContent = replay ? `${state.settings.replaySeconds} s` : '';
  replayBtn.title = replay ? describeOutput('replay') : 'Búfer de repetición: guarda los últimos segundos con R';
  $('#btn-replay-save').disabled = !replay || replay.stopping;

  renderVertical();
}

// --- settings -----------------------------------------------------------------

let destSeq = Math.max(0, ...state.settings.destinations.map((d) => d.id || 0));

function renderDestinations(list) {
  const box = $('#destinations');
  box.replaceChildren(
    ...(list.length
      ? list.map((d, i) =>
          h(
            'div',
            { class: 'dest-row' },
            h('input', { type: 'checkbox', checked: d.enabled, title: 'Activo', onchange: (e) => (d.enabled = e.target.checked) }),
            h('input', { value: d.name, placeholder: 'Nombre', oninput: (e) => (d.name = e.target.value) }),
            h('input', { value: d.url, placeholder: 'rtmp://servidor/app', oninput: (e) => (d.url = e.target.value.trim()) }),
            h('button', { type: 'button', title: 'Quitar destino', onclick: () => { list.splice(i, 1); renderDestinations(list); } }, '✕'),
            h('span'),
            h('input', { class: 'key', type: 'password', value: d.key, placeholder: 'Clave de emisión', autocomplete: 'off', oninput: (e) => (d.key = e.target.value.trim()) }),
          ),
        )
      : [h('div', { class: 'muted small' }, 'Sin destinos. Añade uno con el menú de abajo.')]),
  );
}

/** Lists sound cards for monitoring; a saved one that is unplugged stays selectable. */
async function fillOutputDevices(select, current) {
  const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const options = [['', 'Predeterminada del sistema'], ...devices.map((d, i) => [d.deviceId, d.label || `Salida de audio ${i + 1}`])];
  if (current && !devices.some((d) => d.deviceId === current)) options.push([current, 'Dispositivo desconectado']);
  fillSelect(select, options, current);
}

export async function openSettings() {
  const { outputs, compositor } = app;
  const { encoders, info } = system;
  const dlg = $('#dlg-settings');
  const form = dlg.querySelector('form');
  const s = state.settings;
  const destinations = structuredClone(s.destinations);
  form.resolution.value = `${s.width}x${s.height}`;
  form.fps.value = String(s.fps);
  fillSelect(form.encoder, ['auto', ...encoders].map((e) => [e, ENCODER_LABELS[e] ?? e]), encoders.includes(s.encoder) || s.encoder === 'auto' ? s.encoder : 'auto');
  form.x264Preset.value = s.x264Preset;
  form.recordFolder.value = s.recordFolder || info.defaultRecordFolder;
  form.recordFormat.value = s.recordFormat;
  form.recordMbps.value = s.recordMbps;
  form.streamVideoKbps.value = s.streamVideoKbps;
  form.audioKbps.value = s.audioKbps;
  form.limiter.checked = s.limiter;
  await fillOutputDevices(form.monitorDevice, s.monitorDevice);
  form.replaySeconds.value = s.replaySeconds;
  form.replayAsInput.checked = s.replayAsInput;
  form.isoRecording.checked = !!s.isoRecording;
  const locked = outputs.busyMain;
  form.resolution.disabled = locked;
  form.fps.disabled = locked;
  renderDestinations(destinations);
  const preset = $('#dest-preset');
  preset.value = '';
  preset.onchange = () => {
    if (!preset.value) return;
    const [name, url] = preset.value.split('|');
    destinations.push({ id: ++destSeq, enabled: true, name, url, key: '' });
    renderDestinations(destinations);
    preset.value = '';
  };
  $('#settings-note').textContent = [
    locked ? 'Detén la emisión y la grabación para cambiar la resolución o los fps.' : '',
    `Codificadores disponibles: ${encoders.map((e) => ENCODER_LABELS[e]).join(', ')}.`,
    'Las claves de emisión se guardan en este equipo sin cifrar.',
    info.logFile ? `Registro de errores: ${info.logFile}` : '',
  ].filter(Boolean).join(' ');
  $('#btn-choose-folder').onclick = async () => {
    const folder = await window.studio.chooseFolder();
    if (folder) form.recordFolder.value = folder;
  };

  if ((await ask(dlg)) !== 'ok') return;
  const [width, height] = form.resolution.value.split('x').map(Number);
  const fps = Number(form.fps.value);
  const videoChanged = width !== s.width || height !== s.height || fps !== s.fps;
  Object.assign(s, {
    width,
    height,
    fps,
    encoder: form.encoder.value,
    x264Preset: form.x264Preset.value,
    recordFolder: form.recordFolder.value === info.defaultRecordFolder ? '' : form.recordFolder.value,
    recordFormat: form.recordFormat.value,
    recordMbps: Number(form.recordMbps.value) || DEFAULT_SETTINGS.recordMbps,
    streamVideoKbps: Number(form.streamVideoKbps.value) || DEFAULT_SETTINGS.streamVideoKbps,
    audioKbps: Number(form.audioKbps.value) || DEFAULT_SETTINGS.audioKbps,
    destinations,
  });
  s.replaySeconds = Math.min(300, Math.max(5, Number(form.replaySeconds.value) || DEFAULT_SETTINGS.replaySeconds));
  s.replayAsInput = form.replayAsInput.checked;
  s.isoRecording = form.isoRecording.checked;
  setLimiter(form.limiter.checked);
  if (form.monitorDevice.value !== s.monitorDevice) {
    try {
      await app.audio.setOutputDevice(form.monitorDevice.value);
      s.monitorDevice = form.monitorDevice.value;
    } catch (err) {
      toast(`No se pudo cambiar la salida de escucha: ${err.message}`, 'error');
    }
  }
  saveSettings();
  if (videoChanged && !outputs.busyMain) compositor.configure(width, height, fps);
  changed();
  renderOutputs();
}
