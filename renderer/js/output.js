// Output window (Program, Preview or Multiview on a monitor or projector).
// The main window opened it, so it takes the video straight from there.
(() => {
  const source = new URLSearchParams(location.search).get('source');
  const video = document.getElementById('video');

  function attach() {
    const stream = window.opener?.studioMixScreens?.streamFor(source);
    if (!stream) {
      document.getElementById('nosignal').hidden = false;
      return false;
    }
    video.srcObject = stream;
    return true;
  }

  if (!attach()) {
    // The main window may still be starting up.
    const retry = setInterval(() => attach() && clearInterval(retry), 1000);
  }

  // The pointer and the hint disappear while the mouse is still.
  let idleTimer = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  };
  document.addEventListener('mousemove', wake);
  wake();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });
  document.addEventListener('dblclick', () => window.close());
})();
