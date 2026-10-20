// "Salidas y monitores" dialog: what each monitor or projector shows, floating
// windows, and the phone monitor link.

import { ScreenOutputs, SOURCE_LABELS } from './screens.js';
import { initMonitors, monitorList } from './monitors.js';
import { ask, confirmAction, toast } from './ui-common.js';
import { $, h } from './util.js';

let screens = null;
let dialogOpen = false;

function renderChip() {
  const chip = $('#chip-screens');
  const count = screens.windows.size + monitorList().length;
  chip.hidden = count === 0;
  chip.textContent = `Salidas · ${count}`;
}

function sourceSelect(value, onchange, { none = 'Nada' } = {}) {
  const select = h('select', { onchange: (e) => onchange(e.target.value || null) },
    h('option', { value: '' }, none),
    ...Object.entries(SOURCE_LABELS).map(([id, label]) => h('option', { value: id }, label)),
  );
  select.value = value ?? '';
  return select;
}

async function renderDialog() {
  if (!dialogOpen) return;
  const displays = await window.studio.listDisplays();
  const remote = await window.studio.remoteInfo();

  const displayRows = displays.map((d) => {
    const current = screens.sourceOn(d.id);
    return h('div', { class: 'row nowrap screen-row' },
      h('span', { class: 'screen-icon' }, '🖥'),
      h('div', { class: 'grow stack tight' },
        h('strong', {}, d.label),
        h('span', { class: 'muted small' }, [`${d.width}×${d.height}`, d.primary ? 'principal' : '', d.hasApp ? 'aquí está StudioMix' : ''].filter(Boolean).join(' · ')),
      ),
      sourceSelect(current, async (source) => {
        if (source && d.hasApp && !(await confirmCover())) return renderDialog();
        try {
          screens.assign(d.id, source);
        } catch (err) {
          toast(err.message, 'error');
        }
        renderDialog();
      }, { none: 'Apagada' }),
    );
  });

  const floating = screens.floating;
  const monitors = monitorList();
  const phone = !remote.enabled || !remote.running
    ? [
        h('p', { class: 'muted small' }, 'Mira Program, Preview o el multiview en el móvil o una tablet de la misma red wifi, con poco retardo. Usa el mando remoto, que ahora está desactivado.'),
        h('button', {
          type: 'button',
          onclick: async () => {
            const info = await window.studio.remoteConfigure({ enabled: true });
            if (!info.running) toast(`No se pudo activar: ${info.error ?? 'error desconocido'}`, 'error');
            renderDialog();
          },
        }, 'Activar el mando remoto'),
      ]
    : [
        h('div', { class: 'remote-qr' },
          remote.monitorQr ? h('img', { src: remote.monitorQr, alt: 'Código QR del monitor' }) : null,
          h('div', { class: 'stack' },
            h('p', { class: 'muted small' }, 'Escanea el código con la cámara del móvil o abre esta dirección. Desde el mando completo también hay un botón «Ver el monitor».'),
            ...remote.monitorUrls.map((u) => h('code', { class: 'copyable', title: 'Clic para copiar', onclick: () => navigator.clipboard.writeText(u).then(() => toast('Dirección copiada')) }, u)),
            h('p', { class: 'muted small' }, monitors.length
              ? `Mirando ahora: ${monitors.map((m) => SOURCE_LABELS[m.source]).join(', ')}.`
              : 'Ningún móvil mirando ahora. Máximo 4 a la vez.'),
          ),
        ),
      ];

  $('#screens-body').replaceChildren(
    h('h4', {}, 'Pantallas y proyectores'),
    h('p', { class: 'muted small' }, 'Cada pantalla conectada puede mostrar una salida a pantalla completa, sin controles. Pulsa Esc o haz doble clic en ella para apagarla. Si desconectas un proyector, su salida vuelve sola al reconectarlo.'),
    ...displayRows,
    h('h4', {}, 'Ventanas flotantes'),
    h('p', { class: 'muted small' }, 'Para un solo monitor, o para compartir la salida en una videollamada.'),
    h('div', { class: 'row' },
      ...Object.entries(SOURCE_LABELS).map(([id, label]) => h('button', { type: 'button', onclick: () => { screens.openFloating(id); renderDialog(); } }, `Abrir ${label}`)),
    ),
    ...floating.map(([key, w]) => h('div', { class: 'row nowrap screen-row' },
      h('span', { class: 'grow' }, `🗗 Ventana · ${SOURCE_LABELS[w.source]}`),
      h('button', { type: 'button', onclick: () => { screens.close(key); renderDialog(); } }, 'Cerrar'),
    )),
    h('h4', {}, 'Monitor en el móvil'),
    ...phone,
  );
  renderChip();
}

const confirmCover = () =>
  confirmAction('Esta es la pantalla donde está StudioMix: la salida la tapará entera. Podrás quitarla con Esc.', { ok: 'Mostrar igualmente' });

export async function openScreens() {
  dialogOpen = true;
  const timer = setInterval(renderDialog, 2000);
  await renderDialog();
  await ask($('#dlg-screens'));
  clearInterval(timer);
  dialogOpen = false;
}

export function initScreens() {
  screens = new ScreenOutputs();
  screens.onChange = () => {
    renderChip();
    renderDialog();
  };
  initMonitors(renderChip);
  window.studio.listDisplays().then((list) => screens.reconcile(list));
  window.studio.onDisplaysChanged((list) => screens.reconcile(list));
  $('#btn-screens').addEventListener('click', openScreens);
  $('#chip-screens').addEventListener('click', openScreens);
}
