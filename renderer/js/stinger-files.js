// Loads a stinger file: WebM plays as is; MOV with alpha and HTML animations
// are converted first by the main process (cached, so only the first time is slow).

import { app, state } from './store.js';

export const isHtml = (path) => /\.html?$/i.test(path ?? '');

/**
 * Prepares and loads `file` (a media descriptor, or null to clear) as the
 * stinger. `onProgress(0…1)` reports conversions. Returns the loaded clip.
 */
export async function loadStinger(file, onProgress) {
  const { compositor } = app;
  const stinger = state.transition.stinger;
  if (!file) {
    compositor.stinger.load(null);
    stinger.path = '';
    return null;
  }
  const s = state.settings;
  const off = onProgress
    ? window.studio.onStingerProgress(({ file: source, progress }) => {
        if (source === file.path) onProgress(progress);
      })
    : null;
  try {
    const ready = await window.studio.prepareStinger(file.path, {
      width: s.width,
      height: s.height,
      fps: s.fps,
      durationMs: stinger.htmlDurationMs,
    });
    compositor.stinger.load(ready);
    stinger.path = ready.source;
    return ready;
  } finally {
    off?.();
  }
}
