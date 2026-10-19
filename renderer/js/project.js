// Save and restore the show: inputs (with effects and audio settings), their
// order, and the transition. Global settings stay in local preferences.
import {
  AudioFileInput,
  CameraInput,
  ColorInput,
  ImageInput,
  MicInput,
  TitleInput,
  VideoFileInput,
} from './inputs.js';
import { SceneInput } from './scenes.js';
import { state } from './store.js';

const VERSION = 1;

export function serializeProject() {
  return JSON.stringify(
    {
      app: 'StudioMix',
      version: VERSION,
      savedAt: new Date().toISOString(),
      transition: {
        type: state.transition.type,
        duration: state.transition.duration,
        stinger: { path: state.transition.stinger.path, cutPoint: state.transition.stinger.cutPoint },
        luma: { ...state.transition.luma },
      },
      programIndex: state.inputs.findIndex((i) => i.id === state.programId),
      previewIndex: state.inputs.findIndex((i) => i.id === state.previewId),
      inputs: state.inputs.map((input) => input.serialize()),
    },
    null,
    2,
  );
}

async function createInput(data, media) {
  const file = data.path ? media[data.path] : null;
  switch (data.type) {
    case 'video':
      return file ? new VideoFileInput(file) : null;
    case 'audio':
      return file ? new AudioFileInput(file) : null;
    case 'image':
      return file ? new ImageInput(file) : null;
    case 'camera':
      return CameraInput.create({ videoDeviceId: data.videoDeviceId, audioDeviceId: data.audioDeviceId, name: data.name });
    case 'mic':
      return MicInput.create({ audioDeviceId: data.audioDeviceId, name: data.name });
    case 'color':
      return new ColorInput(data.color, data.name);
    case 'title':
      return new TitleInput(data.fields, data.name);
    case 'scene':
      return new SceneInput(data.name);
    case 'network': {
      if (!data.url) return null;
      const { NetworkInput } = await import('./netinput.js');
      return new NetworkInput({ url: data.url, name: data.name, listenPort: data.listenPort ?? null });
    }
    default:
      return null; // screens must be picked again
  }
}

/**
 * Rebuilds inputs from a project file. Returns the inputs that could not be
 * restored so the caller can tell the user.
 */
export async function loadProject(data, media, addInput) {
  const skipped = [];
  const created = [];
  for (const item of Array.isArray(data.inputs) ? data.inputs : []) {
    try {
      const input = await createInput(item, media);
      if (!input) {
        skipped.push(item.name || item.type);
        created.push(null);
        continue;
      }
      input.restore(item);
      addInput(input, { select: false });
      input.channel?.restore(item.audio);
      created.push(input);
    } catch (err) {
      console.warn('No se pudo restaurar', item, err);
      skipped.push(item.name || item.type);
      created.push(null);
    }
  }
  // Scene layers point at other inputs by position, so resolve them once all exist.
  for (const input of created) if (input instanceof SceneInput) input.resolveItems(created);
  if (data.transition) {
    state.transition.type = data.transition.type ?? state.transition.type;
    state.transition.duration = data.transition.duration ?? state.transition.duration;
    // Merge into the live settings objects the transition shares with preferences.
    if (data.transition.stinger) Object.assign(state.transition.stinger, data.transition.stinger);
    if (data.transition.luma) Object.assign(state.transition.luma, data.transition.luma);
  }
  state.programId = created[data.programIndex]?.id ?? null;
  state.previewId = created[data.previewIndex]?.id ?? created.find((i) => i?.hasVideo)?.id ?? null;
  return skipped;
}
