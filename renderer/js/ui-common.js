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

/**
 * In-app confirmation (replaces window.confirm, which freezes the whole window
 * and looks foreign). The confirm button names the action, e.g. "Detener emisión".
 */
export async function confirmAction(message, { ok = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) {
  const dlg = $('#dlg-confirm');
  $('#confirm-message').textContent = message;
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'danger' : 'accent';
  $('#confirm-cancel').textContent = cancel;
  const answer = await ask(dlg);
  return answer === 'ok';
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
 * Menu at viewport coordinates. Entries:
 *  - [label, handler, { hint, icon, badge, danger, disabled }]: an option,
 *  - { header: 'Proyecto' }: a section title,
 *  - { footer: text }: a line at the bottom (e.g. the version),
 *  - null: a separator.
 * Arrow keys, Home/End move between options; Esc closes.
 */
export function showMenu(x, y, items, { className = '' } = {}) {
  openMenu?.remove();
  const close = () => {
    menu.remove();
    if (openMenu === menu) openMenu = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const entry = (item) => {
    if (!item) return h('hr');
    if (item.header) return h('div', { class: 'menu-header', role: 'presentation' }, item.header);
    if (item.footer) return h('div', { class: 'menu-footer', role: 'presentation' }, item.footer);
    const [label, handler, opts = {}] = item;
    return h('button', {
      type: 'button',
      role: 'menuitem',
      class: opts.danger ? 'danger' : '',
      disabled: !!opts.disabled,
      onclick: () => {
        close();
        handler();
      },
    },
    opts.icon ? h('span', { class: 'menu-icon', 'aria-hidden': 'true' }, opts.icon) : null,
    h('span', { class: 'menu-label' }, label),
    opts.badge ? h('span', { class: 'menu-badge' }, opts.badge) : null,
    opts.hint ? h('kbd', {}, opts.hint) : null);
  };
  const menu = h('div', { class: `menu context-menu ${className}`.trim(), role: 'menu' }, items.map(entry));
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  openMenu = menu;
  const outside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const options = () => [...menu.querySelectorAll('button:not(:disabled)')];
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    const list = options();
    const i = list.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (go === undefined || !list.length) return;
    e.preventDefault();
    list[(go + list.length) % list.length].focus();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  options()[0]?.focus();
}
