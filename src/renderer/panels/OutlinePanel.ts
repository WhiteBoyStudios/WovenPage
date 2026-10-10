/**
 * Outline: the element tree of the active HTML file, read from its source.
 * Clicking a row selects that element on the canvas and marks it in the
 * source view, which makes it the easiest way to reach elements that are
 * small, hidden or stacked under others.
 */

import { ElementNode, elementLabel, parseHtml } from '../../shared/html/parse';
import { fileKind } from '../../shared/paths';
import { clear, debounce, h } from '../core/dom';
import { emptyState } from '../core/ui';
import type { Shell } from '../workbench/Shell';

const MAX_ROWS = 1500;
const SKIP = new Set(['script', 'style', 'meta', 'link', 'title', 'base', 'head']);

export class OutlinePanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private showHead = false;

  constructor(private readonly shell: Shell) {
    this.body = h('div.outline', { role: 'tree', 'aria-label': 'Element outline' });
    this.el = h('section.panel', null, h('header.panel__head', null, h('h2', null, 'Outline')), this.body);
    const render = debounce(() => this.render(), 200);
    shell.onActive.on(() => this.render());
    shell.onSelection.on(() => this.render());
    shell.docs.onChange.on(({ path }) => {
      if (path === shell.activePath()) render();
    });
  }

  private render(): void {
    clear(this.body);
    const path = this.shell.activePath();
    const text = path ? this.shell.docs.text(path) : null;
    if (!path || text === null || fileKind(path) !== 'html') {
      this.body.append(emptyState('Open a page to see its elements.'));
      return;
    }
    const doc = parseHtml(text);
    const selection = this.shell.selection();
    const selected = selection ? this.shell.canvas.resolve(selection.id) : null;
    const selectedIndex = selected?.path === path ? selected.index : -1;
    let rows = 0;
    const walk = (nodes: ElementNode[], depth: number) => {
      for (const el of nodes) {
        if (rows >= MAX_ROWS) return;
        if (!this.showHead && SKIP.has(el.name)) continue;
        rows++;
        const label = elementLabel(el);
        const row = h('button.outline__row', {
          type: 'button',
          role: 'treeitem',
          class: [el.index === selectedIndex ? 'is-active' : '', el.name.startsWith('w-') ? 'is-composition' : ''].join(' '),
          style: { paddingLeft: `${10 + depth * 12}px` },
          onclick: () => {
            this.shell.canvas.select({ path, index: el.index });
            if (this.shell.viewMode() !== 'canvas') this.shell.editor.markRange(el.start, el.end, true);
          },
        }, h('span.outline__tag', null, el.name), label.length > el.name.length ? h('span.outline__hint', null, label.slice(el.name.length)) : null);
        this.body.append(row);
        walk(el.children, depth + 1);
      }
    };
    walk(doc.roots, 0);
    if (!rows) this.body.append(emptyState('This file has no elements yet.'));
    if (rows >= MAX_ROWS) this.body.append(h('p.add__note', null, `Showing the first ${MAX_ROWS} elements.`));
    this.body.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }
}
