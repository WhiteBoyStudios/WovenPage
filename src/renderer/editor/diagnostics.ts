/**
 * Live validation for open files. Wovenpage's own rules (structure,
 * accessibility basics, composition tags, broken links) are published as
 * Monaco markers under the "wovenpage" owner, next to the markers Monaco's
 * CSS, JSON and JavaScript services produce on their own.
 */

import { Diagnostic, lintCss, lintHtml } from '../../shared/lint';
import { fileKind, isSass } from '../../shared/paths';
import { debounce } from '../core/dom';
import type { DocumentStore } from '../documents/DocumentStore';
import { monaco } from './monacoSetup';

export const MARKER_OWNER = 'wovenpage';

export function severityOf(d: Diagnostic['severity']): monaco.MarkerSeverity {
  return d === 'error' ? monaco.MarkerSeverity.Error : d === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
}

export class Diagnostics {
  private pending = new Set<string>();
  private run = debounce(() => this.flush(), 350);

  constructor(
    private readonly docs: DocumentStore,
    private readonly fileExists: () => ((path: string) => boolean) | null,
  ) {
    docs.onChange.on(({ path }) => this.check(path));
  }

  check(path: string): void {
    this.pending.add(path);
    this.run();
  }

  checkAll(): void {
    for (const doc of this.docs.all()) this.pending.add(doc.path);
    this.run();
  }

  private flush(): void {
    const exists = this.fileExists() ?? undefined;
    for (const path of this.pending) {
      const doc = this.docs.get(path);
      if (!doc) continue;
      const kind = fileKind(path);
      const text = doc.model.getValue();
      let found: Diagnostic[] = [];
      if (kind === 'html') found = lintHtml(text, { path, exists });
      // Monaco's CSS service already reports syntax; add only what it cannot know.
      else if (kind === 'css' && !isSass(path)) found = lintCss(text, { path, exists }).filter((d) => d.code === 'broken-link' || d.code === 'duplicate-declaration');
      const model = doc.model;
      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        found.map((d) => {
          const start = model.getPositionAt(d.start);
          const end = model.getPositionAt(Math.max(d.end, d.start + 1));
          return {
            severity: severityOf(d.severity),
            message: d.message,
            code: d.code,
            source: 'Wovenpage',
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          };
        }),
      );
    }
    this.pending.clear();
  }
}
