import { LAYOUTS } from './compositor.js';
import { DEFAULT_FX, LUT_PRESETS, parseCube } from './effects.js';
import {
  AudioFileInput,
  CameraInput,
  ColorInput,
  ImageInput,
  INPUT_ICONS,
  INPUT_TYPE_LABELS,
  parseTitleList,
  MicInput,
  ScreenInput,
  TitleInput,
  VideoFileInput,
} from './inputs.js';
import { SceneInput } from './scenes.js';
import { OVERLAY_COUNT, app, changed, overlayIndexOf, state } from './store.js';
import { CropEditor } from './ui-crop.js';
import { openSceneDock } from './ui-scenes.js';
import { DEFAULT_TITLE, FIELD_LABELS, NUMERIC_FIELDS, TEMPLATE_PRESETS, TITLE_TEMPLATES } from './titles.js';
import { ask, fillSelect, showMenu, toast } from './ui-common.js';
import { $, $$, drawChecker, fmtTime, h } from './util.js';

const cards = new Map();

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const thumb = app.compositor.thumbs.get(Number(entry.target.dataset.id));
    if (thumb) thumb.visible = entry.isIntersecting;
  }
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function buildCard(input) {
  const thumb = h('canvas', { class: 'thumb', width: 224, height: 126, title: 'Clic: a Preview · Doble clic: transición' });
  thumb.dataset.id = input.id;
  thumb.addEventListener('click', () => app.actions.setPreview(input.id));
  thumb.addEventListener('dblclick', () => app.actions.quickPlay(input.id));
  app.compositor.thumbs.set(input.id, { canvas: thumb, ctx: thumb.getContext('2d', { alpha: false }), visible: true });
  thumbObserver.observe(thumb);

  const act = (label, title, onclick, cls) => h('button', { type: 'button', title, onclick, class: cls }, label);
  const actions = [];
  if (input.hasVideo) {
    actions.push(act('Cut', 'Pasar a Program al corte', () => app.actions.cutTo(input.id)));
    actions.push(act('▶', 'Transición a Program', () => app.actions.quickPlay(input.id)));
    // Overlay layers, labelled as a group so "1 2 3 4" reads as "Capa 1…4".
    actions.push(
      h('span', { class: 'ov-group', title: 'Poner encima como capa (overlay)' },
        h('span', { class: 'ov-label' }, 'Capa'),
        Array.from({ length: OVERLAY_COUNT }, (_, i) =>
          h('button', { type: 'button', class: 'ov', dataset: { ov: i }, title: `Capa ${i + 1} (Ctrl+${i + 1} con la entrada en Preview)`, onclick: () => app.actions.toggleOverlay(i, input.id) }, String(i + 1)),
        ),
      ),
    );
  }
  for (const [label, title, handler] of input.controls()) actions.push(act(label, title, handler));
  actions.push(h('span', { class: 'sep' }));
  actions.push(act('⚙', 'Ajustes, ajuste y recorte, efectos', () => editInput(input)));
  // Less frequent and destructive actions live in a menu, away from the live controls.
  const more = act('⋯', 'Más acciones (o clic derecho en la tarjeta)', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openCardMenu(input, r.left, r.bottom + 4);
  });
  actions.push(more);

  const bar = h('div', { class: 'bar' }, h('div'));
  const card = h(
    'div',
    { class: 'input-card', dataset: { id: input.id }, draggable: true },
    h('div', { class: 'thumb-wrap' }, thumb, h('span', { class: 'tally-label' })),
    'progress' in input ? bar : null,
    h('div', { class: 'card-head', title: INPUT_TYPE_LABELS[input.type] }, h('span', { class: 'num' }), h('span', { class: 'icon' }, INPUT_ICONS[input.type] ?? ''), h('span', { class: 'name' }), h('span', { class: 'time' })),
    h('div', { class: 'card-actions' }, actions),
  );
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCardMenu(input, e.clientX, e.clientY);
  });
  enableDrag(card, input);
  cards.set(input.id, card);
  $('#inputs').append(card);
}

function openCardMenu(input, x, y) {
  const items = [];
  if (input.hasVideo) {
    items.push(['A Preview', () => app.actions.setPreview(input.id)]);
    items.push(['A Program (corte)', () => app.actions.cutTo(input.id)]);
    items.push(null);
  }
  items.push(['Ajustes y efectos…', () => editInput(input)]);
  if (input.type === 'video') items.push(['⚡ Optimizar para reproducción fluida', () => app.actions.optimizeInput(input)]);
  if (input.channel) items.push(['Audio y efectos de audio…', () => app.actions.editAudio(input)]);
  items.push(null);
  items.push(['Quitar entrada', () => app.actions.removeInput(input, { undoable: true }), { danger: true }]);
  showMenu(x, y, items);
}

export function removeCard(input) {
  const card = cards.get(input.id);
  if (card) {
    thumbObserver.unobserve($('.thumb', card));
    card.remove();
  }
  cards.delete(input.id);
  app.compositor.thumbs.delete(input.id);
}

export function updateCards() {
  $('#inputs-empty').hidden = state.inputs.length > 0;
  const container = $('#inputs');
  state.inputs.forEach((input, index) => {
    const card = cards.get(input.id);
    if (!card) return;
    if (container.children[index + 1] !== card) container.insertBefore(card, container.children[index + 1] ?? null);
    const isProgram = input.id === state.programId;
    const isPreview = input.id === state.previewId && !isProgram;
    const layer = overlayIndexOf(input.id);
    card.classList.toggle('is-program', isProgram);
    card.classList.toggle('is-preview', isPreview);
    card.classList.toggle('is-overlay', layer >= 0 && !isProgram);
    // Tally also as text, so it doesn't rely on telling red from green.
    $('.tally-label', card).textContent = isProgram ? 'AL AIRE' : isPreview ? 'PREVIEW' : layer >= 0 ? `CAPA ${layer + 1}` : '';
    $('.num', card).textContent = String(index + 1);
    $('.name', card).textContent = input.name;
    $$('button.ov', card).forEach((btn) => {
      const ov = state.overlays[Number(btn.dataset.ov)];
      btn.classList.toggle('on', ov.inputId === input.id && ov.target > 0);
    });
  });
}

/** Playback progress and remaining time for clips (called a few times a second). */
export function updateCardTimes() {
  for (const input of state.inputs) {
    if ('listInfo' in input) {
      const card = cards.get(input.id);
      if (card) $('.time', card).textContent = input.listInfo;
      continue;
    }
    if (!('progress' in input)) continue;
    const card = cards.get(input.id);
    if (!card) continue;
    if (input.optimizing != null) {
      $('.bar div', card).style.width = `${(input.optimizing * 100).toFixed(1)}%`;
      $('.time', card).textContent = `⚡ ${Math.round(input.optimizing * 100)}%`;
      continue;
    }
    $('.bar div', card).style.width = `${(input.progress * 100).toFixed(1)}%`;
    $('.time', card).textContent = input.remaining ? `-${fmtTime(input.remaining * 1000).replace(/^00:/, '')}` : '';
  }
}

function enableDrag(card, input) {
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(input.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    $$('.drop-before').forEach((el) => el.classList.remove('drop-before'));
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('.drop-before').forEach((el) => el.classList.remove('drop-before'));
    card.classList.add('drop-before');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = Number(e.dataTransfer.getData('text/plain'));
    const moving = state.inputs.find((i) => i.id === fromId);
    if (!moving || moving === input) return;
    state.inputs.splice(state.inputs.indexOf(moving), 1);
    state.inputs.splice(state.inputs.indexOf(input), 0, moving);
    changed();
  });
}

// ---------------------------------------------------------------------------
// Adding inputs
// ---------------------------------------------------------------------------

async function listDevices(kind) {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === kind && d.label)) {
    // Labels are only exposed after permission has been granted once.
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // No device or permission denied; the list below stays empty.
    }
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => [d.deviceId, d.label || `${kind === 'videoinput' ? 'Cámara' : 'Micrófono'} ${i + 1}`]);
}

export const adders = {
  async scene() {
    const scene = new SceneInput(`Escena ${state.inputs.filter((i) => i.type === 'scene').length + 1}`);
    app.actions.addInput(scene);
    app.actions.setPreview(scene.id);
    openSceneDock();
  },

  async network() {
    const dlg = $('#dlg-network');
    const form = dlg.querySelector('form');
    let mode = 'listen';
    const setMode = (m) => {
      mode = m;
      $$('#net-mode button', dlg).forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      $$('[data-net]', dlg).forEach((el) => {
        el.hidden = el.dataset.net !== m;
      });
    };
    $$('#net-mode button', dlg).forEach((b) => {
      b.onclick = () => setMode(b.dataset.mode);
    });
    setMode('listen');
    const ips = await window.studio.lanAddresses();
    const help = () => {
      const port = Number(form.port.value) || 9000;
      $('#net-listen-help').textContent = `Desde el móvil (p. ej. Larix Broadcaster), OBS u otro equipo, emite a: ${ips.map((ip) => `srt://${ip}:${port}`).join('  o  ') || `srt://<IP de este equipo>:${port}`}. Windows puede pedir permiso en el cortafuegos.`;
    };
    form.port.oninput = help;
    help();
    if ((await ask(dlg)) !== 'ok') return;
    const port = Number(form.port.value) || 9000;
    const url = mode === 'listen' ? `srt://0.0.0.0:${port}?mode=listener&latency=120000` : form.url.value.trim();
    if (!url) return toast('Escribe la dirección de la señal.', 'error');
    const { NetworkInput } = await import('./netinput.js');
    app.actions.addInput(new NetworkInput({ url, name: form.name.value.trim() || 'Cámara de red', listenPort: mode === 'listen' ? port : null }));
  },

  async guest() {
    await app.actions.openGuests?.();
  },

  async camera() {
    const dlg = $('#dlg-camera');
    const form = dlg.querySelector('form');
    const [videos, audios] = await Promise.all([listDevices('videoinput'), listDevices('audioinput')]);
    if (!videos.length) return toast('No se ha encontrado ninguna cámara.', 'error');
    fillSelect(form.video, videos, videos[0][0]);
    fillSelect(form.audio, [['', 'Sin audio'], ...audios], '');
    form.name.value = videos[0][1];
    form.video.onchange = () => {
      form.name.value = form.video.selectedOptions[0]?.textContent ?? form.name.value;
    };
    if ((await ask(dlg)) !== 'ok') return;
    app.actions.addInput(await CameraInput.create({ videoDeviceId: form.video.value, audioDeviceId: form.audio.value, name: form.name.value }));
  },

  async mic() {
    const dlg = $('#dlg-mic');
    const form = dlg.querySelector('form');
    const audios = await listDevices('audioinput');
    if (!audios.length) return toast('No se ha encontrado ningún micrófono.', 'error');
    fillSelect(form.audio, audios, audios[0][0]);
    form.name.value = audios[0][1];
    form.audio.onchange = () => {
      form.name.value = form.audio.selectedOptions[0]?.textContent ?? form.name.value;
    };
    if ((await ask(dlg)) !== 'ok') return;
    app.actions.addInput(await MicInput.create({ audioDeviceId: form.audio.value, name: form.name.value }));
  },

  async video() {
    for (const file of await window.studio.openMedia('video')) {
      const input = new VideoFileInput(file);
      app.actions.addInput(input);
      app.actions.checkVideo(input);
    }
  },

  async image() {
    for (const file of await window.studio.openMedia('image')) app.actions.addInput(new ImageInput(file));
  },

  async audio() {
    for (const file of await window.studio.openMedia('audio')) app.actions.addInput(new AudioFileInput(file));
  },

  async screen() {
    const dlg = $('#dlg-screen');
    const grid = $('#screen-sources');
    grid.replaceChildren(h('div', { class: 'muted' }, 'Buscando pantallas y ventanas…'));
    let chosen = null;
    const pending = ask(dlg);
    const sources = await window.studio.listDisplaySources();
    grid.replaceChildren(
      ...sources.map((source) =>
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              chosen = source;
              dlg.close('ok');
            },
          },
          h('img', { src: source.thumbnail, alt: '' }),
          h('span', {}, `${source.isScreen ? '🖥 ' : ''}${source.name}`),
        ),
      ),
    );
    if ((await pending) !== 'ok' || !chosen) return;
    app.actions.addInput(await ScreenInput.create(chosen.id, chosen.name));
  },

  async color() {
    const dlg = $('#dlg-color');
    if ((await ask(dlg)) !== 'ok') return;
    const form = dlg.querySelector('form');
    const input = new ColorInput(form.color.value, form.name.value);
    if (form.gradient.checked) input.color2 = form.color2.value;
    app.actions.addInput(input);
  },

  async title() {
    const result = await editTitle(null);
    if (!result) return;
    app.actions.addInput(new TitleInput(result.fields, result.name));
  },
};

// ---------------------------------------------------------------------------
// Title editor
// ---------------------------------------------------------------------------

export async function editTitle(input) {
  const dlg = $('#dlg-title');
  const form = dlg.querySelector('form');
  let fields = { ...DEFAULT_TITLE, ...(input?.fields ?? {}) };
  $('#title-dlg-heading').textContent = input ? 'Editar título' : 'Nuevo título o gráfico';
  fillSelect(form.template, Object.entries(TITLE_TEMPLATES).map(([k, t]) => [k, t.label]), fields.template);
  form.name.value = input?.name ?? '';
  for (const key of ['accent', 'textColor', 'bgColor', 'bgOpacity']) form[key].value = fields[key];

  const fieldBox = $('#title-fields');
  const renderFields = () => {
    const template = TITLE_TEMPLATES[form.template.value];
    fieldBox.replaceChildren(
      ...template.uses.map((key) =>
        h('label', { class: 'field' }, template.labels?.[key] ?? FIELD_LABELS[key], h('input', {
          name: `f-${key}`,
          type: NUMERIC_FIELDS.has(key) ? 'number' : 'text',
          min: NUMERIC_FIELDS.has(key) ? 0 : null,
          step: key === 'minutes' ? 0.5 : null,
          value: fields[key],
        })),
      ),
    );
  };
  renderFields();
  form.list.value = fields.list ?? '';
  const listBox = $('#title-list-box');
  listBox.open = !!fields.list;
  $('#btn-title-csv').onclick = async () => {
    const text = await window.studio.openText();
    if (text == null) return;
    form.list.value = text.trim();
    listBox.open = true;
  };
  form.template.onchange = () => {
    fields = { ...fields, ...read(), ...(TEMPLATE_PRESETS[form.template.value] ?? {}) };
    for (const key of ['accent', 'textColor', 'bgColor', 'bgOpacity']) form[key].value = fields[key];
    renderFields();
  };

  const read = () => {
    const out = {
      template: form.template.value,
      accent: form.accent.value,
      textColor: form.textColor.value,
      bgColor: form.bgColor.value,
      bgOpacity: Number(form.bgOpacity.value),
    };
    for (const el of $$('input', fieldBox)) {
      const key = el.name.slice(2);
      out[key] = NUMERIC_FIELDS.has(key) ? Number(el.value) || 0 : el.value;
    }
    return out;
  };

  const canvas = $('#title-preview');
  const ctx = canvas.getContext('2d');
  const sample = new TitleInput(fields);
  const opened = performance.now();
  let raf = 0;
  const paint = (now) => {
    sample.fields = { ...fields, ...read() };
    drawChecker(ctx, 0, 0, canvas.width, canvas.height);
    // Replay the entry animation every few seconds.
    const anim = Math.min(1, ((now - opened) % 4000) / 500);
    sample.render(ctx, 0, 0, canvas.width, canvas.height, now, 'preview', anim);
    raf = requestAnimationFrame(paint);
  };
  raf = requestAnimationFrame(paint);
  const answer = await ask(dlg);
  cancelAnimationFrame(raf);
  if (answer !== 'ok') return null;
  const result = { ...fields, ...read(), list: form.list.value.trim() };
  // A new or changed list starts from its first entry.
  if (result.list && result.list !== (fields.list ?? '')) {
    const rows = parseTitleList(result.list);
    if (rows.length) {
      result.listIndex = 0;
      result.title = rows[0][0];
      result.subtitle = rows[0][1] ?? '';
    }
  }
  const name = form.name.value.trim() || TITLE_TEMPLATES[result.template].label.replace(/\s*\(.*\)$/, '');
  return { name, fields: result };
}

// ---------------------------------------------------------------------------
// Input settings and effects (applied live)
// ---------------------------------------------------------------------------

/** Form fields bound to input.fx: every key of DEFAULT_FX except the mask path. */
const FX_FIELDS = Object.keys(DEFAULT_FX).filter((k) => k !== 'maskPath');

function lutOptions(current) {
  const options = [['', 'Ninguno'], ...Object.entries(LUT_PRESETS).map(([k, p]) => [`preset:${k}`, p.label])];
  if (current && !current.startsWith('preset:')) options.push([current, `Archivo: ${current.split(/[\\/]/).pop()}`]);
  return options;
}

export async function editInput(input) {
  if (input instanceof SceneInput) {
    app.actions.setView('studio');
    app.actions.setPreview(input.id);
    openSceneDock();
    return;
  }
  const dlg = $('#dlg-input');
  const form = dlg.querySelector('form');
  $('#input-dlg-heading').textContent = `${INPUT_TYPE_LABELS[input.type]} · ${input.name}`;
  form.name.value = input.name;
  form.fit.value = input.fit;
  fillSelect(form.layout, Object.entries(LAYOUTS).map(([k, l]) => [k, l.label]), input.layout);
  const hasLoop = 'loop' in input;
  const videoFx = ['camera', 'video', 'image', 'screen', 'network', 'guest'].includes(input.type);
  $('[data-only=loop]', dlg).hidden = !hasLoop;
  $('[data-only=title]', dlg).hidden = input.type !== 'title';
  $$('[data-only=video-fx]', dlg).forEach((el) => {
    el.hidden = !videoFx;
  });
  if (hasLoop) form.loop.checked = input.loop;

  const showKeyFields = () => {
    $$('[data-key-type]', dlg).forEach((el) => {
      el.hidden = !el.dataset.keyType.split(' ').includes(input.fx.keyType);
    });
    $('#mask-name').textContent = input.fx.maskPath ? input.fx.maskPath.split(/[\\/]/).pop() : 'Sin máscara';
  };
  const syncFxForm = () => {
    fillSelect(form.lut, lutOptions(input.fx.lut), input.fx.lut);
    for (const key of FX_FIELDS) {
      const el = form[key];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = input.fx[key];
      else el.value = input.fx[key];
    }
    showKeyFields();
  };
  syncFxForm();

  const apply = () => {
    input.name = form.name.value || input.name;
    input.fit = form.fit.value;
    input.layout = form.layout.value;
    if (hasLoop) input.loop = form.loop.checked;
    for (const key of FX_FIELDS) {
      const el = form[key];
      if (!el) continue;
      if (el.type === 'checkbox') input.fx[key] = el.checked;
      else if (typeof DEFAULT_FX[key] === 'string') input.fx[key] = el.value;
      else input.fx[key] = Number(el.value);
    }
    showKeyFields();
    changed();
  };
  form.oninput = apply;
  form.onchange = apply;
  $$('[data-key]', dlg).forEach((btn) => {
    btn.onclick = () => {
      form.keyColor.value = btn.dataset.key;
      form.keyOn.checked = true;
      apply();
    };
  });
  $('#btn-reset-fx').onclick = () => {
    Object.assign(input.fx, DEFAULT_FX);
    syncFxForm();
    changed();
  };
  $('#btn-load-lut').onclick = async () => {
    const file = await window.studio.openLut();
    if (!file) return;
    try {
      parseCube(await window.studio.readLut(file));
    } catch (err) {
      toast(`No se pudo cargar la LUT: ${err.message}`, 'error');
      return;
    }
    input.fx.lut = file;
    syncFxForm();
    changed();
  };
  $('#btn-load-mask').onclick = async () => {
    const [file] = await window.studio.openMedia('image');
    if (!file) return;
    input.fx.maskPath = file.path;
    syncFxForm();
    changed();
  };
  $('#btn-clear-mask').onclick = () => {
    input.fx.maskPath = '';
    syncFxForm();
    changed();
  };
  $('#btn-edit-title').onclick = async () => {
    dlg.close('ok');
    const result = await editTitle(input);
    if (result) {
      input.name = result.name;
      input.fields = result.fields;
      rebuildCard(input);
      changed();
    }
  };

  // --- Ajuste y recorte -------------------------------------------------------
  const cropCanvas = $('#crop-editor');
  const cropFields = $$('[data-crop]', dlg);
  const syncFraming = () => {
    form.fit.value = input.fit;
    form.rotate.value = input.fx.rotate;
    $$('#fit-buttons button', dlg).forEach((b) => b.classList.toggle('on', b.dataset.fit === input.fit));
    $$('#rotate-buttons button', dlg).forEach((b) => b.classList.toggle('on', Number(b.dataset.rotate) === input.fx.rotate));
    const out = $('output[data-for=zoom]', dlg);
    if (out) out.textContent = `${Number(input.fx.zoom).toFixed(2)}×`;
    const { w, h } = crop.size;
    for (const el of cropFields) {
      if (document.activeElement === el || !w) continue;
      const key = el.dataset.crop;
      el.value = Math.round(input.fx[key] * (key === 'cropL' || key === 'cropR' ? w : h));
    }
  };
  const crop = new CropEditor(cropCanvas, input, () => {
    syncFraming();
    changed();
  });
  $$('#fit-buttons button', dlg).forEach((b) => {
    b.onclick = () => {
      form.fit.value = b.dataset.fit;
      apply();
      syncFraming();
    };
  });
  $$('#rotate-buttons button', dlg).forEach((b) => {
    b.onclick = () => {
      form.rotate.value = b.dataset.rotate;
      apply();
      // A fixed proportion means the on-screen shape, so re-fit it to the new orientation.
      if (crop.aspect) crop.applyAspect(crop.aspect);
      syncFraming();
    };
  });
  const aspect = $('#crop-aspect');
  aspect.value = '';
  aspect.onchange = () => crop.applyAspect(Number(aspect.value) || null);
  for (const el of cropFields) {
    el.oninput = () => {
      const { w, h } = crop.size;
      if (!w) return;
      const key = el.dataset.crop;
      const total = key === 'cropL' || key === 'cropR' ? w : h;
      const opposite = { cropL: 'cropR', cropR: 'cropL', cropT: 'cropB', cropB: 'cropT' }[key];
      // Leave at least 16 px between opposite edges.
      const max = 1 - input.fx[opposite] - 16 / total;
      input.fx[key] = Math.min(max, Math.max(0, Number(el.value) / total));
      changed();
    };
  }
  $('#btn-crop-reset').onclick = () => {
    Object.assign(input.fx, { cropL: 0, cropR: 0, cropT: 0, cropB: 0 });
    aspect.value = '';
    crop.aspect = null;
    syncFraming();
    changed();
  };
  $('#btn-reset-framing').onclick = () => {
    input.fit = 'contain';
    Object.assign(input.fx, { cropL: 0, cropR: 0, cropT: 0, cropB: 0, rotate: 0, zoom: 1, panX: 0, panY: 0, flip: false });
    aspect.value = '';
    crop.aspect = null;
    syncFxForm();
    syncFraming();
    changed();
  };

  // Tabs
  const tabs = $$('.tabs button', dlg);
  const preview = $('#input-preview');
  let tab = 'general';
  const showTab = (name) => {
    tab = name;
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab-page', dlg).forEach((p) => {
      p.hidden = p.dataset.page !== name;
    });
    cropCanvas.hidden = name !== 'framing';
    preview.classList.toggle('small', name === 'framing');
    $('#input-preview-note').textContent = name === 'framing' ? 'Abajo: resultado final.' : 'Los cambios se aplican en directo.';
  };
  tabs.forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab);
  });
  showTab('general');

  // Live preview of this input with its effects over a checkerboard.
  const ctx = preview.getContext('2d');
  let raf = 0;
  let frame = 0;
  const paint = (now) => {
    drawChecker(ctx, 0, 0, preview.width, preview.height);
    ctx.save();
    input.draw(ctx, 0, 0, preview.width, preview.height, now, 'program', -1, 1);
    ctx.restore();
    if (tab === 'framing') {
      crop.draw();
      if (frame++ % 10 === 0) syncFraming();
    }
    raf = requestAnimationFrame(paint);
  };
  raf = requestAnimationFrame(paint);
  await ask(dlg);
  cancelAnimationFrame(raf);
  crop.destroy();
  form.oninput = null;
  form.onchange = null;
  changed();
}

/** Recreates a card after something that changes its controls (e.g. title template). */
export function rebuildCard(input) {
  removeCard(input);
  buildCard(input);
}
