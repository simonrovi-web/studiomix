// Sends renderer errors to the main-process log file, so problems on a show
// machine can be diagnosed afterwards. Imported first by app.js.

const MAX_PER_MINUTE = 30;
let sent = 0;
setInterval(() => {
  sent = 0;
}, 60_000);

function describe(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function forward(level, parts) {
  // A failure in a render loop would otherwise flood the log.
  if (++sent > MAX_PER_MINUTE) return;
  try {
    window.studio?.log(level, parts.map(describe).join(' '));
  } catch {
    // The bridge is gone (page unloading): nothing left to report to.
  }
}

for (const level of ['error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...parts) => {
    original(...parts);
    forward(level, parts);
  };
}

window.addEventListener('error', (e) => {
  forward('error', [e.error ?? `${e.message} (${e.filename}:${e.lineno})`]);
});
window.addEventListener('unhandledrejection', (e) => {
  forward('error', ['Promesa rechazada sin controlar:', e.reason]);
});
