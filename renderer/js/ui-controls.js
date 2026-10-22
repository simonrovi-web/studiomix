// Switcher controls: transition panel, T-bar, overlay buttons, add-input menu,
// multiview clicks, keyboard shortcuts, and the periodic UI refresh.

import { TRANSITIONS } from './compositor.js';
import { LUMA_PATTERNS } from './transitions.js';
import { app, byId, changed, onChange, saveSettings, state } from './store.js';
import { ask, closePanels, fillSelect, isTyping, panelOpen, toast } from './ui-common.js';
import { adders, updateCardTimes, updateCards } from './ui-inputs.js';
import { updateStrips } from './ui-mixer.js';
import { handleSceneKey, previewScene, renderDock } from './ui-scenes.js';
import { renderGuide } from './ui-guide.js';
import { midiFeedback } from './midi-actions.js';
import { displayedBar } from './tbar.js';
import { openProject, saveProject } from './ui-projects.js';
import { isHtml, loadStinger } from './stinger-files.js';
import { $, $$, fmtTime, h } from './util.js';

function refresh() {
  updateCards();
  updateStrips();

  $('#preview-name').textContent = byId(state.previewId)?.name ?? '';
  $('#program-name').textContent = byId(state.programId)?.name ?? '';

  $$('#overlay-buttons button').forEach((btn, i) => {
    const ov = state.overlays[i];
    const active = ov.inputId != null && ov.target > 0;
    btn.classList.toggle('on', active);
    btn.title = active ? `Capa ${i + 1}: ${byId(ov.inputId)?.name ?? ''} (clic para quitar)` : `Capa ${i + 1}: poner encima la entrada de Preview (Ctrl+${i + 1})`;
    btn.disabled = !active && state.previewId == null;
  });
  $('#btn-ftb').classList.toggle('on', state.ftb.target > 0);
  $('#trans-type').value = state.transition.type;
  $('#trans-duration').value = state.transition.duration;
  $('#btn-scene-dock').hidden = !previewScene();
  renderDock();
  renderGuide();
  midiFeedback();
}

function startRefresh() {
  onChange(refresh);

  // Fast-changing bits: transition progress and T-bar.
  setInterval(renderTbar, 50);

  setInterval(() => {
    updateCardTimes();
    const program = byId(state.programId);
    const remaining = program && 'remaining' in program ? program.remaining : 0;
    const label = $('#program-remaining');
    label.textContent = remaining ? `quedan ${fmtTime(remaining * 1000)}` : '';
    label.style.color = remaining && remaining < 10 ? 'var(--program)' : '';
  }, 250);
}

// --- T-bar ------------------------------------------------------------------
// Drawn from state.transition (see tbar.js); only touches the DOM when something
// visible changed, since it runs 20 times a second.

let tbarView = '';

function renderTbar() {
  const t = state.transition;
  const progress = t.running ? t.progress : t.manual / 100;
  const bar = displayedBar(t);
  const from = t.barFrom ?? 0;
  const pct = Math.round(progress * 100);
  const key = `${bar.toFixed(1)}|${from}|${pct}|${t.barLocked}|${t.running}`;
  if (key === tbarView) return;
  tbarView = key;
  $('#trans-progress').style.width = `${(progress * 100).toFixed(1)}%`;
  const el = $('#tbar');
  $('.tbar-handle', el).style.bottom = `${bar}%`;
  // The fill runs from the end the transition started at to the handle.
  const fill = $('.tbar-fill', el);
  fill.style.bottom = `${Math.min(from, bar)}%`;
  fill.style.height = `${Math.abs(bar - from)}%`;
  $('.tbar-pct', el).textContent = `${pct}%`;
  const dir = $('.tbar-dir', el);
  dir.textContent = t.barLocked ? '⇅' : from === 0 ? '▲' : '▼';
  dir.title = t.barLocked ? 'Lleva la T-bar del controlador a un extremo para retomarla' : from === 0 ? 'La próxima transición: hacia arriba' : 'La próxima transición: hacia abajo';
  el.classList.toggle('active', pct > 0);
  el.classList.toggle('locked', !!t.barLocked);
  el.setAttribute('aria-valuenow', String(Math.round(bar)));
  el.setAttribute('aria-valuetext', t.barLocked ? 'Esperando a que la T-bar del controlador llegue a un extremo' : `Transición al ${pct}%`);
}

function initTbar(compositor) {
  const el = $('#tbar');
  const track = $('.tbar-track', el);
  const move = (pos) => {
    compositor.setBar(pos, 'ui');
    renderTbar();
  };
  const fromPointer = (e) => {
    const r = track.getBoundingClientRect();
    return ((r.bottom - e.clientY) / r.height) * 100;
  };
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    el.focus();
    move(fromPointer(e));
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) move(fromPointer(e));
  });
  const stop = () => {
    dragging = false;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    move((state.transition.bar ?? 0) + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const bar = state.transition.bar ?? 0;
    const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 25, PageDown: -25 }[e.key];
    let next = step === undefined ? null : bar + step;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = 100;
    if (next == null) return;
    // Keep the arrows for the T-bar instead of the scene editor while it has focus.
    e.preventDefault();
    e.stopPropagation();
    move(next);
  });
  renderTbar();
}

function initTransitionPanel() {
  const { actions, compositor } = app;
  fillSelect($('#trans-type'), Object.entries(TRANSITIONS), state.transition.type);
  $('#trans-type').addEventListener('change', (e) => {
    state.transition.type = e.target.value;
    state.settings.transitionType = e.target.value;
    saveSettings();
  });
  const duration = $('#trans-duration');
  duration.addEventListener('change', () => {
    const value = Math.min(5000, Math.max(100, Number(duration.value) || 1000));
    state.transition.duration = value;
    state.settings.transitionDuration = value;
    saveSettings();
    changed();
  });

  $('#btn-cut').addEventListener('click', actions.cut);
  $('#btn-auto').addEventListener('click', actions.auto);
  $('#btn-ftb').addEventListener('click', actions.ftb);

  initTbar(compositor);

  $('#overlay-buttons').replaceChildren(...state.overlays.map((_, i) => h('button', { type: 'button', onclick: () => actions.overlayButton(i) }, `Capa ${i + 1}`)));
  $('#btn-trans-options').addEventListener('click', openTransitionOptions);
}

async function openTransitionOptions() {
  const { compositor } = app;
  const dlg = $('#dlg-transition');
  const form = dlg.querySelector('form');
  const { luma, stinger } = state.transition;
  fillSelect(form.pattern, Object.entries(LUMA_PATTERNS), luma.pattern);
  form.softness.value = luma.softness;
  form.invert.checked = luma.invert;
  form.cutPoint.value = stinger.cutPoint;
  form.htmlDuration.value = stinger.htmlDurationMs ?? 2000;
  const showStinger = (text) => {
    const name = compositor.stinger.path ? compositor.stinger.path.split(/[\\/]/).pop() : 'Sin clip';
    $('#stinger-name').textContent = text ?? name;
    $('#stinger-html').hidden = !isHtml(compositor.stinger.path);
  };
  showStinger();
  let busy = false;
  const prepare = async (file) => {
    if (busy) return;
    busy = true;
    const name = file.path.split(/[\\/]/).pop();
    showStinger(isHtml(file.path) ? `Grabando la animación ${name}…` : `Preparando ${name}…`);
    try {
      const ready = await loadStinger(file, (p) => showStinger(`Preparando ${name}… ${Math.round(p * 100)} %`));
      showStinger();
      if (ready?.converted && !ready.reused) toast(ready.plan === 'html' ? 'Animación HTML lista como stinger (con transparencia).' : 'Clip convertido a WebM con transparencia y listo como stinger.');
    } catch (err) {
      showStinger();
      toast(`No se pudo usar «${name}» como stinger: ${err.message}`, 'error');
    } finally {
      busy = false;
    }
  };
  form.oninput = () => {
    luma.pattern = form.pattern.value;
    luma.softness = Number(form.softness.value);
    luma.invert = form.invert.checked;
    stinger.cutPoint = Math.max(0, Number(form.cutPoint.value) || 0);
    saveSettings();
  };
  form.onchange = (e) => {
    form.oninput();
    // A new length for an HTML animation means recording it again.
    if (e.target === form.htmlDuration) {
      stinger.htmlDurationMs = Math.min(15000, Math.max(200, Number(form.htmlDuration.value) || 2000));
      form.htmlDuration.value = stinger.htmlDurationMs;
      saveSettings();
      if (isHtml(stinger.path)) prepare({ path: stinger.path });
    }
  };
  $('#btn-stinger-file').onclick = async () => {
    const [file] = await window.studio.openMedia('stinger');
    if (file) await prepare(file);
  };
  $('#btn-stinger-clear').onclick = () => {
    loadStinger(null);
    showStinger();
  };
  await ask(dlg);
  form.oninput = null;
  form.onchange = null;
  saveSettings();
}

function initAddMenu() {
  const menu = $('#add-menu');
  $('#btn-add').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
  });
  $$('[data-add]', menu).forEach((btn) =>
    btn.addEventListener('click', async () => {
      menu.hidden = true;
      try {
        await adders[btn.dataset.add]();
      } catch (err) {
        console.error('No se pudo añadir la entrada:', err);
        toast(`No se pudo añadir la entrada: ${err.message}`, 'error');
      }
    }),
  );
}

function initMultiview() {
  const { actions, compositor } = app;
  const canvas = $('#multiview-canvas');
  const toCanvas = (e) => {
    // The canvas is letterboxed with object-fit: contain.
    const r = canvas.getBoundingClientRect();
    const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
    const ox = (r.width - canvas.width * scale) / 2;
    const oy = (r.height - canvas.height * scale) / 2;
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale];
  };
  canvas.addEventListener('click', (e) => {
    const cell = compositor.cellAt(...toCanvas(e));
    if (cell) actions.setPreview(cell.id);
  });
  canvas.addEventListener('dblclick', (e) => {
    const cell = compositor.cellAt(...toCanvas(e));
    if (cell) actions.quickPlay(cell.id);
  });
  $('#view-studio').addEventListener('click', () => actions.setView('studio'));
  $('#view-multiview').addEventListener('click', () => actions.setView('multiview'));
  $('#view-vertical').addEventListener('click', () => actions.setView('vertical'));
}

function initKeyboard() {
  const { actions } = app;
  document.addEventListener('keydown', (e) => {
    // Side panels don't block shortcuts (you can keep switching while editing); modal dialogs do.
    if (document.querySelector('dialog:modal') || isTyping(e.target)) return;
    if (e.key === 'Escape' && !previewScene() && panelOpen()) {
      closePanels();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Escape'].includes(e.key) && handleSceneKey(e)) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (e.ctrlKey && e.code === 'KeyS') {
      e.preventDefault();
      saveProject(e.shiftKey);
      return;
    }
    if (e.ctrlKey && e.code === 'KeyO') {
      e.preventDefault();
      openProject();
      return;
    }
    if (e.ctrlKey && digit && Number(digit) <= state.overlays.length) {
      e.preventDefault();
      actions.overlayButton(Number(digit) - 1);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === '?') {
      e.preventDefault();
      ask($('#dlg-help'));
      return;
    }
    if (digit) {
      const input = state.inputs[Number(digit) - 1];
      if (input) (e.shiftKey ? actions.cutTo : actions.setPreview)(input.id);
      return;
    }
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        actions.cut();
        break;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        actions.auto();
        break;
      case 'KeyB':
        actions.ftb();
        break;
      case 'KeyV':
        actions.setView(state.view === 'studio' ? 'multiview' : 'studio');
        break;
      case 'KeyR':
        actions.saveReplay();
        break;
      case 'KeyS':
        actions.snapshot();
        break;
      default:
    }
  });
}

export function initControls() {
  startRefresh();
  initTransitionPanel();
  initAddMenu();
  initMultiview();
  initKeyboard();
}
