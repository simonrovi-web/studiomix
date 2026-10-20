'use strict';

// Main-process log: userData/logs/main.log (renderer errors are forwarded here
// too). Rotated at 1 MB, keeping one previous file, so it never grows unbounded.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
let file = null;

/** Starts writing to `<dir>/main.log`; before this, entries only go to the console. */
function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
  } catch (err) {
    file = null;
    console.warn('No se pudo abrir el registro:', err.message);
  }
}

function describe(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function format(level, scope, parts, now = new Date()) {
  return `${now.toISOString()} ${level.toUpperCase()} [${scope}] ${parts.map(describe).join(' ')}`;
}

function write(level, scope, parts) {
  const line = format(level, scope, parts);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Disk full or file locked: the console copy above is all we can do.
  }
}

/** Logger bound to a scope, e.g. `const log = require('./log').scope('outputs')`. */
function scope(name) {
  return {
    info: (...parts) => write('info', name, parts),
    warn: (...parts) => write('warn', name, parts),
    error: (...parts) => write('error', name, parts),
  };
}

module.exports = { init, scope, format, file: () => file };
