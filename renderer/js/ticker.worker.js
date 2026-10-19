// Frame clock for the compositor. Worker timers are not throttled when the
// window is hidden or busy with UI work, so output timing stays steady.
let timer = null;

self.onmessage = (event) => {
  clearInterval(timer);
  timer = null;
  const fps = Number(event.data) || 0;
  if (fps > 0) timer = setInterval(() => self.postMessage(performance.now()), 1000 / fps);
};
