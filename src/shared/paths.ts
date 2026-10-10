/**
 * Project-relative path helpers. Inside Wovenpage every path is a forward-slash
 * path relative to the site root ("css/site.css"); only the main process ever
 * converts to an absolute OS path. Keeping this module free of `node:path`
 * lets the renderer and the canvas agent share it.
 */

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/** Relative URL that reaches `to` from a file living in `fromDir`. */
export function relative(fromDir: string, to: string): string {
  const a = normalize(fromDir).split('/').filter(Boolean);
  const b = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join('/');
  return (up ? '../'.repeat(up) : '') + rest;
}

/** True if the path escapes the project root after normalisation. */
export function escapesRoot(path: string): boolean {
  const n = normalize(path);
  return n === '..' || n.startsWith('../');
}

export interface SplitUrl {
  path: string;
  /** Query string and fragment, including their leading ? or #. */
  suffix: string;
}

export function splitUrl(url: string): SplitUrl {
  const i = url.search(/[?#]/);
  return i === -1 ? { path: url, suffix: '' } : { path: url.slice(0, i), suffix: url.slice(i) };
}

/** URLs that never point at a file inside the project. */
export function isExternalUrl(url: string): boolean {
  const u = url.trim();
  return (
    u === '' ||
    u[0] === '#' ||
    u.startsWith('//') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) ||
    u.includes('{{')
  );
}

export type FileKind = 'html' | 'css' | 'js' | 'json' | 'image' | 'font' | 'video' | 'audio' | 'text' | 'other';

const KIND_BY_EXT: Record<string, FileKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.js': 'js',
  '.mjs': 'js',
  '.json': 'json',
  '.webmanifest': 'json',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.mp4': 'video',
  '.webm': 'video',
  '.ogv': 'video',
  '.mov': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.txt': 'text',
  '.md': 'text',
  '.xml': 'text',
  '.csv': 'text',
  '.htaccess': 'text',
};

export function fileKind(path: string): FileKind {
  return KIND_BY_EXT[extname(path)] ?? 'other';
}

/** Files the code editor can open. SVG is an image that is also text. */
export function isTextFile(path: string): boolean {
  const kind = fileKind(path);
  return kind === 'html' || kind === 'css' || kind === 'js' || kind === 'json' || kind === 'text' || extname(path) === '.svg';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/x-scss; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ttf.map': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

export function mimeType(path: string): string {
  return MIME[extname(path)] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------- Sass

export function isSass(path: string): boolean {
  return extname(path) === '.scss';
}

/** Partials (`_name.scss`) are only ever imported; they never become a stylesheet of their own. */
export function isSassPartial(path: string): boolean {
  return isSass(path) && basename(path).startsWith('_');
}

/** The stylesheet a Sass file compiles to: css/site.scss -> css/site.css. */
export function compiledCssPath(path: string): string {
  return isSass(path) ? path.slice(0, -5) + '.css' : path;
}

/** The Sass file that would compile to a stylesheet: css/site.css -> css/site.scss. */
export function sassSourcePath(cssPath: string): string {
  return extname(cssPath) === '.css' ? cssPath.slice(0, -4) + '.scss' : cssPath;
}
