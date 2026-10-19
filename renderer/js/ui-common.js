import { $, h } from './util.js';

/**
 * Shows a toast. `action` ({ label, onClick }) adds a button and keeps the toast
 * up longer, since it asks the user to do something. `options.timeout` overrides
 * how long it stays; `options.onExpire` runs if it times out without the action.
 */
export function toast(message, kind = 'info', action = null, options = {}) {
  const node = h('div', { class: `toast ${kind}` }, message);
  let settled = false;
  const finish = (acted) => {
    if (settled) return;
    settled = true;
    node.remove();
    if (acted) action.onClick();
    else options.onExpire?.();
  };
  if (action) {
    node.append(
      h('div', { class: 'toast-actions' },
        h('button', { type: 'button', class: 'accent', onclick: () => finish(true) }, action.label),
        h('button', { type: 'button', onclick: () => finish(false) }, action.dismissLabel ?? 'Ahora no'),
      ),
    );
  }
  $('#toasts').append(node);
  const timeout = options.timeout ?? (action ? 20000 : kind === 'error' ? 9000 : 5000);
  setTimeout(() => finish(false), timeout);
}

/**
 * Opens a <dialog> and resolves with its returnValue when closed. Dialogs that
 * live in the side column open there (non-modal) instead of over the monitors.
 */
export function ask(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    if (isPanel(dialog)) openPanel(dialog);
    else dialog.showModal();
  });
}

const isPanel = (dialog) => dialog.parentElement?.id === 'side';

/** Shows a side-column panel, closing whichever panel was open before. */
export function openPanel(dialog) {
  for (const other of document.querySelectorAll('#side > dialog[open]')) {
    if (other !== dialog) other.close('replaced');
  }
  if (!dialog.open) dialog.show();
  document.body.classList.add('side-open');
}

export function closePanels() {
  for (const panel of document.querySelectorAll('#side > dialog[open]')) panel.close();
}

export function panelOpen() {
  return !!document.querySelector('#side > dialog[open]');
}

export function initPanels() {
  for (const panel of document.querySelectorAll('#side > dialog')) {
    panel.addEventListener('close', () => {
      // Let a replacing panel open first, then collapse the column if none is left.
      queueMicrotask(() => document.body.classList.toggle('side-open', panelOpen()));
    });
  }
}

export function fillSelect(select, options, selected) {
  select.replaceChildren(...options.map(([value, label]) => h('option', { value, selected: value === selected }, label)));
}

export function isTyping(target) {
  return !!target?.closest?.('input, select, textarea');
}

let openMenu = null;

/**
 * Context menu at viewport coordinates. Items: [label, handler, { danger, hint }]
 * or null for a separator.
 */
export function showMenu(x, y, items) {
  openMenu?.remove();
  const menu = h(
    'div',
    { class: 'menu context-menu', role: 'menu' },
    items.map((item) => {
      if (!item) return h('hr');
      const [label, handler, opts = {}] = item;
      return h('button', {
        type: 'button',
        role: 'menuitem',
        class: opts.danger ? 'danger' : '',
        onclick: () => {
          close();
          handler();
        },
      }, h('span', {}, label), opts.hint ? h('kbd', {}, opts.hint) : null);
    }),
  );
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  openMenu = menu;
  const close = () => {
    menu.remove();
    if (openMenu === menu) openMenu = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  menu.querySelector('button')?.focus();
}
