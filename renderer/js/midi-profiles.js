// Guided setups for known controllers: the order in which to touch each
// physical control and the function it gets. Messages are learnt from the
// device itself, so any preset or reprogrammed control still works.

const range = (from, to, step) => Array.from({ length: to - from + 1 }, (_, i) => step(from + i));

export const MIDI_PROFILES = [
  {
    id: 'samson-conspiracy',
    name: 'Samson Conspiracy',
    note: 'Usa un preset con los botones en modo «Momentary» si puedes; en «Toggle» también funcionan.',
    steps: [
      { action: 'tbar', control: 'el crossfader' },
      ...range(1, 5, (i) => ({ action: `fader-${i}`, control: `el fader ${i} (contando desde la izquierda)` })),
      { action: 'master', control: 'el fader 6 (el de la derecha)' },
      ...range(1, 8, (i) => ({ action: `preview-${i}`, control: `el pad ${i}` })),
      { action: 'cut', control: 'un botón para CUT' },
      { action: 'auto', control: 'un botón para AUTO (transición)' },
      { action: 'ftb', control: 'un botón para el fundido a negro' },
      ...range(1, 4, (i) => ({ action: `overlay-${i}`, control: `un botón o pad para la capa ${i}` })),
      { action: 'record', control: 'un botón para grabar' },
      { action: 'stream', control: 'un botón para emitir (salta este paso si prefieres el ratón)' },
    ],
  },
];
