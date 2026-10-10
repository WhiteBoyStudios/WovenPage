/**
 * Shared interface pieces: toasts, popup menus, modal forms, confirmation and
 * the quick-pick list used by "Go to file" and the command palette.
 */

import { Child, clear, h } from './dom';
import { icon } from './icons';

// --------------------------------------------------------------------- toasts

let toastHost: HTMLElement | null = null;

export interface ToastOptions {
  kind?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  /** Milliseconds before the toast leaves; 0 keeps it until dismissed. */
  timeout?: number;
}

export function toast(message: string, options: ToastOptions = {}): void {
  if (!message) return;
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const kind = options.kind ?? 'info';
  const el = h('div.toast', { class: `toast--${kind}` }, h('span.toast__text', null, message));
  const dismiss = () => el.remove();
  if (options.action) {
    el.append(
      h('button.toast__action', {
        type: 'button',
        onclick: () => {
          options.action!.run();
          dismiss();
        },
      }, options.action.label),
    );
  }
  el.append(h('button.toast__close', { type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, icon('close', 12)));
  toastHost.append(el);
  const timeout = options.timeout ?? (kind === 'error' ? 9000 : options.action ? 8000 : 4000);
  if (timeout > 0) setTimeout(dismiss, timeout);
}

// ---------------------------------------------------------------- popup menus

export interface MenuItem {
  label?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  run?: () => void;
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = h('div.menu', { role: 'menu', tabIndex: -1 });
  for (const item of items) {
    if (item.separator) {
      menu.append(h('div.menu__sep'));
      continue;
    }
    menu.append(
      h('button.menu__item', {
        type: 'button',
        role: 'menuitem',
        class: item.danger ? 'is-danger' : '',
        disabled: !!item.disabled,
        onclick: () => {
          closeMenu();
          item.run?.();
        },
      }, h('span.menu__check', null, item.checked ? icon('check', 12) : null), h('span.menu__label', null, item.label ?? ''), item.hint ? h('span.menu__hint', null, item.hint) : null),
    );
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  openMenu = menu;
  const first = menu.querySelector<HTMLElement>('.menu__item:not(:disabled)');
  first?.focus();
  menu.addEventListener('keydown', (e) => {
    const all = [...menu.querySelectorAll<HTMLElement>('.menu__item:not(:disabled)')];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') all[(at + 1) % all.length]?.focus();
    else if (e.key === 'ArrowUp') all[(at - 1 + all.length) % all.length]?.focus();
    else if (e.key === 'Escape') closeMenu();
    else return;
    e.preventDefault();
  });
}

/** Shows a menu anchored under an element (for toolbar dropdowns). */
export function showMenuBelow(anchor: Element, items: MenuItem[]): void {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
}

window.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

// --------------------------------------------------------------------- modals

export interface Modal {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}

export function openModal(title: string, options: { wide?: boolean; onClose?: () => void } = {}): Modal {
  const previous = document.activeElement as HTMLElement | null;
  const body = h('div.modal__body');
  const footer = h('div.modal__footer');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    options.onClose?.();
    previous?.focus?.();
  };
  const dialog = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, class: options.wide ? 'modal--wide' : '' },
    h('div.modal__head', null, h('h2', null, title), h('button.iconbtn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('close'))),
    body,
    footer,
  );
  const backdrop = h('div.backdrop', {
    onpointerdown: (e: PointerEvent) => {
      if (e.target === backdrop) close();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    },
  }, dialog);
  document.body.append(backdrop);
  return { root: dialog, body, footer, close };
}

export type FieldSpec =
  | { name: string; label: string; type: 'text' | 'password' | 'number'; value?: string; placeholder?: string; hint?: string; required?: boolean }
  | { name: string; label: string; type: 'select'; value?: string; options: { value: string; label: string }[]; hint?: string }
  | { name: string; label: string; type: 'checkbox'; value?: boolean; hint?: string };

export interface FormOptions {
  title: string;
  intro?: string;
  fields: FieldSpec[];
  submit: string;
  /** Return an error message to keep the dialog open. */
  validate?: (values: Record<string, string>) => string | null | Promise<string | null>;
}

/** A small modal form. Resolves with the values, or null if cancelled. */
export function askForm(options: FormOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
      modal.close();
    };
    const modal = openModal(options.title, { onClose: () => finish(null) });
    const error = h('p.form__error', { role: 'alert' });
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const form = h<HTMLFormElement>('form.form', {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const values: Record<string, string> = {};
        for (const [name, input] of inputs) {
          values[name] = input instanceof HTMLInputElement && input.type === 'checkbox' ? (input.checked ? 'true' : '') : input.value.trim();
        }
        const missing = options.fields.find((f) => f.type !== 'checkbox' && f.type !== 'select' && f.required && !values[f.name]);
        const problem = missing ? `${missing.label} is needed.` : ((await options.validate?.(values)) ?? null);
        if (problem) {
          error.textContent = problem;
          return;
        }
        finish(values);
      },
    });
    if (options.intro) form.append(h('p.form__intro', null, options.intro));
    for (const field of options.fields) {
      const id = `f-${field.name}`;
      let input: HTMLInputElement | HTMLSelectElement;
      if (field.type === 'select') {
        input = h<HTMLSelectElement>('select', { id }, field.options.map((o) => h('option', { value: o.value }, o.label)));
        input.value = field.value ?? field.options[0]?.value ?? '';
      } else if (field.type === 'checkbox') {
        input = h<HTMLInputElement>('input', { id, type: 'checkbox', checked: !!field.value });
      } else {
        input = h<HTMLInputElement>('input', { id, type: field.type, value: field.value ?? '', placeholder: field.placeholder ?? '', autocomplete: 'off', spellcheck: 'false' });
      }
      inputs.set(field.name, input);
      const row = field.type === 'checkbox'
        ? h('label.form__check', { for: id }, input, h('span', null, field.label))
        : h('div.form__row', null, h('label', { for: id }, field.label), input);
      form.append(row);
      if (field.hint) form.append(h('p.form__hint', null, field.hint));
    }
    form.append(error);
    modal.body.append(form);
    modal.footer.append(
      h('button.btn', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
      h('button.btn.btn--primary', { type: 'button', onclick: () => form.requestSubmit() }, options.submit),
    );
    const first = [...inputs.values()][0];
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === 'text') first.select();
  });
}

export function confirmAction(title: string, message: string, confirmLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const modal = openModal(title, { onClose: () => resolve(answer) });
    modal.body.append(h('p.modal__text', null, message));
    const ok = h('button.btn', { type: 'button', class: danger ? 'btn--danger' : 'btn--primary', onclick: () => ((answer = true), modal.close()) }, confirmLabel);
    modal.footer.append(h('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'), ok);
    ok.focus();
  });
}

// ----------------------------------------------------------------- quick pick

export interface PickItem<T> {
  label: string;
  detail?: string;
  hint?: string;
  value: T;
}

/** Scores how well `query` matches `text` as a subsequence; -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || /[\s/._-]/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

export function quickPick<T>(placeholder: string, items: PickItem<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null;
    let active = 0;
    let shown: PickItem<T>[] = [];
    const list = h('div.pick__list', { role: 'listbox' });
    const input = h<HTMLInputElement>('input.pick__input', { type: 'text', placeholder, spellcheck: 'false', 'aria-label': placeholder });
    const close = () => {
      backdrop.remove();
      resolve(result);
    };
    const render = () => {
      const q = input.value.trim();
      shown = items
        .map((item) => ({ item, score: fuzzyScore(q, item.label + ' ' + (item.detail ?? '')) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map((x) => x.item);
      active = Math.min(active, Math.max(0, shown.length - 1));
      clear(list);
      if (!shown.length) list.append(h('div.pick__empty', null, 'Nothing matches.'));
      shown.forEach((item, i) => {
        const row = h('div.pick__item', {
          role: 'option',
          class: i === active ? 'is-active' : '',
          onpointerdown: (e: Event) => {
            e.preventDefault();
            result = item.value;
            close();
          },
        }, h('span.pick__label', null, item.label), item.detail ? h('span.pick__detail', null, item.detail) : null, item.hint ? h('kbd.pick__hint', null, item.hint) : null);
        list.append(row);
      });
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'Enter') {
        result = shown[active]?.value ?? null;
        return close();
      } else if (e.key === 'Escape') return close();
      else return;
      e.preventDefault();
      render();
    });
    const backdrop = h('div.backdrop.backdrop--top', {
      onpointerdown: (e: Event) => {
        if (e.target === backdrop) close();
      },
    }, h('div.pick', null, input, list));
    document.body.append(backdrop);
    render();
    input.focus();
  });
}

/** A labelled empty state with an optional action. */
export function emptyState(message: string, ...actions: Child[]): HTMLElement {
  return h('div.empty', null, h('p', null, message), actions.length ? h('div.empty__actions', null, actions) : null);
}
