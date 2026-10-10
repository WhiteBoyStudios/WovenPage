/**
 * The inspector: visual editing of the selected element's styles and
 * attributes.
 *
 * Its distinguishing idea is the "Write to" destination. Every style control
 * edits real source - either the element's inline style or a specific rule in
 * one of the site's stylesheets - and the panel always says which. Values set
 * at the destination are shown as values; everything else shows the browser's
 * computed value as a faint placeholder, so it is clear what is inherited and
 * what is declared.
 *
 * The controls themselves are generated from shared/styleSchema.ts.
 */

import { pageMeta } from '../../shared/compose';
import { attrValue, parseHtml } from '../../shared/html/parse';
import { setAttribute } from '../../shared/html/patch';
import { basename, compiledCssPath, dirname, fileKind, isSassPartial, relative, sassSourcePath } from '../../shared/paths';
import type { SelectionInfo } from '../../shared/protocol';
import { STYLE_SECTIONS, StyleControl, attributesFor } from '../../shared/styleSchema';
import { StyleTarget, targetKey } from '../canvas/StyleWriter';
import { Child, clear, h } from '../core/dom';
import { icon } from '../core/icons';
import { askForm, emptyState, showMenuBelow } from '../core/ui';
import type { Shell } from '../workbench/Shell';
import * as actions from '../workbench/fileActions';

const UNITLESS = new Set(['line-height', 'opacity', 'z-index', 'flex-grow', 'flex-shrink', 'order', 'font-weight']);
const FONT_STACKS = [
  'system-ui, sans-serif',
  '"Segoe UI", Tahoma, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Trebuchet MS", sans-serif',
  '"Courier New", monospace',
  'ui-monospace, Consolas, monospace',
  'ui-serif, Georgia, serif',
  'ui-rounded, system-ui, sans-serif',
];

/** rgb()/rgba() as the browser reports it -> #rrggbb, or null if it has transparency or is not a colour. */
export function toHex(color: string): string | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) return '#' + hex[1].toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color.trim());
  if (short) return ('#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toLowerCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(color.trim());
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith('%') ? 100 : 1)) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

/** Adds or subtracts from the numeric part of a CSS value, keeping its unit. */
export function nudge(value: string, delta: number): string | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(value.trim());
  if (!m) return null;
  const decimals = Math.max((m[1].split('.')[1] ?? '').length, (String(Math.abs(delta)).split('.')[1] ?? '').length);
  return `${(parseFloat(m[1]) + delta).toFixed(decimals)}${m[2]}`;
}

function normalizeLength(prop: string, raw: string): string {
  const value = raw.trim();
  if (/^-?\d*\.?\d+$/.test(value) && value !== '0' && !UNITLESS.has(prop)) return value + 'px';
  return value;
}

interface Bound {
  refresh: (info: SelectionInfo, declared: Record<string, string>) => void;
}

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tab: 'style' | 'element' = 'style';
  private info: SelectionInfo | null = null;
  private bound: Bound[] = [];
  private signature = '';
  private closedSections = new Set(STYLE_SECTIONS.filter((s) => s.collapsed).map((s) => s.id));
  private pendingRule: { href: string; selector: string } | null = null;
  private linked = new Set<string>();

  constructor(private readonly shell: Shell) {
    this.body = h('div.insp__body');
    this.tabs = h('div.insp__tabs', { role: 'tablist' });
    this.el = h('aside.inspector', { 'aria-label': 'Inspector' }, this.tabs, this.body);
    shell.onSelection.on((info) => this.update(info));
    shell.onActive.on(() => this.render());
    shell.onIndex.on(() => this.render());
    shell.styles.onTargetChange.on(() => this.render());
    this.render();
  }

  // ---------------------------------------------------------------- update

  private update(info: SelectionInfo | null): void {
    const previous = this.info;
    this.info = info;
    if (info && this.pendingRule) {
      const pending = this.pendingRule;
      const rule = info.rules.find((r) => r.href === pending.href && r.selector === pending.selector);
      if (rule) {
        this.pendingRule = null;
        this.shell.styles.choose({ type: 'rule', href: rule.href!, ordinal: rule.ordinal, selector: rule.selector, context: rule.context });
        return; // choose() re-renders
      }
    }
    if (!info || !previous || previous.id !== info.id || this.signatureOf(info) !== this.signature) return this.render();
    // Same element, same controls: update values in place so typing is not interrupted.
    const declared = this.shell.styles.declared(info, this.shell.styles.targetFor(info));
    for (const b of this.bound) b.refresh(info, declared);
  }

  /** Changes whenever the set of visible controls would change. */
  private signatureOf(info: SelectionInfo): string {
    const target = this.shell.styles.targetFor(info);
    const visible = STYLE_SECTIONS.flatMap((s) => s.controls.filter((c) => this.isVisible(c, info)).map((c) => c.prop)).join(',');
    const attrs = Object.keys(info.attrs).sort().join(',');
    const rules = info.rules.map((r) => `${r.href}|${r.selector}|${r.ordinal}`).join(';');
    const group = info.group.map((m) => m.id).join(',');
    return [this.tab, info.id, info.structId, group, targetKey(target), visible, attrs, rules, info.sheets.join(',')].join('§');
  }

  private isVisible(control: StyleControl, info: SelectionInfo): boolean {
    if (control.when && !control.when.in.includes(info.computed[control.when.prop])) return false;
    if (control.whenParent && !control.whenParent.includes(info.parentDisplay)) return false;
    return true;
  }

  private async commit(changes: Record<string, string | null>): Promise<void> {
    const info = this.info;
    if (!info) return;
    try {
      const edited = await this.shell.styles.set(info, changes);
      this.shell.canvas.noteEdit(edited);
    } catch (err) {
      this.shell.notify((err as Error).message, 'error');
    }
  }

  private async commitAttr(name: string, value: string | null): Promise<void> {
    if (!this.info) return;
    try {
      await this.shell.canvas.setAttribute(this.info, name, value);
    } catch (err) {
      this.shell.notify((err as Error).message, 'error');
    }
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const info = this.info;
    this.bound = [];
    clear(this.tabs);
    for (const [id, label] of [['style', 'Style'], ['element', 'Element']] as const) {
      this.tabs.append(
        h('button.insp__tab', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(this.tab === id),
          onclick: () => {
            this.tab = id;
            this.render();
          },
        }, label),
      );
    }
    clear(this.body);
    if (!info) {
      this.signature = '';
      this.body.append(this.pageSection(null));
      this.body.append(emptyState(this.shell.viewMode() === 'source' ? 'Switch to Canvas or Split to select elements visually.' : 'Click an element on the canvas to edit its styles and attributes.'));
      return;
    }
    this.signature = this.signatureOf(info);
    this.body.append(this.header(info));
    if (this.tab === 'style') this.renderStyle(info);
    else this.renderElement(info);
  }

  private header(info: SelectionInfo): HTMLElement {
    const address = this.shell.canvas.resolve(info.id);
    const active = this.shell.activePath();
    const shared = address && address.path !== active;
    const label = info.tag + (info.attrs.id ? `#${info.attrs.id}` : '') + info.classes.map((c) => `.${c}`).join('');
    if (info.group.length > 1) {
      return h('div.insp__head', null,
        h('div.insp__element', null, `${info.group.length} elements selected`),
        h('div.insp__origin.insp__origin--plain', null, `Values shown are for ${label}. Inline style changes are written to all ${info.group.length}.`),
      );
    }
    return h('div.insp__head', { class: shared ? 'is-shared' : '' },
      h('div.insp__element', { title: label }, label),
      address
        ? h('button.insp__origin', {
            type: 'button',
            title: 'Open this file',
            onclick: () => void this.shell.openFile(address.path),
          }, shared ? `Lives in ${address.path}. Changes affect every page that uses it.` : `In ${address.path}`)
        : null,
    );
  }

  // ----------------------------------------------------------------- style

  private renderStyle(info: SelectionInfo): void {
    const styles = this.shell.styles;
    const target = styles.targetFor(info);
    const declared = styles.declared(info, target);
    const writable = styles.writableRules(info);

    const select = h<HTMLSelectElement>('select.field', { 'aria-label': 'Where style changes are written' },
      h('option', { value: 'inline' }, 'This element only (inline style)'),
      writable.map((t) => {
        if (t.type !== 'rule') return null;
        const where = t.context.length ? ` @ ${t.context.map((c) => c.replace(/^@media\s*/, '')).join(' ')}` : '';
        return h('option', { value: targetKey(t) }, `${t.selector}${where}  (${basename(t.href)})`);
      }),
      h('option', { value: '__new' }, 'New class rule...'),
    );
    select.value = targetKey(target);
    select.addEventListener('change', () => {
      if (select.value === '__new') {
        select.value = targetKey(target);
        void actions.newClassRule(this.shell, info).then((made) => {
          if (made) this.pendingRule = made;
        }).catch((err) => this.shell.notify(err.message, 'error'));
        return;
      }
      const chosen: StyleTarget = select.value === 'inline' ? { type: 'inline' } : writable.find((t) => targetKey(t) === select.value)!;
      styles.choose(chosen);
    });
    this.body.append(
      h('div.insp__target', null,
        h('label.insp__targetlabel', null, 'Write to'),
        select,
        target.type === 'rule'
          ? h('button.linkbtn', { type: 'button', onclick: () => void this.shell.openFile(target.href, { view: 'source' }) }, `Open ${basename(target.href)}`)
          : null,
      ),
    );

    const compiled = styles.compiledSheets(info);
    if (compiled.length) {
      this.body.append(
        h('p.insp__note.insp__note--boxed', null,
          `Some styles here come from Sass (${compiled.map((c) => basename(sassSourcePath(c))).join(', ')}). Rules in Sass files are edited in Source; `,
          h('button.linkbtn', { type: 'button', onclick: () => void this.shell.openFile(sassSourcePath(compiled[0]), { view: 'source' }) }, 'open the file'),
          '.',
        ),
      );
    }

    for (const section of STYLE_SECTIONS) {
      const controls = section.controls.filter((c) => this.isVisible(c, info));
      if (!controls.length) continue;
      const open = !this.closedSections.has(section.id);
      const setCount = controls.reduce((n, c) => n + (c.kind === 'sides' ? c.props!.filter((p) => declared[p] !== undefined).length : declared[c.prop] !== undefined ? 1 : 0), 0);
      const head = h('button.insp__sectionhead', {
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) this.closedSections.add(section.id);
          else this.closedSections.delete(section.id);
          this.render();
        },
      }, icon(open ? 'chevronDown' : 'chevron', 12), h('span', null, section.title), setCount ? h('span.insp__count', { title: `${setCount} set here` }, String(setCount)) : null);
      const grid = h('div.insp__grid');
      if (open) for (const control of controls) grid.append(this.control(control, info, declared));
      this.body.append(h('section.insp__section', null, head, open ? grid : null));
    }
  }

  private control(control: StyleControl, info: SelectionInfo, declared: Record<string, string>): HTMLElement {
    const row = h('div.ctl', { class: control.wide ? 'ctl--wide' : '' });
    const label = h('label.ctl__label', null, control.label);
    let field: Child;

    switch (control.kind) {
      case 'sides':
        field = this.sides(control, info, declared, row);
        break;
      case 'select':
        field = this.select(control, info, declared, row);
        break;
      case 'segment':
        field = this.segment(control, info, declared, row);
        break;
      case 'color':
        field = this.color(control, info, declared, row);
        break;
      default:
        field = this.textual(control.prop, control, info, declared, row);
    }
    row.append(label, h('div.ctl__field', null, field));
    return row;
  }

  /** A text-like input for one property. Enter or blur commits; arrows nudge numbers. */
  private textual(prop: string, control: StyleControl, info: SelectionInfo, declared: Record<string, string>, row: HTMLElement | null, compact = false): HTMLElement {
    const listId = control.kind === 'font' ? 'insp-fonts' : undefined;
    const input = h<HTMLInputElement>('input.field', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': compact ? prop : control.label, list: listId, class: compact ? 'field--compact' : '' });
    let committed = '';
    const refresh = (i: SelectionInfo, d: Record<string, string>) => {
      const value = d[prop];
      committed = value ?? '';
      if (document.activeElement !== input) input.value = committed;
      input.placeholder = (i.computed[prop] ?? control.placeholder ?? '').slice(0, 40) || control.placeholder || '';
      input.title = value === undefined ? `Computed: ${i.computed[prop] ?? ''}` : `${prop}: ${value}`;
      input.classList.toggle('is-set', value !== undefined);
      if (row && !compact) row.classList.toggle('is-set', value !== undefined);
    };
    const apply = () => {
      let value = input.value.trim();
      if (control.kind === 'length' || control.kind === 'sides') value = normalizeLength(prop, value);
      if (value === committed) return;
      input.value = value;
      committed = value;
      void this.commit({ [prop]: value === '' ? null : value });
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        apply();
        input.select();
      } else if (e.key === 'Escape') {
        input.value = committed;
        input.blur();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && control.kind !== 'text' && control.kind !== 'font') {
        const base = input.value.trim() || (this.info?.computed[prop] ?? '');
        const step = (control.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        const next = nudge(base, step);
        if (next !== null) {
          e.preventDefault();
          input.value = next;
          apply();
        }
      }
    });
    refresh(info, declared);
    this.bound.push({ refresh });
    if (control.kind === 'font') {
      const families = [...(this.shell.index()?.fontFamilies ?? []).map((f) => (/\s/.test(f) ? `"${f}"` : f) + ', sans-serif'), ...FONT_STACKS];
      return h('div.ctl__stack', null, input, h('datalist', { id: 'insp-fonts' }, families.map((f) => h('option', { value: f }))));
    }
    return input;
  }

  private select(control: StyleControl, info: SelectionInfo, declared: Record<string, string>, row: HTMLElement): HTMLElement {
    const el = h<HTMLSelectElement>('select.field', { 'aria-label': control.label });
    const refresh = (i: SelectionInfo, d: Record<string, string>) => {
      const value = d[control.prop];
      const computed = i.computed[control.prop] ?? '';
      const options = [...(control.options ?? [])];
      if (value !== undefined && !options.includes(value)) options.unshift(value);
      clear(el);
      el.append(h('option', { value: '' }, computed ? `(${computed})` : '(not set)'), ...options.map((o) => h('option', { value: o }, o)));
      el.value = value ?? '';
      row.classList.toggle('is-set', value !== undefined);
    };
    el.addEventListener('change', () => void this.commit({ [control.prop]: el.value || null }));
    refresh(info, declared);
    this.bound.push({ refresh });
    return el;
  }

  private segment(control: StyleControl, info: SelectionInfo, declared: Record<string, string>, row: HTMLElement): HTMLElement {
    const group = h('div.segment', { role: 'group', 'aria-label': control.label });
    const buttons = (control.options ?? []).map((option) => {
      const button = h('button.segment__btn', { type: 'button', title: option }, option.replace('-reverse', ' ↩').replace('nowrap', 'no wrap'));
      button.addEventListener('click', () => {
        const isSet = this.info && this.shell.styles.declared(this.info, this.shell.styles.targetFor(this.info))[control.prop] === option;
        void this.commit({ [control.prop]: isSet ? null : option });
      });
      group.append(button);
      return { option, button };
    });
    const refresh = (i: SelectionInfo, d: Record<string, string>) => {
      const value = d[control.prop];
      const computed = i.computed[control.prop];
      const aliases: Record<string, string> = { left: 'start', right: 'end' };
      for (const { option, button } of buttons) {
        button.classList.toggle('is-on', value === option);
        button.classList.toggle('is-computed', value === undefined && (computed === option || aliases[computed] === option));
        button.setAttribute('aria-pressed', String(value === option));
      }
      row.classList.toggle('is-set', value !== undefined);
    };
    refresh(info, declared);
    this.bound.push({ refresh });
    return group;
  }

  private color(control: StyleControl, info: SelectionInfo, declared: Record<string, string>, row: HTMLElement): HTMLElement {
    const swatch = h<HTMLInputElement>('input.swatch', { type: 'color', 'aria-label': `${control.label} picker` });
    const text = this.textual(control.prop, { ...control, kind: 'text' }, info, declared, row) as HTMLInputElement;
    const refresh = (i: SelectionInfo, d: Record<string, string>) => {
      const hex = toHex(d[control.prop] ?? '') ?? toHex(i.computed[control.prop] ?? '');
      swatch.value = hex ?? '#000000';
      swatch.classList.toggle('is-unknown', hex === null);
    };
    // "input" fires continuously while dragging in the picker: preview live, write once on "change".
    swatch.addEventListener('input', () => {
      if (this.info) this.shell.canvas.previewStyle(this.info.id, { [control.prop]: swatch.value });
    });
    swatch.addEventListener('change', () => {
      const info2 = this.info;
      if (!info2) return;
      // Clear the live preview before writing, so a rule destination is not masked by a leftover inline value.
      if (this.shell.styles.targetFor(info2).type === 'rule') this.shell.canvas.previewStyle(info2.id, { [control.prop]: info2.inline[control.prop] ?? null });
      void this.commit({ [control.prop]: swatch.value });
    });
    refresh(info, declared);
    this.bound.push({ refresh });
    return h('div.ctl__color', null, swatch, text);
  }

  private sides(control: StyleControl, info: SelectionInfo, declared: Record<string, string>, row: HTMLElement): HTMLElement {
    const props = control.props!;
    const inputs = props.map((prop) => this.textual(prop, control, info, declared, null, true) as HTMLInputElement);
    const link = h('button.sides__link', { type: 'button', title: 'Set all four sides together', 'aria-pressed': String(this.linked.has(control.prop)) }, icon(this.linked.has(control.prop) ? 'link' : 'unlink', 14));
    link.addEventListener('click', () => {
      if (this.linked.has(control.prop)) this.linked.delete(control.prop);
      else this.linked.add(control.prop);
      this.render();
    });
    // When linked, typing in any side writes the same value to all four.
    inputs.forEach((input) => {
      input.addEventListener('change', () => {
        if (!this.linked.has(control.prop)) return;
        const value = normalizeLength(props[0], input.value);
        void this.commit(Object.fromEntries(props.map((p) => [p, value === '' ? null : value])));
      });
    });
    this.bound.push({
      refresh: (_i, d) => row.classList.toggle('is-set', props.some((p) => d[p] !== undefined)),
    });
    row.classList.toggle('is-set', props.some((p) => declared[p] !== undefined));
    const [top, right, bottom, left] = inputs;
    return h('div.sides', null,
      h('div.sides__row', null, top),
      h('div.sides__row', null, left, link, right),
      h('div.sides__row', null, bottom),
    );
  }

  // --------------------------------------------------------------- element

  private renderElement(info: SelectionInfo): void {
    if (info.group.length > 1) {
      const ids = info.group.map((m) => m.structId);
      this.body.append(
        h('section.insp__section', null,
          h('div.insp__sectionhead.insp__sectionhead--static', null, h('span', null, 'Selection')),
          h('div.insp__members', null, info.group.map((m) => h('button.insp__sheet', { type: 'button', title: 'Select only this element', onclick: () => this.shell.canvas.selectId(m.id) }, m.label))),
          h('div.insp__actions', null,
            h('button.btn', { type: 'button', title: 'Wrap the selected elements in a new container (Ctrl+G)', onclick: () => void this.shell.canvas.run({ kind: 'group', ids }) }, 'Group in a box'),
            h('button.btn', { type: 'button', onclick: () => void this.shell.canvas.run({ kind: 'duplicateMany', ids }) }, 'Duplicate'),
            h('button.btn.btn--danger', { type: 'button', onclick: () => void this.shell.canvas.run({ kind: 'removeMany', ids }) }, 'Delete'),
          ),
          h('p.insp__note', null, 'Attributes are edited one element at a time. Click a name above to select just that element.'),
        ),
      );
      this.body.append(this.pageSection(info));
      return;
    }
    const address = this.shell.canvas.resolve(info.id);
    const fromDir = address ? dirname(address.path) : '';
    const files = this.shell.index()?.files ?? [];

    const instance = this.instanceSection(info);
    if (instance) this.body.append(instance);

    const grid = h('div.insp__grid');
    const known = attributesFor(info.tag);
    const shown = new Set(known.map((a) => a.name));
    for (const attr of known) {
      const row = h('div.ctl.ctl--wide');
      const current = info.attrs[attr.name];
      let field: HTMLElement;
      if (attr.kind === 'bool') {
        const box = h<HTMLInputElement>('input', { type: 'checkbox', checked: current !== undefined, 'aria-label': attr.label });
        box.addEventListener('change', () => void this.commitAttr(attr.name, box.checked ? '' : null));
        field = box;
      } else if (attr.kind === 'select') {
        const sel = h<HTMLSelectElement>('select.field', { 'aria-label': attr.label }, (attr.options ?? []).map((o) => h('option', { value: o }, o || '(default)')));
        sel.value = current ?? '';
        sel.addEventListener('change', () => void this.commitAttr(attr.name, sel.value || null));
        field = sel;
      } else {
        const listId = attr.kind === 'path' ? `insp-paths-${attr.name}` : undefined;
        const input = h<HTMLInputElement>('input.field', { type: 'text', value: current ?? '', spellcheck: 'false', autocomplete: 'off', 'aria-label': attr.label, list: listId });
        input.addEventListener('change', () => void this.commitAttr(attr.name, input.value.trim() === '' && attr.name !== 'alt' ? null : input.value.trim()));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
        });
        field = input;
        if (attr.kind === 'path') {
          const wanted = info.tag === 'img' || attr.name === 'poster' ? ['image'] : info.tag === 'video' ? ['video'] : info.tag === 'audio' ? ['audio'] : info.tag === 'script' ? ['js'] : info.tag === 'link' ? ['css', 'image'] : ['html', 'image', 'other'];
          const options = files.filter((f) => wanted.includes(fileKind(f))).map((f) => encodeURI(relative(fromDir, f)));
          field = h('div.ctl__stack', null, input, h('datalist', { id: listId }, options.map((o) => h('option', { value: o }))));
        }
      }
      row.classList.toggle('is-set', current !== undefined);
      row.append(h('label.ctl__label', null, attr.label), h('div.ctl__field', null, field));
      grid.append(row);
    }
    // Anything else on the element (data-*, aria-*, ...) stays editable too.
    for (const [name, value] of Object.entries(info.attrs)) {
      if (shown.has(name) || name === 'style') continue;
      const input = h<HTMLInputElement>('input.field', { type: 'text', value, spellcheck: 'false', 'aria-label': name });
      input.addEventListener('change', () => void this.commitAttr(name, input.value));
      grid.append(
        h('div.ctl.ctl--wide.is-set', null,
          h('label.ctl__label.ctl__label--code', null, name),
          h('div.ctl__field.ctl__field--row', null, input, h('button.iconbtn', { type: 'button', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: () => void this.commitAttr(name, null) }, icon('close', 12))),
        ),
      );
    }
    this.body.append(
      h('section.insp__section', null,
        h('div.insp__sectionhead.insp__sectionhead--static', null, h('span', null, 'Attributes')),
        grid,
        h('div.insp__actions', null,
          h('button.btn', {
            type: 'button',
            onclick: async () => {
              const values = await askForm({
                title: 'Add attribute',
                fields: [
                  { name: 'name', label: 'Name', type: 'text', placeholder: 'aria-label', required: true },
                  { name: 'value', label: 'Value', type: 'text' },
                ],
                submit: 'Add attribute',
                validate: (v) => (/^[a-zA-Z_:][\w:.-]*$/.test(v.name) ? null : 'That is not a valid attribute name.'),
              });
              if (values) await this.commitAttr(values.name.toLowerCase(), values.value);
            },
          }, 'Add attribute'),
          h('button.btn', {
            type: 'button',
            onclick: (e: MouseEvent) =>
              showMenuBelow(e.currentTarget as Element, [
                { label: 'Duplicate', hint: 'Ctrl+D', run: () => void this.shell.canvas.run({ kind: 'duplicate', id: info.structId }) },
                { label: 'Wrap in a box', hint: 'Ctrl+G', run: () => void this.shell.canvas.run({ kind: 'group', ids: [info.structId] }) },
                { label: 'Save as part...', run: () => void actions.saveSelectionAsPart(this.shell, info).catch((err) => this.shell.notify(err.message, 'error')) },
                { label: 'Show in source', run: () => void this.shell.commands.run('canvas.revealSource') },
                { separator: true },
                { label: 'Delete', hint: 'Del', danger: true, run: () => void this.shell.canvas.run({ kind: 'remove', id: info.structId }) },
              ]),
          }, 'Element actions'),
        ),
      ),
    );
    this.body.append(this.pageSection(info));
  }

  /** When the selection is the root of a part, its parameters are edited on the instance. */
  private instanceSection(info: SelectionInfo): HTMLElement | null {
    if (info.structId === info.id) return null;
    const address = this.shell.canvas.resolve(info.structId);
    const text = address ? this.shell.docs.text(address.path) : null;
    if (!address || text === null) return null;
    const el = parseHtml(text).elements[address.index];
    if (!el || el.name !== 'w-part') return null;
    const src = attrValue(el, 'src') ?? '';
    const part = this.shell.index()?.parts.find((p) => p.path === src);
    const grid = h('div.insp__grid');
    for (const param of part?.params ?? []) {
      const input = h<HTMLInputElement>('input.field', { type: 'text', value: attrValue(el, param) ?? '', spellcheck: 'false', 'aria-label': param });
      input.addEventListener('change', async () => {
        const doc = await this.shell.docs.open(address.path);
        const parsed = parseHtml(doc.model.getValue());
        this.shell.docs.applyEdits(address.path, setAttribute(parsed, address.index, param, input.value === '' ? null : input.value).edits, 'canvas-struct');
        this.shell.canvas.noteEdit([address.path]);
      });
      grid.append(h('div.ctl.ctl--wide', null, h('label.ctl__label.ctl__label--code', null, param), h('div.ctl__field', null, input)));
    }
    return h('section.insp__section.insp__section--instance', null,
      h('div.insp__sectionhead.insp__sectionhead--static', null, icon('part', 14), h('span', null, `Instance of ${basename(src)}`)),
      h('p.insp__note', null, part?.params.length ? 'These values apply to this use of the part only.' : 'This part has no parameters.'),
      part?.params.length ? grid : null,
      h('div.insp__actions', null, h('button.btn', { type: 'button', onclick: () => void this.shell.openFile(src) }, 'Edit the part')),
    );
  }

  /** Page-level settings: which layout the page uses and which stylesheets it links. */
  private pageSection(info: SelectionInfo | null): HTMLElement {
    const active = this.shell.activePath();
    const index = this.shell.index();
    const section = h('section.insp__section');
    if (!active || fileKind(active) !== 'html' || !index) return section;
    const isPage = index.pages.includes(active);
    section.append(h('div.insp__sectionhead.insp__sectionhead--static', null, h('span', null, isPage ? 'Page' : 'File')));
    const grid = h('div.insp__grid');

    if (isPage) {
      const meta = pageMeta(this.shell.docs.text(active) ?? '');
      const sel = h<HTMLSelectElement>('select.field', { 'aria-label': 'Layout' },
        h('option', { value: '' }, meta ? '(choose)' : 'None - standalone page'),
        index.layouts.map((l) => h('option', { value: l.path }, l.name)),
      );
      sel.value = meta?.layout ?? '';
      sel.addEventListener('change', () => {
        if (sel.value) void actions.applyLayout(this.shell, active, sel.value).catch((err) => this.shell.notify(err.message, 'error'));
      });
      grid.append(h('div.ctl.ctl--wide', null, h('label.ctl__label', null, 'Layout'), h('div.ctl__field', null, sel)));
    }

    const linked = info?.sheets ?? [];
    if (info) {
      const list = h('div.insp__sheets');
      for (const sheet of linked) {
        const source = index.files.includes(sheet) ? sheet : sassSourcePath(sheet);
        list.append(h('button.insp__sheet', { type: 'button', title: `Open ${source}`, onclick: () => void this.shell.openFile(source, { view: 'source' }) }, source));
      }
      if (!linked.length) list.append(h('span.insp__note', null, 'No stylesheet linked.'));
      grid.append(h('div.ctl.ctl--wide', null, h('label.ctl__label', null, 'Stylesheets'), h('div.ctl__field', null, list)));
    }
    section.append(grid);

    const unlinked = index.stylesheets.filter((s) => !isSassPartial(s) && !linked.includes(compiledCssPath(s)));
    section.append(
      h('div.insp__actions', null,
        h('button.btn', {
          type: 'button',
          onclick: (e: MouseEvent) =>
            showMenuBelow(e.currentTarget as Element, [
              ...unlinked.map((s) => ({ label: s, run: () => void actions.attachStylesheet(this.shell, active, s).catch((err) => this.shell.notify(err.message, 'error')) })),
              ...(unlinked.length ? [{ separator: true }] : []),
              { label: 'New stylesheet...', run: () => void actions.newStylesheet(this.shell).catch((err) => this.shell.notify(err.message, 'error')) },
            ]),
        }, 'Link a stylesheet'),
      ),
    );
    return section;
  }
}
