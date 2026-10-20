// Output window (Program, Preview or Multiview on a monitor or projector).
// The main window opened it, so it takes the video straight from there.
// It never shows text to the audience: without video it simply stays black.
(() => {
  const source = new URLSearchParams(location.search).get('source');
  const video = document.getElementById('video');

  function attach() {
    const stream = window.opener?.studioMixScreens?.streamFor(source);
    if (!stream) return false;
    video.srcObject = stream;
    return true;
  }

  // The main window may still be starting up, or reloading.
  const retry = setInterval(() => {
    const track = video.srcObject?.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') attach();
  }, 1000);
  attach();
  window.addEventListener('unload', () => clearInterval(retry));

  // Pointer and hint appear only while the mouse moves over the output.
  let idleTimer = 0;
  document.addEventListener('mousemove', () => {
    document.body.classList.add('awake');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.remove('awake'), 2500);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });
  document.addEventListener('dblclick', () => window.close());
})();
