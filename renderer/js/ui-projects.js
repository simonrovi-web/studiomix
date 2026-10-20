// Project files (open/save), autosave every few seconds after a change, and
// recovering the montage when the previous session didn't close cleanly.

import { loadProject, serializeProject } from './project.js';
import { app, changed, onChange, state } from './store.js';
import { confirmAction, toast } from './ui-common.js';
import { loadStinger } from './stinger-files.js';

let projectPath = null;

function setProjectPath(file) {
  projectPath = file;
  document.title = file ? `StudioMix · ${file.split(/[\\/]/).pop()}` : 'StudioMix';
}

export async function saveProject(saveAs = false) {
  try {
    const file = await window.studio.saveProject(serializeProject(), saveAs ? null : projectPath);
    if (!file) return;
    setProjectPath(file);
    toast(`Proyecto guardado:\n${file}`);
  } catch (err) {
    toast(`No se pudo guardar: ${err.message}`, 'error');
  }
}

/** Replaces the montage with a loaded project; returns the inputs that couldn't be restored. */
async function applyProject(result) {
  const { actions } = app;
  actions.clearInputs();
  const skipped = await loadProject(result.data, result.media, actions.addInput);
  const stingerPath = result.data.transition?.stinger?.path;
  try {
    await loadStinger(stingerPath ? result.media[stingerPath] ?? null : null);
  } catch (err) {
    toast(`No se pudo cargar el stinger: ${err.message}`, 'error');
  }
  changed();
  return skipped;
}

export async function openProject() {
  if (state.inputs.length && !(await confirmAction('Abrir un proyecto sustituye las entradas actuales.', { ok: 'Abrir proyecto' }))) return;
  let result;
  try {
    result = await window.studio.openProject();
  } catch (err) {
    return toast(`No se pudo abrir el proyecto: ${err.message}`, 'error');
  }
  if (!result) return;
  if (app.outputs.busy) return toast('Detén la emisión y la grabación antes de abrir otro proyecto.', 'error');
  const skipped = await applyProject(result);
  setProjectPath(result.file);
  if (skipped.length) toast(`No se pudieron restaurar: ${skipped.join(', ')}.\nLas capturas de pantalla hay que añadirlas de nuevo.`, 'error');
  else toast('Proyecto abierto.');
}

export function initAutosave() {
  let dirty = false;
  let failing = false;
  onChange(() => {
    dirty = true;
  });
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    window.studio.autosave(serializeProject()).then(
      () => {
        failing = false;
      },
      (err) => {
        // Retried on the next tick; report once per failure streak, not every 5 s.
        dirty = true;
        if (!failing) console.error('Autoguardado fallido:', err);
        failing = true;
      },
    );
  }, 5000);

  window.studio.checkRecovery().then((info) => {
    if (!info) return;
    const when = new Date(info.savedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    toast(`StudioMix no se cerró bien la última vez.\n¿Recuperar el montaje guardado a las ${when}?`, 'info', {
      label: 'Recuperar',
      dismissLabel: 'Empezar de cero',
      onClick: async () => {
        try {
          const skipped = await applyProject(await window.studio.loadRecovery());
          toast(skipped.length ? `Montaje recuperado. No se pudieron restaurar: ${skipped.join(', ')}.` : 'Montaje recuperado.');
        } catch (err) {
          toast(`No se pudo recuperar: ${err.message}`, 'error');
        }
      },
    }, { timeout: 60000, onExpire: () => window.studio.discardRecovery() });
  });
}
