/**
 * The start screen shown when no site is open: create a site, open a folder,
 * or return to a recent one.
 */

import type { ProjectInfo, RecentProject, StarterKind } from '../../shared/types';
import { api } from '../core/api';
import { h } from '../core/dom';
import { toast } from '../core/ui';

export class Launcher {
  readonly el: HTMLElement;

  constructor(recent: RecentProject[], onOpen: (project: ProjectInfo) => void) {
    const name = h<HTMLInputElement>('input.field.launch__name', { type: 'text', value: 'My site', 'aria-label': 'Name of the new site', spellcheck: 'false' });
    let starter: StarterKind = 'starter';

    const guard = async (work: () => Promise<ProjectInfo | null>) => {
      try {
        const project = await work();
        if (project) onOpen(project);
      } catch (err) {
        toast((err as Error).message, { kind: 'error' });
      }
    };

    const choice = (kind: StarterKind, title: string, text: string) => {
      const input = h<HTMLInputElement>('input', { type: 'radio', name: 'starter', value: kind, checked: kind === starter });
      input.addEventListener('change', () => (starter = kind));
      return h('label.launch__choice', null, input, h('span', null, h('strong', null, title), h('span', null, text)));
    };

    this.el = h('main.launch', null,
      h('div.launch__inner', null,
        h('header.launch__head', null,
          h('div.launch__mark', { 'aria-hidden': 'true' }, weaveMark()),
          h('div', null, h('h1', null, 'Wovenpage'), h('p', null, 'Design a page by hand and by code. Both views edit the same source.')),
        ),
        h('div.launch__cols', null,
          h('section.launch__card', null,
            h('h2', null, 'Start a new site'),
            h('label.launch__label', { for: 'launch-name' }, 'Site name'),
            Object.assign(name, { id: 'launch-name' }),
            h('fieldset.launch__starters', null,
              h('legend', null, 'Begin with'),
              choice('starter', 'A small example site', 'Three pages that share a layout and parts. Good for seeing how things fit together.'),
              choice('blank', 'One empty page', 'A single HTML page and a stylesheet.'),
            ),
            h('button.btn.btn--primary.btn--large', { type: 'button', onclick: () => void guard(() => api.createProject(name.value, starter)) }, 'Choose a folder and create'),
          ),
          h('section.launch__card', null,
            h('h2', null, 'Open an existing site'),
            h('p.launch__text', null, 'Any folder of HTML, CSS and JavaScript works. Nothing is changed until you save.'),
            h('button.btn.btn--large', { type: 'button', onclick: () => void guard(() => api.openProjectDialog()) }, 'Open a folder'),
            recent.length ? h('h3.launch__recent', null, 'Recent') : null,
            h('div.launch__list', null,
              recent.map((r) =>
                h('button.launch__item', { type: 'button', title: r.root, onclick: () => void guard(() => api.openProject(r.root)) },
                  h('span.launch__itemname', null, r.name),
                  h('span.launch__itempath', null, r.root),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/** The product mark: two threads crossing over and under each other. Drawn here, not borrowed. */
export function weaveMark(size = 44): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  // Two weft threads cross two warp threads, passing over one and under the next.
  svg.innerHTML = `
    <rect width="44" height="44" rx="9" fill="var(--accent)"/>
    <g fill="none" stroke-width="5">
      <path d="M15 9v26M29 9v26" stroke="var(--accent-ink)" opacity=".5" stroke-linecap="round"/>
      <path d="M9 16h26M9 28h26" stroke="var(--accent-ink)" stroke-linecap="round"/>
      <path d="M15 22.5v11M29 10.5v11" stroke="var(--accent)" stroke-width="9"/>
      <path d="M15 21v14M29 9v14" stroke="var(--accent-ink)" opacity=".5" stroke-linecap="round"/>
    </g>`;
  return svg;
}
