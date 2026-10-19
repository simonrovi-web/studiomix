// "Emitir en directo" side sheet: pick destinations, paste the key, see a
// pre-flight check (picture, sound, encoder, quality), then start with a short
// cancellable countdown. It never covers the Preview monitor.
import { levelToDb } from './audio.js';
import { app, byId, saveSettings, state } from './store.js';
import { openPanel } from './ui-common.js';
import { $, h } from './util.js';

const PRESETS = [
  { name: 'YouTube', icon: '▶', url: 'rtmp://a.rtmp.youtube.com/live2', hint: 'YouTube Studio → Crear → Emitir en directo → «Clave de transmisión».' },
  { name: 'Twitch', icon: '◆', url: 'rtmp://live.twitch.tv/app', hint: 'Panel de creador → Configuración → Transmisión → «Clave de transmisión principal».' },
  { name: 'Facebook', icon: 'f', url: 'rtmps://live-api-s.facebook.com:443/rtmp', hint: 'Live Producer → «Software de transmisión» → Clave de transmisión.' },
  { name: 'Kick', icon: 'K', url: 'rtmps://', hint: 'Panel de Kick → Configuración → Stream: copia la URL del servidor y la clave.' },
  { name: 'Otro', icon: '+', url: 'rtmp://', hint: 'Pega la URL del servidor RTMP o RTMPS y la clave que te dé el servicio.' },
];

const ENCODER_NAMES = { nvenc: 'NVIDIA (GPU)', qsv: 'Intel Quick Sync (GPU)', amf: 'AMD (GPU)', x264: 'x264 (CPU)' };

let timer = 0;
let countdown = null;
let audioPeak = 0;
let audioSince = 0;
let encoders = ['x264'];

const validUrl = (url) => /^rtmps?:\/\/.+/i.test(url || '');

function presetFor(dest) {
  return PRESETS.find((p) => p.name === dest.name) ?? PRESETS[PRESETS.length - 1];
}

function toggleDestination(preset) {
  const list = state.settings.destinations;
  let dest = list.find((d) => d.name === preset.name);
  if (dest) dest.enabled = !dest.enabled;
  else {
    dest = { id: Date.now(), enabled: true, name: preset.name, url: preset.url, key: '' };
    list.push(dest);
  }
  saveSettings();
  renderDestinations();
  renderChecks();
}

function renderDestinations() {
  const list = state.settings.destinations;
  $('#golive-presets').replaceChildren(
    ...PRESETS.map((p) => {
      const on = list.some((d) => d.name === p.name && d.enabled);
      return h('button', { type: 'button', class: `dest-preset ${on ? 'on' : ''}`, 'aria-pressed': String(on), onclick: () => toggleDestination(p) },
        h('span', { class: 'dest-icon' }, p.icon), p.name);
    }),
  );
  const enabled = list.filter((d) => d.enabled);
  $('#golive-dests').replaceChildren(
    ...(enabled.length
      ? enabled.map((d) => {
          const preset = presetFor(d);
          const needsUrl = !validUrl(d.url) || preset.name === 'Otro' || preset.name === 'Kick' || !PRESETS.some((p) => p.url === d.url);
          return h('div', { class: 'golive-dest' },
            h('div', { class: 'golive-dest-name' }, h('span', { class: 'dest-icon' }, preset.icon), d.name),
            needsUrl
              ? h('label', { class: 'field' }, 'Servidor', h('input', { value: d.url, placeholder: 'rtmp://servidor/app', oninput: (e) => { d.url = e.target.value.trim(); saveSettings(); renderChecks(); } }))
              : null,
            h('label', { class: 'field' }, 'Clave de emisión',
              h('span', { class: 'row nowrap' },
                h('input', { type: 'password', value: d.key, autocomplete: 'off', placeholder: 'Pega aquí la clave', oninput: (e) => { d.key = e.target.value.trim(); saveSettings(); renderChecks(); } }),
                h('button', {
                  type: 'button',
                  title: 'Pegar desde el portapapeles',
                  onclick: async (e) => {
                    try {
                      const text = (await navigator.clipboard.readText()).trim();
                      if (!text) return;
                      d.key = text;
                      e.currentTarget.previousElementSibling.value = text;
                      saveSettings();
                      renderChecks();
                    } catch {
                      // Clipboard not available; the user can paste with Ctrl+V.
                    }
                  },
                }, 'Pegar'),
              ),
            ),
            h('p', { class: 'muted small' }, `¿Dónde la encuentro? ${preset.hint}`),
          );
        })
      : [h('p', { class: 'muted small' }, 'Elige al menos un destino. Puedes activar varios y se emite a todos a la vez.')]),
  );
}

function checks() {
  const s = state.settings;
  const enabled = s.destinations.filter((d) => d.enabled);
  const result = [];
  if (!enabled.length) result.push(['error', 'Elige dónde emitir']);
  else if (enabled.some((d) => !validUrl(d.url))) result.push(['error', 'Falta la URL del servidor']);
  else if (enabled.some((d) => !d.key)) result.push(['error', 'Falta la clave de emisión']);
  else result.push(['ok', `Destino: ${enabled.map((d) => d.name).join(', ')}`]);

  const program = byId(state.programId);
  if (!program) result.push(['warn', 'Program está en negro: manda una fuente al aire']);
  else if (state.ftb.target > 0) result.push(['warn', 'La salida está fundida a negro']);
  else result.push(['ok', `En el aire: ${program.name}`]);

  const db = levelToDb(audioPeak);
  if (performance.now() - audioSince < 1500) result.push(['wait', 'Comprobando el audio…']);
  else if (db > -50) result.push(['ok', `Audio llegando (${db.toFixed(0)} dB)`]);
  else result.push(['warn', 'No llega audio al master']);

  const encoder = s.encoder === 'auto' ? encoders.find((e) => e !== 'x264') ?? 'x264' : s.encoder;
  result.push([encoder === 'x264' ? 'info' : 'ok', `Codificador: ${ENCODER_NAMES[encoder] ?? encoder}`]);
  result.push(['info', `Calidad: ${s.width}×${s.height} · ${s.fps} fps · ${(s.streamVideoKbps / 1000).toFixed(1)} Mb/s`]);
  return result;
}

function renderChecks() {
  app.renderGuide?.(); // step 3 of the guide completes as soon as a key is entered
  const list = checks();
  $('#golive-checks').replaceChildren(...list.map(([kind, text]) => h('li', { class: kind }, text)));
  const live = !!app.outputs.get('stream');
  const blocked = list.some(([k]) => k === 'error');
  const warned = list.some(([k]) => k === 'warn');
  const btn = $('#btn-golive-start');
  if (live) {
    btn.textContent = '● En directo';
    btn.disabled = true;
  } else if (countdown) {
    btn.textContent = `Cancelar (${countdown.left})`;
    btn.disabled = false;
  } else {
    btn.textContent = warned && !blocked ? '● Empezar igualmente' : '● Empezar emisión';
    btn.disabled = blocked;
  }
  btn.classList.toggle('counting', !!countdown);
}

function cancelCountdown() {
  clearInterval(countdown?.timer);
  countdown = null;
  renderChecks();
}

function startCountdown() {
  if (countdown) return cancelCountdown();
  countdown = { left: 3 };
  countdown.timer = setInterval(async () => {
    countdown.left--;
    if (countdown.left > 0) return renderChecks();
    clearInterval(countdown.timer);
    countdown = null;
    $('#dlg-golive').close();
    await app.actions.startStream();
  }, 1000);
  renderChecks();
}

export function openGoLive() {
  const dlg = $('#dlg-golive');
  openPanel(dlg);
  audioPeak = 0;
  audioSince = performance.now();
  window.studio.encoders().then((list) => {
    encoders = list;
  });
  renderDestinations();
  renderChecks();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!dlg.open) {
      clearInterval(timer);
      cancelCountdown();
      return;
    }
    audioPeak = Math.max(audioPeak * 0.9, ...app.audio.meter.levels);
    renderChecks();
  }, 300);
}

/** Highest bitrate worth using for the output size, in kbps (platform guidance). */
function bitrateCap(s) {
  const pixels = s.width * s.height;
  const fast = s.fps > 31;
  if (pixels > 1280 * 720) return fast ? 9000 : 6000;
  return fast ? 6000 : 4500;
}

async function runSpeedTest() {
  const out = $('#speedtest-result');
  const btn = $('#btn-speedtest');
  btn.disabled = true;
  out.textContent = 'Midiendo la subida…';
  try {
    const { mbps } = await window.studio.uploadTest();
    const s = state.settings;
    // Leave ~40% headroom for network jitter, minus the audio.
    const kbps = Math.max(1000, Math.min(bitrateCap(s), Math.floor(mbps * 1000 * 0.6) - s.audioKbps));
    const streams = s.destinations.filter((d) => d.enabled).length || 1;
    const each = Math.floor(kbps / streams / 100) * 100;
    out.replaceChildren(
      `Subida: ${mbps.toFixed(1)} Mb/s · recomendado ${(each / 1000).toFixed(1)} Mb/s${streams > 1 ? ` (${streams} destinos)` : ''}. `,
      h('button', {
        type: 'button',
        class: 'ghost small link',
        onclick: () => {
          s.streamVideoKbps = each;
          saveSettings();
          renderChecks();
          out.textContent = `Bitrate ajustado a ${(each / 1000).toFixed(1)} Mb/s.`;
        },
      }, 'Usar este valor'),
    );
    if (mbps * 1000 * 0.8 < s.streamVideoKbps * streams) out.classList.add('warn-text');
    else out.classList.remove('warn-text');
  } catch (err) {
    out.textContent = `No se pudo medir: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

export function initGoLive() {
  $('#btn-speedtest').addEventListener('click', runSpeedTest);
  $('#btn-golive-start').addEventListener('click', startCountdown);
  $('#btn-golive-close').addEventListener('click', () => $('#dlg-golive').close());
  $('#btn-golive-advanced').addEventListener('click', () => app.actions.openSettings());
}
