/**
 * Compiles Sass (.scss) to CSS.
 *
 * A site can keep `css/site.scss` and link `css/site.css` from its pages: the
 * preview server compiles on request, and the build writes the compiled file.
 * Imports are resolved through the same reader the preview uses, so unsaved
 * edits to a partial show up straight away.
 */

import * as sass from 'sass';

import { basename, dirname, isSass, join, normalize } from '../../shared/paths';

export interface SassError {
  message: string;
  /** Site-relative file the error is in, when known. */
  file: string | null;
  /** 1-based. */
  line: number;
  col: number;
}

export interface SassResult {
  css: string;
  /** Every file that went into the result, starting with the entry file. */
  files: string[];
  error: SassError | null;
}

const SCHEME = 'site:';

function toUrl(path: string): URL {
  return new URL(`${SCHEME}///${path.split('/').map(encodeURIComponent).join('/')}`);
}

function toPath(url: URL): string {
  return normalize(decodeURIComponent(url.pathname));
}

/** The files Sass would consider for `@use "x"`, in its own order of preference. */
function candidates(path: string): string[] {
  if (/\.(scss|css)$/i.test(path)) return [path, join(dirname(path), `_${basename(path)}`)];
  const dir = dirname(path);
  const name = basename(path);
  return [join(dir, `${name}.scss`), join(dir, `_${name}.scss`), join(dir, `${name}.css`), join(path, '_index.scss'), join(path, 'index.scss')];
}

export function compileSass(path: string, read: (path: string) => string | null): SassResult {
  const entry = normalize(path);
  const source = read(entry);
  const files = [entry];
  if (source === null) return { css: '', files, error: { message: `"${entry}" does not exist.`, file: entry, line: 1, col: 1 } };

  const importer: sass.Importer<'sync'> = {
    canonicalize(url, context) {
      let target: string;
      if (url.startsWith(SCHEME)) target = toPath(new URL(url));
      else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // sass: built-ins, http: and the like
      else if (url.startsWith('/')) target = normalize(url.slice(1));
      else target = join(context.containingUrl ? dirname(toPath(context.containingUrl)) : dirname(entry), url);
      for (const candidate of candidates(target)) {
        if (read(candidate) !== null) return toUrl(candidate);
      }
      return null;
    },
    load(canonicalUrl) {
      const file = toPath(canonicalUrl);
      const contents = read(file);
      if (contents === null) return null;
      if (!files.includes(file)) files.push(file);
      return { contents, syntax: isSass(file) ? 'scss' : 'css' };
    },
  };

  try {
    const result = sass.compileString(source, {
      url: toUrl(entry),
      importer,
      syntax: 'scss',
      style: 'expanded',
      // Deprecation chatter belongs in a terminal, not in a preview server's output.
      logger: sass.Logger.silent,
    });
    return { css: result.css + (result.css.endsWith('\n') || !result.css ? '' : '\n'), files, error: null };
  } catch (err) {
    const e = err as sass.Exception;
    const span = e.span;
    let file: string | null = null;
    try {
      if (span?.url) file = toPath(span.url);
    } catch {
      /* not one of ours */
    }
    return {
      css: '',
      files,
      error: {
        message: e.sassMessage ?? e.message ?? String(err),
        file,
        line: (span?.start.line ?? 0) + 1,
        col: (span?.start.column ?? 0) + 1,
      },
    };
  }
}

/** CSS that shows a compile error at the top of the page instead of silently unstyling it. */
export function errorStylesheet(source: string, error: SassError): string {
  const text = `Sass error in ${error.file ?? source}, line ${error.line}: ${error.message}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  return `/* ${text.replace(/\*\//g, '* /')} */
body::before {
  content: "${text}";
  display: block;
  padding: 12px 16px;
  white-space: pre-wrap;
  font: 13px/1.5 ui-monospace, Consolas, monospace;
  color: #fff;
  background: #8a1f2c;
}
`;
}
