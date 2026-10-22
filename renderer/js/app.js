// Renderer entry point: creates the services (audio, compositor, outputs,
// MIDI), registers them in `app` and starts each part of the interface.

import './errors.js';
import { AudioEngine } from './audio.js';
import { Compositor } from './compositor.js';
import { MidiController } from './midi.js';
import { OutputManager } from './outputs.js';
import { app, changed, state } from './store.js';
import { actions } from './actions.js';
import { handleMidiAction } from './midi-actions.js';
import { ask, initPanels, showMenu, toast } from './ui-common.js';
import { openMidiDialog, renderMidiDialog } from './ui-midi.js';
import { buildMasterStrip, startMeters } from './ui-mixer.js';
import { initSceneEditor } from './ui-scenes.js';
import { initGuide } from './ui-guide.js';
import { initGoLive, openGoLive } from './ui-golive.js';
import { initRemote } from './ui-remote.js';
import { initChat } from './ui-chat.js';
import { initGuests } from './ui-guests.js';
import { initVertical } from './ui-vertical.js';
import { initStats } from './ui-stats.js';
import { initControls } from './ui-controls.js';
import { initOutputs, renderOutputs } from './ui-outputs.js';
import { initAutosave, openProject, saveProject } from './ui-projects.js';
import { initScreens, openScreens } from './ui-screens.js';
import { initMidiLearn, onMidiChange, onMidiLearned } from './ui-midi-learn.js';
import { hasUpdate, initUpdates, openUpdates, updateSummary } from './ui-updates.js';
import { openSettings } from './ui-outputs.js';
import { $ } from './util.js';

// --- services -------------------------------------------------------------------

const audio = new AudioEngine();
await audio.init();
audio.setLimiter(state.settings.limiter);
if (state.settings.monitorDevice) {
  audio.setOutputDevice(state.settings.monitorDevice).catch(() => {
    toast('La salida de audio elegida para la escucha no está conectada; se usa la predeterminada.', 'error');
  });
}

const compositor = new Compositor(state, $('#program-canvas'), $('#preview-canvas'), $('#multiview-canvas'));
compositor.configure(state.settings.width, state.settings.height, state.settings.fps);
compositor.onCommit = () => changed();
compositor.onMasterFade = (value) => audio.setFade(value);
compositor.stinger.onAudioElement = (el) => audio.connectElement(el);
// Media paths are only served after the user picks them again (or opens a project).
state.settings.stinger.path = '';

const outputs = new OutputManager({
  tracksFor: (kind) => [kind === 'vstream' ? compositor.verticalTrack : compositor.videoTrack, audio.outputTrack],
  settings: () => state.settings,
  onChange: () => {
    renderOutputs();
    changed();
  },
  onError: (message) => toast(message, 'error'),
  onFinished: (key, file) => {
    if ((key === 'record' || key === 'vrecord') && file) toast(`Grabación guardada en:\n${file}`);
  },
  onReconnect: (key, entry, recovered) => {
    const what = key === 'vstream' ? 'La emisión vertical' : 'La emisión';
    if (recovered) toast(`${what} se ha recuperado.`);
    else if (entry.attempt === 1) toast(`${what} perdió la conexión. Reconectando automáticamente…\nLa grabación local sigue en marcha.`, 'error');
  },
});

const midi = new MidiController({
  onAction: handleMidiAction,
  onChange: () => {
    renderMidiDialog();
    onMidiChange();
  },
  onLearned: onMidiLearned,
});

Object.assign(app, { state, audio, compositor, outputs, midi, actions });

// --- interface --------------------------------------------------------------------

initControls();
buildMasterStrip();
initStats();
startMeters();
initPanels();
initSceneEditor();
initGoLive();
initRemote();
initChat();
initGuests();
initVertical();
initGuide();
initOutputs();
initAutosave();
initScreens();
initMidiLearn();

$('#btn-record-pause').addEventListener('click', actions.togglePause);
$('#btn-replay').addEventListener('click', actions.toggleReplay);
$('#btn-replay-save').addEventListener('click', actions.saveReplay);
// Less frequent actions grouped in one menu (fewer choices in the bar, Hick's law).
$('#btn-menu').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 300, r.bottom + 4, [
    { header: 'Proyecto' },
    ['Abrir proyecto…', openProject, { icon: '📂', hint: 'Ctrl+O' }],
    ['Guardar proyecto', () => saveProject(false), { icon: '💾', hint: 'Ctrl+S' }],
    ['Guardar como…', () => saveProject(true), { icon: '📄', hint: 'Ctrl+Mayús+S' }],
    { header: 'Directo' },
    ['Captura de Program', actions.snapshot, { icon: '📷', hint: 'S' }],
    ['Abrir carpeta de grabaciones', () => window.studio.openFolder(state.settings.recordFolder || null), { icon: '📁' }],
    ['Salidas a pantallas y móvil…', openScreens, { icon: '🖥' }],
    { header: 'Conexiones' },
    ['Invitados remotos…', () => actions.openGuests?.(), { icon: '👤' }],
    ['Mando remoto y Stream Deck…', () => actions.openRemote?.(), { icon: '📱' }],
    ['Controlador MIDI…', openMidiDialog, { icon: '🎹' }],
    { header: 'Aplicación' },
    ['Ajustes…', openSettings, { icon: '⚙' }],
    ['Buscar actualizaciones…', openUpdates, { icon: '⟳', badge: hasUpdate() ? 'Nueva' : null }],
    ['Atajos de teclado', () => ask($('#dlg-help')), { icon: '⌨', hint: '?' }],
    { footer: updateSummary() },
  ], { className: 'main-menu' });
});
// The button opens the go-live sheet (destinations + pre-flight); while live it stops.
$('#btn-stream').addEventListener('click', () => (outputs.get('stream') ? actions.toggleOutput('stream') : openGoLive()));
$('#btn-record').addEventListener('click', () => actions.toggleOutput('record'));
document.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('beforeunload', () => {
  outputs.stopAll();
});

midi.init();
window.studio.onOptimizeProgress(({ file, progress }) => {
  for (const input of state.inputs) {
    if (input.optimizing != null && (input.originalPath ?? input.path) === file) input.optimizing = progress;
  }
});
initUpdates();

changed();

// Exposed for debugging from DevTools.
window.studioMix = { state, compositor, audio, outputs, midi, actions, changed };
