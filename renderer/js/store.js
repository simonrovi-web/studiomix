// Shared application state and a tiny change bus.

const SETTINGS_KEY = 'studiomix.settings';
export const OVERLAY_COUNT = 4;

export const DEFAULT_SETTINGS = {
  width: 1920,
  height: 1080,
  fps: 30,
  transitionType: 'fade',
  transitionDuration: 1000,
  destinations: [{ id: 1, enabled: true, name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', key: '' }],
  streamVideoKbps: 4500,
  audioKbps: 160,
  encoder: 'auto',
  x264Preset: 'veryfast',
  recordFolder: '',
  recordFormat: 'mp4',
  recordMbps: 16,
  limiter: true,
  stinger: { path: '', cutPoint: 500 },
  luma: { pattern: 'linearH', softness: 0.1, invert: false },
  replaySeconds: 20,
  replayAsInput: true,
  guideDismissed: false,
  isoRecording: false,
  chatLayer: 4,
  vertical: { mode: 'reframe', panX: 0 },
  verticalDestinations: [{ id: 101, enabled: true, name: 'TikTok', url: 'rtmp://', key: '' }],
  verticalKbps: 4500,
  // Display id -> 'program' | 'preview' | 'multiview' (see screens.js).
  screenOutputs: {},
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch (err) {
    console.warn('Ajustes dañados; se usan los predeterminados:', err);
  }
  // Settings from 0.1 had a single stream URL/key.
  if (saved.streamUrl && !saved.destinations) {
    saved.destinations = [{ id: 1, enabled: true, name: 'Principal', url: saved.streamUrl, key: saved.streamKey || '' }];
  }
  delete saved.streamUrl;
  delete saved.streamKey;
  return { ...structuredClone(DEFAULT_SETTINGS), ...saved };
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // Settings simply won't persist.
  }
}

export const state = {
  settings: loadSettings(),
  inputs: [],
  previewId: null,
  programId: null,
  overlays: Array.from({ length: OVERLAY_COUNT }, () => ({ inputId: null, alpha: 0, target: 0 })),
  ftb: { alpha: 0, target: 0 },
  transition: { type: 'fade', duration: 1000, running: false, startedAt: 0, from: 0, manual: 0, progress: 0 },
  view: 'studio',
};
state.transition.type = state.settings.transitionType;
state.transition.duration = state.settings.transitionDuration;
// The transition keeps live references to these settings objects.
state.transition.stinger = state.settings.stinger;
state.transition.luma = state.settings.luma;

export const byId = (id) => (id == null ? null : state.inputs.find((input) => input.id === id) ?? null);

export function overlayIndexOf(id) {
  return state.overlays.findIndex((ov) => ov.inputId === id && ov.target > 0);
}

const bus = new EventTarget();

/** Notify listeners that state changed; UI modules re-render from state. */
export function changed() {
  bus.dispatchEvent(new Event('change'));
}

export function onChange(listener) {
  bus.addEventListener('change', listener);
}

/** Late-bound references to the app's services, filled in by app.js. */
export const app = {};
