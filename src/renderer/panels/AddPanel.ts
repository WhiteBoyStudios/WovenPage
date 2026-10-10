/**
 * Add panel: the element library, the site's own parts, and its layouts.
 * Anything here can be dragged onto the canvas, or clicked to insert next to
 * the current selection (or at the caret in Source view).
 */

import { fileKind } from '../../shared/paths';
import { pageMeta } from '../../shared/compose';
import type { InsertPayload } from '../../shared/protocol';
import { clear, h } from '../core/dom';
import { icon } from '../core/icons';
import { showMenu } from '../core/ui';
import type { Shell } from '../workbench/Shell';
import * as actions from '../workbench/fileActions';
import { PALETTE } from './palette';

export const PALETTE_DRAG_TYPE = 'application/x-wovenpage';

export class AddPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private filter = '';

  constructor(private readonly shell: Shell) {
    this.body = h('div.add');
    const search = h<HTMLInputElement>('input.field', { type: 'search', placeholder: 'Filter elements and parts', 'aria-label': 'Filter elements and parts', spellcheck: 'false' });
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.render();
    });
    this.el = h('section.panel', null, h('header.panel__head', null, h('h2', null, 'Add')), h('div.panel__bar', null, search), this.body);
    shell.onIndex.on(() => this.render());
    shell.onActive.on(() => this.render());
    this.render();
  }

  private draggable(el: HTMLElement, payload: InsertPayload): HTMLElement {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData(PALETTE_DRAG_TYPE, '1');
      e.dataTransfer!.setData('text/plain', payload.type === 'html' ? payload.html : payload.path);
      e.dataTransfer!.effectAllowed = 'copy';
      this.shell.setDragPayload(payload);
    });
    el.addEventListener('dragend', () => this.shell.setDragPayload(null));
    el.addEventListener('click', () => void this.shell.insert(payload).catch((err) => this.shell.notify(String(err.message ?? err), 'error')));
    return el;
  }

  private render(): void {
    clear(this.body);
    const match = (text: string) => !this.filter || text.toLowerCase().includes(this.filter);
    const index = this.shell.index();

    // Parts first: a site's own components matter more than generic elements.
    const parts = (index?.parts ?? []).filter((p) => match(p.name + ' ' + p.path));
    const partsSection = h('div.add__group', null,
      h('div.add__title', null,
        h('h3', null, 'Parts'),
        h('button.linkbtn', { type: 'button', onclick: () => void actions.newPart(this.shell).catch((e) => this.shell.notify(e.message, 'error')) }, 'New part'),
      ),
    );
    if (parts.length) {
      for (const part of parts) {
        const row = this.draggable(
          h('div.add__part', { title: `${part.path}\nDrag onto the canvas, or click to insert.` },
            icon('part'),
            h('span.add__partname', null, part.name),
            part.params.length ? h('span.add__params', null, part.params.join(', ')) : null,
          ),
          { type: 'part', path: part.path },
        );
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: 'Insert', run: () => void this.shell.insert({ type: 'part', path: part.path }) },
            { label: 'Edit part', run: () => void this.shell.openFile(part.path) },
          ]);
        });
        partsSection.append(row);
      }
    } else if (!this.filter) {
      partsSection.append(h('p.add__note', null, 'No parts yet. Select something on the canvas and choose "Save as part" to reuse it across pages.'));
    }
    this.body.append(partsSection);

    for (const group of PALETTE) {
      const items = group.items.filter((i) => match(i.label + ' ' + i.hint));
      if (!items.length) continue;
      this.body.append(
        h('div.add__group', null,
          h('div.add__title', null, h('h3', null, group.title)),
          h('div.add__grid', null,
            items.map((item) => this.draggable(h('button.add__item', { type: 'button', title: item.hint }, item.label), { type: 'html', html: item.html, label: item.label })),
          ),
        ),
      );
    }

    const layouts = (index?.layouts ?? []).filter((l) => match(l.name + ' ' + l.path));
    const active = this.shell.activePath();
    const activeIsPage = !!active && fileKind(active) === 'html' && !!index?.pages.includes(active);
    const current = activeIsPage ? pageMeta(this.shell.docs.text(active!) ?? '')?.layout : undefined;
    const layoutSection = h('div.add__group', null,
      h('div.add__title', null,
        h('h3', null, 'Layouts'),
        h('button.linkbtn', { type: 'button', onclick: () => void actions.newLayout(this.shell).catch((e) => this.shell.notify(e.message, 'error')) }, 'New layout'),
      ),
    );
    for (const layout of layouts) {
      layoutSection.append(
        h('div.add__layout', { class: layout.path === current ? 'is-current' : '' },
          icon('layout'),
          h('div.add__layoutinfo', null, h('span.add__partname', null, layout.name), h('span.add__params', null, layout.slots.length ? `Slots: ${layout.slots.join(', ')}` : 'No slots')),
          layout.path === current
            ? h('span.add__current', null, 'In use')
            : h('button.linkbtn', {
                type: 'button',
                disabled: !activeIsPage,
                title: activeIsPage ? `Use this layout for ${active}` : 'Open a page to apply a layout',
                onclick: () => void actions.applyLayout(this.shell, active!, layout.path).catch((e) => this.shell.notify(e.message, 'error')),
              }, 'Apply'),
          h('button.iconbtn', { type: 'button', title: 'Edit layout', 'aria-label': `Edit ${layout.name}`, onclick: () => void this.shell.openFile(layout.path) }, icon('source', 14)),
        ),
      );
    }
    if (!layouts.length && !this.filter) layoutSection.append(h('p.add__note', null, 'A layout holds what every page shares: the head, header and footer. Pages fill its slots.'));
    this.body.append(layoutSection);
  }
}
