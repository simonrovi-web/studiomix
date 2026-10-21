// "Buscar actualizaciones": the update window, the dot on the ☰ button and the
// notice when a new version is ready to install.

import { app } from './store.js';
import { ask, toast } from './ui-common.js';
import { $, h } from './util.js';

let status = { state: 'idle' };
let dialogOpen = false;
let notifiedVersion = null;

const STATE_TEXT = {
  idle: 'Sin comprobar todavía.',
  checking: 'Buscando versiones nuevas…',
  latest: 'Tienes la última versión.',
  available: 'Hay una versión nueva disponible.',
  downloading: 'Descargando la versión nueva…',
  downloaded: 'Versión nueva lista para instalar.',
  error: 'No se pudo comprobar.',
};

/** Whether the menu should call attention to an update. */
export const hasUpdate = () => status.state === 'available' || status.state === 'downloaded';

/** One short line for the menu footer. */
export function updateSummary() {
  const v = status.current ? `StudioMix ${status.current}` : 'StudioMix';
  if (status.state === 'downloaded') return `${v} · ${status.version} lista para instalar`;
  if (status.state === 'downloading') return `${v} · descargando ${status.version}…`;
  if (status.state === 'available') return `${v} · hay una versión ${status.version}`;
  if (status.state === 'latest') return `${v} · al día`;
  return v;
}

function ago(ms) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} días`;
}

const onAir = () => !!(app.outputs.get('stream') || app.outputs.get('record') || app.outputs.get('vstream'));

async function install() {
  const result = await window.studio.installUpdate();
  if (!result.ok) toast(result.error, 'error');
}

function renderDialog() {
  if (!dialogOpen) return;
  const s = status;
  const busy = s.state === 'checking' || s.state === 'downloading';
  const manual = s.mode === 'manual';
  const rows = [
    h('div', { class: 'update-head' },
      h('div', { class: `update-icon ${s.state}` }, s.state === 'downloaded' || s.state === 'available' ? '⬆' : s.state === 'error' ? '!' : s.state === 'latest' ? '✓' : '⟳'),
      h('div', { class: 'stack tight' },
        h('strong', {}, STATE_TEXT[s.state] ?? ''),
        h('span', { class: 'muted small' }, [
          `Versión instalada: ${s.current ?? '—'}`,
          s.version && s.version !== s.current ? `nueva: ${s.version}` : null,
          s.checkedAt ? `comprobado ${ago(s.checkedAt)}` : null,
        ].filter(Boolean).join(' · ')),
      ),
    ),
  ];
  if (s.state === 'downloading') {
    const pct = Math.round((s.progress ?? 0) * 100);
    rows.push(h('div', { class: 'update-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${pct}%` })));
    rows.push(h('span', { class: 'muted small' }, `${pct} %${s.bytesPerSecond ? ` · ${(s.bytesPerSecond / 1048576).toFixed(1)} MB/s` : ''} · Puedes seguir trabajando mientras se descarga.`));
  }
  if (s.state === 'error' && s.error) rows.push(h('p', { class: 'warn-text' }, s.error));
  if (s.notes && (s.state === 'available' || s.state === 'downloaded' || s.state === 'downloading')) {
    rows.push(h('details', { open: true }, h('summary', {}, 'Novedades'), h('pre', { class: 'update-notes' }, s.notes)));
  }
  if (manual && s.why === 'portable') rows.push(h('p', { class: 'muted small' }, 'Estás usando la versión portable, que no se actualiza sola: descarga la nueva y sustituye el archivo.'));
  if (manual && s.why === 'dev') rows.push(h('p', { class: 'muted small' }, 'Versión de desarrollo: se comprueba en GitHub, pero se actualiza con git.'));

  const actions = [];
  if (s.state === 'downloaded') {
    actions.push(h('button', {
      type: 'button',
      class: 'accent',
      disabled: onAir(),
      title: onAir() ? 'Detén la emisión y las grabaciones antes de reiniciar' : '',
      onclick: install,
    }, 'Reiniciar e instalar'));
    rows.push(h('p', { class: 'muted small' }, onAir()
      ? 'Estás emitiendo o grabando: la actualización se instalará cuando cierres StudioMix.'
      : 'Si prefieres, se instalará sola la próxima vez que cierres StudioMix.'));
  } else if (s.state === 'available' && manual) {
    actions.push(h('button', { type: 'button', class: 'accent', onclick: () => window.open(s.releaseUrl, '_blank') }, 'Descargar la versión nueva'));
  }
  if (s.state !== 'downloaded') actions.push(h('button', { type: 'button', disabled: busy, onclick: checkNow }, busy ? 'Comprobando…' : 'Buscar ahora'));
  if (s.releaseUrl) actions.push(h('button', { type: 'button', class: 'ghost', onclick: () => window.open(s.releaseUrl, '_blank') }, 'Ver en GitHub'));
  rows.push(h('div', { class: 'row' }, ...actions));
  $('#update-body').replaceChildren(...rows);
}

async function checkNow() {
  status = { ...status, state: 'checking' };
  renderDialog();
  try {
    status = await window.studio.checkUpdates();
  } catch (err) {
    status = { ...status, state: 'error', error: err.message };
  }
  renderDialog();
  renderBadge();
}

function renderBadge() {
  const btn = $('#btn-menu');
  btn.classList.toggle('has-badge', hasUpdate());
  btn.title = hasUpdate() ? `Hay una versión nueva (${status.version}). Proyecto, capturas, conexiones, actualizaciones…` : 'Proyecto, capturas, conexiones, actualizaciones…';
}

export async function openUpdates() {
  dialogOpen = true;
  renderDialog();
  // Opening the window checks right away unless something is already under way.
  if (!['checking', 'downloading', 'downloaded'].includes(status.state)) checkNow();
  await ask($('#dlg-update'));
  dialogOpen = false;
}

function onStatus(next) {
  status = next;
  renderDialog();
  renderBadge();
  if (next.state === 'downloaded' && next.version !== notifiedVersion && !dialogOpen) {
    notifiedVersion = next.version;
    toast(`StudioMix ${next.version} está descargado y se instalará al cerrar la aplicación.`, 'info', {
      label: 'Reiniciar ahora',
      dismissLabel: 'Al cerrar',
      onClick: install,
    });
  }
}

export function initUpdates() {
  window.studio.onUpdateStatus(onStatus);
  window.studio.updateStatus().then(onStatus);
}
