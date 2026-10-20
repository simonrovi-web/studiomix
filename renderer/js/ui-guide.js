// First-run guide: three steps from an empty app to being live, shown inside
// the Preview monitor (where the first source will appear).
import { app, saveSettings, state } from './store.js';
import { adders } from './ui-inputs.js';
import { openGoLive } from './ui-golive.js';
import { toast } from './ui-common.js';
import { $, h } from './util.js';

export function destinationReady() {
  return state.settings.destinations.some((d) => d.enabled && d.key && /^rtmps?:\/\/.+/i.test(d.url || ''));
}

function steps() {
  return [
    { done: state.inputs.length > 0, label: 'Añade una fuente' },
    { done: state.programId != null, label: 'Mándala al aire' },
    // Recording counts too: not everyone streams.
    { done: destinationReady() || !!state.settings.hasRecorded, label: 'Emite o graba' },
  ];
}

const dismiss = () => {
  state.settings.guideDismissed = true;
  saveSettings();
  renderGuide();
};

async function add(kind) {
  try {
    await adders[kind]();
  } catch (err) {
    toast(`No se pudo añadir la entrada: ${err.message}`, 'error');
  }
}

let lastKey = '';

export function renderGuide() {
  const box = $('#guide');
  const list = steps();
  const current = list.findIndex((s) => !s.done);
  const hidden = state.settings.guideDismissed || current === -1;
  $('#btn-auto').classList.toggle('nudge', !hidden && current === 1 && state.previewId != null);
  // Only rebuild when something relevant changed.
  const key = `${hidden}|${current}|${state.previewId != null}`;
  if (key === lastKey) return;
  lastKey = key;
  box.hidden = hidden;
  if (hidden) return;

  const empty = current === 0;
  box.classList.toggle('compact', !empty);

  // Once there is something in Preview, the guide becomes one line in the
  // monitor's header so it never covers the picture.
  if (!empty) {
    $('.preview .monitor-label').append(box);
    const hint = current === 1
      ? (state.previewId != null ? 'Pulsa AUTO (o Intro) para mandar Preview al aire' : 'Haz clic en una fuente de abajo')
      : null;
    box.replaceChildren(
      h('span', { class: 'guide-step' }, `Paso ${current + 1}/3`),
      hint
        ? h('span', { class: 'guide-inline-hint' }, hint)
        : h('span', { class: 'guide-inline-actions' },
            h('button', { type: 'button', class: 'accent small', onclick: () => openGoLive() }, 'Conectar mi canal'),
            h('span', { class: 'muted' }, 'o'),
            h('button', { type: 'button', class: 'small', onclick: () => app.actions.toggleOutput('record') }, 'Grabar')),
      h('button', { type: 'button', class: 'ghost small', title: 'Ocultar la guía', onclick: dismiss }, '✕'),
    );
    return;
  }
  $('.preview .screen').append(box);
  const stepList = h(
    'ol',
    { class: 'guide-steps' },
    list.map((s, i) => h('li', { class: s.done ? 'done' : i === current ? 'current' : '' }, h('span', { class: 'mark' }, s.done ? '✓' : String(i + 1)), s.label)),
  );

  let cta;
  if (current === 0) {
    cta = h(
      'div',
      { class: 'guide-sources' },
      h('button', { type: 'button', class: 'accent', onclick: () => add('camera') }, '📷 Cámara'),
      h('button', { type: 'button', onclick: () => add('screen') }, '🖥 Pantalla'),
      h('button', { type: 'button', onclick: () => add('video') }, '🎞 Vídeo'),
      h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); $('#add-menu').hidden = false; } }, 'Más…'),
    );
  } else if (current === 1) {
    cta = h('p', { class: 'guide-hint' }, state.previewId != null ? 'Lo que ves aquí es Preview (el siguiente plano). Pulsa AUTO o Intro para mandarlo al aire.' : 'Haz clic en una fuente de abajo para verla aquí, en Preview.');
  }

  box.replaceChildren(
    h('div', { class: 'guide-head' },
      h('strong', {}, 'Empieza en 3 pasos'),
      h('button', { type: 'button', class: 'ghost small', title: 'Ocultar la guía', onclick: dismiss }, 'Ocultar guía'),
    ),
    stepList,
    cta,
  );
}

export function initGuide() {
  renderGuide();
  // Expose for the app's change loop without a circular import.
  app.renderGuide = renderGuide;
}
