// Person segmentation ("quitar fondo sin croma") with MediaPipe's selfie
// segmenter on the GPU. Produces a small canvas whose alpha is the person mask,
// used by the effect shader like an image mask.

let filesetPromise = null;
let modelUrlPromise = null;

async function loadVision() {
  const vision = await import('../vendor/mediapipe/vision_bundle.mjs');
  filesetPromise ??= vision.FilesetResolver.forVisionTasks('app://studiomix/vendor/mediapipe/wasm');
  modelUrlPromise ??= window.studio.ensureModel('selfie_segmenter.tflite').then((r) => r.url);
  const [fileset, modelUrl] = await Promise.all([filesetPromise, modelUrlPromise]);
  return { vision, fileset, modelUrl };
}

export class BackgroundRemover {
  constructor() {
    this.segmenter = null;
    this.state = 'loading';
    this.error = null;
    this.mask = document.createElement('canvas');
    this.ctx = this.mask.getContext('2d', { willReadFrequently: true });
    this.lastFrame = -1;
    this.lastTime = 0;
    this.ready = this.init();
  }

  async init() {
    try {
      const { vision, fileset, modelUrl } = await loadVision();
      const create = (delegate) =>
        vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      try {
        this.segmenter = await create('GPU');
      } catch {
        this.segmenter = await create('CPU');
      }
      this.state = 'ready';
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      console.warn('Quitar fondo no disponible', err);
    }
  }

  /**
   * Mask for the current frame of `source` (video, canvas), at most once per
   * compositor frame. Returns null until the model is ready.
   */
  maskFor(source, frame) {
    if (this.state !== 'ready') return null;
    if (frame >= 0 && frame === this.lastFrame) return this.mask;
    this.lastFrame = frame;
    // Timestamps must increase strictly for VIDEO mode.
    const now = Math.max(performance.now(), this.lastTime + 1);
    this.lastTime = now;
    try {
      const result = this.segmenter.segmentForVideo(source, now);
      // The selfie model gives one "person" mask; two-class variants put
      // background first and person second.
      const masks = result.confidenceMasks ?? [];
      const conf = masks.length > 1 ? masks[1] : masks[0];
      if (conf) {
        const { width, height } = conf;
        if (this.mask.width !== width || this.mask.height !== height) {
          this.mask.width = width;
          this.mask.height = height;
          this.image = this.ctx.createImageData(width, height);
        }
        const values = conf.getAsFloat32Array();
        const px = this.image.data;
        for (let i = 0; i < values.length; i++) {
          // Soften the edge a little: map 0.3…0.7 confidence to 0…1.
          const a = Math.min(1, Math.max(0, (values[i] - 0.3) / 0.4));
          px[i * 4] = 255;
          px[i * 4 + 1] = 255;
          px[i * 4 + 2] = 255;
          px[i * 4 + 3] = a * 255;
        }
        this.ctx.putImageData(this.image, 0, 0);
      }
      result.close?.();
    } catch (err) {
      console.warn('Segmentación', err);
    }
    return this.mask;
  }

  dispose() {
    this.segmenter?.close();
    this.segmenter = null;
    this.state = 'closed';
  }
}
