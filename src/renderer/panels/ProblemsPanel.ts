/**
 * Problems drawer: one list of everything wrong with the site. For open
 * files it reads Monaco's live markers (Wovenpage's own rules plus the CSS,
 * JSON and JavaScript language services); for files that are not open it
 * shows the result of the last whole-site check.
 */

import type { Diagnostic } from '../../shared/lint';
import { clear, debounce, h } from '../core/dom';
import { icon } from '../core/icons';
import { emptyState } from '../core/ui';
import { monaco, pathOf } from '../editor/monacoSetup';
import type { Shell } from '../workbench/Shell';

interface Row {
  path: string;
  line: number;
  col: number;
  severity: Diagnostic['severity'];
  message: string;
  source: string;
}

export class ProblemsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private rows: Row[] = [];
  private listeners = new Set<(counts: { errors: number; warnings: number }) => void>();

  constructor(private readonly shell: Shell) {
    this.list = h('div.problems__list');
    this.el = h('section.problems', { 'aria-label': 'Problems' },
      h('header.problems__head', null,
        h('h2', null, 'Problems'),
        h('button.btn', { type: 'button', onclick: () => void shell.commands.run('site.checkProblems') }, 'Check whole site'),
        h('button.iconbtn', { type: 'button', title: 'Close', 'aria-label': 'Close problems', onclick: () => void shell.commands.run('view.problems') }, icon('close')),
      ),
      this.list,
    );
    const refresh = debounce(() => this.refresh(), 150);
    monaco.editor.onDidChangeMarkers(refresh);
    shell.onDiagnostics.on(refresh);
    shell.onActive.on(refresh);
  }

  onCounts(listener: (counts: { errors: number; warnings: number }) => void): void {
    this.listeners.add(listener);
  }

  private refresh(): void {
    const rows: Row[] = [];
    const open = new Set<string>();
    for (const doc of this.shell.docs.all()) open.add(doc.path);

    for (const marker of monaco.editor.getModelMarkers({})) {
      const path = pathOf(marker.resource);
      if (!path || !open.has(path) || marker.severity === monaco.MarkerSeverity.Hint) continue;
      rows.push({
        path,
        line: marker.startLineNumber,
        col: marker.startColumn,
        severity: marker.severity === monaco.MarkerSeverity.Error ? 'error' : marker.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
        message: marker.message,
        source: marker.source ?? marker.owner,
      });
    }
    for (const [path, found] of Object.entries(this.shell.diagnostics())) {
      if (open.has(path)) continue; // live markers are fresher
      for (const d of found) rows.push({ path, line: d.line, col: d.col, severity: d.severity, message: d.message, source: 'Wovenpage' });
    }
    const rank = { error: 0, warning: 1, info: 2 };
    rows.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
    this.rows = rows;
    this.render();
    const counts = { errors: rows.filter((r) => r.severity === 'error').length, warnings: rows.filter((r) => r.severity === 'warning').length };
    this.listeners.forEach((l) => l(counts));
  }

  private render(): void {
    clear(this.list);
    if (!this.rows.length) {
      this.list.append(emptyState('No problems found in the open files. Run "Check whole site" to scan everything, including broken links.'));
      return;
    }
    for (const row of this.rows.slice(0, 500)) {
      this.list.append(
        h('button.problems__row', {
          type: 'button',
          class: `is-${row.severity}`,
          onclick: () => void this.shell.openFile(row.path, { line: row.line, col: row.col, view: this.shell.viewMode() === 'canvas' ? 'split' : undefined }),
        },
          icon(row.severity === 'error' ? 'error' : row.severity === 'warning' ? 'warning' : 'info', 14),
          h('span.problems__msg', null, row.message),
          h('span.problems__where', null, `${row.path}:${row.line}`),
        ),
      );
    }
    if (this.rows.length > 500) this.list.append(h('p.add__note', null, `Showing 500 of ${this.rows.length}.`));
  }
}
