/**
 * Project-wide validation: runs the shared HTML and CSS rules over every file,
 * parses JavaScript for syntax errors, and checks that links resolve.
 */

import { parse as parseJs } from 'acorn';

import { lintCss, lintHtml, Diagnostic } from '../../shared/lint';
import { lineColAt } from '../../shared/text';
import { fileKind, isSass, isSassPartial, sassSourcePath } from '../../shared/paths';
import type { ProjectDiagnostics } from '../../shared/types';
import type { ProjectService } from './ProjectService';
import { compileSass } from './SassCompiler';

export function lintJs(text: string): Diagnostic[] {
  const attempt = (sourceType: 'module' | 'script') => parseJs(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  try {
    attempt('module');
    return [];
  } catch (moduleError) {
    try {
      // Classic scripts allow a few things modules do not (e.g. `with`, top-level `await` as a name).
      attempt('script');
      return [];
    } catch {
      const err = moduleError as SyntaxError & { pos?: number };
      const start = Math.min(err.pos ?? 0, Math.max(0, text.length - 1));
      return [
        {
          code: 'js-syntax',
          message: err.message.replace(/\s*\(\d+:\d+\)$/, ''),
          severity: 'error',
          start,
          end: Math.min(text.length, start + 1),
          ...lineColAt(text, start),
        },
      ];
    }
  }
}

export class LintService {
  constructor(private readonly project: ProjectService) {}

  async lintProject(overlays: Record<string, string> = {}): Promise<ProjectDiagnostics> {
    const files = await this.project.listFiles();
    const known = new Set(files);
    // A link to x.css is satisfied by x.scss, which compiles to it.
    const exists = (path: string) => known.has(path) || known.has(sassSourcePath(path)) || this.project.existsSync(path);
    const read = (path: string) => overlays[path] ?? this.project.readSync(path);
    const out: ProjectDiagnostics = {};
    for (const path of files) {
      const kind = fileKind(path);
      if (kind !== 'html' && kind !== 'css' && kind !== 'js') continue;
      const text = overlays[path] ?? this.project.readSync(path);
      if (text === null) continue;
      if (isSass(path)) {
        // Sass is validated by compiling it. Partials are checked through the files that use them.
        if (isSassPartial(path)) continue;
        const { error } = compileSass(path, read);
        if (error) {
          const file = error.file ?? path;
          (out[file] ??= []).push({ code: 'sass-error', message: error.message, severity: 'error', start: 0, end: 1, line: error.line, col: error.col });
        }
        continue;
      }
      const found = kind === 'html' ? lintHtml(text, { path, exists }) : kind === 'css' ? lintCss(text, { path, exists }) : lintJs(text);
      if (found.length) out[path] = found;
    }
    return out;
  }
}
