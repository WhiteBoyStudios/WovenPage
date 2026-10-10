/**
 * Find in site: search every text file (including unsaved buffers), jump to
 * a match, and replace across the whole project. Replacements in open files
 * go through the editor so they can be undone; closed files are rewritten on
 * disk after a confirmation that states exactly how much will change.
 */

import { applyEdits } from '../../shared/text';
import type { SearchQuery, SearchResult } from '../../shared/types';
import { api } from '../core/api';
import { clear, debounce, h } from '../core/dom';
import { icon } from '../core/icons';
import { confirmAction } from '../core/ui';
import type { Shell } from '../workbench/Shell';

/** Mirrors the main-process pattern builder so open buffers can be edited locally. */
function patternFor(query: SearchQuery): RegExp {
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (query.wholeWord) source = `(?<![\\w-])(?:${source})(?![\\w-])`;
  return new RegExp(source, query.caseSensitive ? 'gmu' : 'gimu');
}

export class SearchPanel {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private includeInput: HTMLInputElement;
  private results: HTMLElement;
  private summary: HTMLElement;
  private toggles = { caseSensitive: false, wholeWord: false, regex: false };
  private last: SearchResult | null = null;
  private collapsed = new Set<string>();
  private serial = 0;

  constructor(private readonly shell: Shell) {
    const run = debounce(() => void this.search(), 260);
    this.input = h<HTMLInputElement>('input.field', { type: 'text', placeholder: 'Find in site', 'aria-label': 'Find in site', spellcheck: 'false' });
    this.replaceInput = h<HTMLInputElement>('input.field', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
    this.includeInput = h<HTMLInputElement>('input.field', { type: 'text', placeholder: 'Only in, e.g. *.html, css/**', 'aria-label': 'Only search in these files', spellcheck: 'false' });
    this.input.addEventListener('input', run);
    this.includeInput.addEventListener('input', run);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        run.cancel();
        void this.search();
      }
    });

    const toggle = (key: keyof typeof this.toggles, label: string, title: string) => {
      const button = h('button.toggle', { type: 'button', title, 'aria-pressed': 'false' }, label);
      button.addEventListener('click', () => {
        this.toggles[key] = !this.toggles[key];
        button.setAttribute('aria-pressed', String(this.toggles[key]));
        void this.search();
      });
      return button;
    };

    this.summary = h('p.search__summary', { role: 'status' });
    this.results = h('div.search__results');
    this.el = h('section.panel', null,
      h('header.panel__head', null, h('h2', null, 'Find in site')),
      h('div.panel__bar.search__form', null,
        h('div.search__row', null, this.input, toggle('caseSensitive', 'Aa', 'Match case'), toggle('wholeWord', 'ab', 'Match whole words'), toggle('regex', '.*', 'Use a regular expression')),
        h('div.search__row', null, this.replaceInput, h('button.btn', { type: 'button', onclick: () => void this.replaceAll() }, 'Replace all')),
        this.includeInput,
      ),
      this.summary,
      this.results,
    );
  }

  focus(seed?: string): void {
    if (seed) this.input.value = seed;
    this.input.focus();
    this.input.select();
    if (seed) void this.search();
  }

  private query(): SearchQuery {
    return { text: this.input.value, include: this.includeInput.value, ...this.toggles };
  }

  private async search(): Promise<void> {
    const query = this.query();
    const serial = ++this.serial;
    if (!query.text) {
      this.last = null;
      this.summary.textContent = '';
      clear(this.results);
      return;
    }
    let result: SearchResult;
    try {
      result = await api.search(query, this.shell.docs.dirtyOverlays());
    } catch (err) {
      result = { files: [], total: 0, truncated: false, error: (err as Error).message };
    }
    if (serial !== this.serial) return; // a newer search superseded this one
    this.last = result;
    this.render();
  }

  private render(): void {
    const result = this.last;
    clear(this.results);
    if (!result) return;
    if (result.error) {
      this.summary.textContent = result.error;
      this.summary.classList.add('is-error');
      return;
    }
    this.summary.classList.remove('is-error');
    this.summary.textContent = result.total
      ? `${result.total}${result.truncated ? '+' : ''} match${result.total === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}`
      : 'No matches. Check the spelling, or clear the "Only in" filter.';
    for (const file of result.files) {
      const open = !this.collapsed.has(file.path);
      this.results.append(
        h('button.search__file', {
          type: 'button',
          'aria-expanded': String(open),
          onclick: () => {
            if (open) this.collapsed.add(file.path);
            else this.collapsed.delete(file.path);
            this.render();
          },
        }, icon(open ? 'chevronDown' : 'chevron', 12), h('span.search__path', null, file.path), h('span.search__count', null, String(file.matches.length))),
      );
      if (!open) continue;
      for (const match of file.matches) {
        const before = match.preview.slice(0, match.previewStart);
        const hit = match.preview.slice(match.previewStart, match.previewStart + match.previewLength);
        const after = match.preview.slice(match.previewStart + match.previewLength);
        this.results.append(
          h('button.search__match', {
            type: 'button',
            title: `${file.path}:${match.line}`,
            onclick: () => void this.shell.openFile(file.path, { line: match.line, col: match.col, length: match.end - match.start, view: 'source' }),
          }, h('span.search__line', null, String(match.line)), h('span.search__text', null, before, h('mark', null, hit), after)),
        );
      }
    }
  }

  private async replaceAll(): Promise<void> {
    const query = this.query();
    if (!query.text) return this.input.focus();
    await this.search();
    const result = this.last;
    if (!result || result.error || !result.total) return;
    const replacement = this.replaceInput.value;
    const ok = await confirmAction(
      'Replace across the site?',
      `${result.total} match${result.total === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'} will become "${replacement}". Files that are open can be undone in the editor; files that are closed are rewritten on disk.`,
      `Replace ${result.total}`,
    );
    if (!ok) return;

    const closed: string[] = [];
    let changed = 0;
    for (const file of result.files) {
      const doc = this.shell.docs.get(file.path);
      if (!doc) {
        closed.push(file.path);
        continue;
      }
      const text = doc.model.getValue();
      const pattern = patternFor(query);
      const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      const edits = [...text.matchAll(pattern)]
        .filter((m) => m[0].length > 0)
        .map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: query.regex ? m[0].replace(single, replacement) : replacement }));
      if (edits.length && applyEdits(text, edits) !== text) {
        this.shell.docs.applyEdits(file.path, edits, 'user');
        changed += edits.length;
      }
    }
    if (closed.length) {
      const done = await api.replaceInFiles(query, replacement, closed);
      changed += done.reduce((sum, d) => sum + d.count, 0);
    }
    this.shell.notify(`Replaced ${changed} match${changed === 1 ? '' : 'es'}.`, 'success');
    await this.search();
  }
}
