import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Empty catch blocks must say why they are safe to ignore.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Electron main process and the local servers (CommonJS, Node).
    files: ['*.js', 'main/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // Renderer: ES modules in Chromium, plus the preload-exposed bridge.
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['renderer/js/*.worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet, AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' } },
  },
  {
    files: ['renderer/js/ticker.worker.js'],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    // Pages served to phones and guests (classic scripts).
    files: ['remote/**/*.js', 'guest/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
