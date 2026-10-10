/**
 * Link graph: finds every reference one project file makes to another, so the
 * project can report broken links and keep references intact when a file is
 * renamed or moved.
 */

import { TextEdit } from './text';
import { HtmlDoc, parseHtml } from './html/parse';
import { PAGE_TAG, PART_TAG, URL_ATTRS } from './compose';
import { dirname, fileKind, isExternalUrl, join, normalize, relative, splitUrl } from './paths';

export interface LinkRef {
  /** The URL exactly as written. */
  url: string;
  /** Range of the URL in the source text. */
  start: number;
  end: number;
  /** True for composition paths, which are relative to the site root rather than the file. */
  rooted: boolean;
  /** What kind of reference this is, for messages. */
  via: string;
}

export function scanHtmlLinks(doc: HtmlDoc): LinkRef[] {
  const refs: LinkRef[] = [];
  for (const el of doc.elements) {
    for (const attr of el.attrs) {
      if (attr.value === null || !attr.value.trim()) continue;
      if (el.name === PART_TAG && attr.name === 'src') {
        refs.push({ url: attr.value, start: attr.valueStart, end: attr.valueEnd, rooted: true, via: 'part' });
      } else if (el.name === PAGE_TAG && attr.name === 'layout') {
        refs.push({ url: attr.value, start: attr.valueStart, end: attr.valueEnd, rooted: true, via: 'layout' });
      } else if (el.name.startsWith('w-')) {
        continue;
      } else if (URL_ATTRS.has(attr.name)) {
        const lead = attr.value.length - attr.value.trimStart().length;
        const url = attr.value.trim();
        refs.push({ url, start: attr.valueStart + lead, end: attr.valueStart + lead + url.length, rooted: false, via: `${el.name} ${attr.name}` });
      } else if (attr.name === 'srcset') {
        const re = /(^|,)(\s*)([^\s,]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(attr.value))) {
          const start = attr.valueStart + m.index + m[1].length + m[2].length;
          refs.push({ url: m[3], start, end: start + m[3].length, rooted: false, via: `${el.name} srcset` });
        }
      }
    }
    if (el.name === 'style' && el.closeStart > el.openEnd) {
      for (const ref of scanCssLinks(doc.text.slice(el.openEnd, el.closeStart))) {
        refs.push({ ...ref, start: ref.start + el.openEnd, end: ref.end + el.openEnd });
      }
    }
  }
  return refs;
}

export function scanCssLinks(text: string): LinkRef[] {
  const refs: LinkRef[] = [];
  // Blank out comments while keeping offsets stable.
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(clean))) {
    const url = m[1] ?? m[2] ?? m[3] ?? '';
    if (!url) continue;
    const start = m.index + m[0].indexOf(url, 4);
    refs.push({ url, start, end: start + url.length, rooted: false, via: 'url()' });
  }
  const importRe = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = importRe.exec(clean))) {
    const url = m[1] ?? m[2] ?? '';
    if (!url) continue;
    const start = m.index + m[0].indexOf(url);
    refs.push({ url, start, end: start + url.length, rooted: false, via: '@import' });
  }
  return refs;
}

export function scanLinks(path: string, text: string): LinkRef[] {
  const kind = fileKind(path);
  if (kind === 'html') return scanHtmlLinks(parseHtml(text));
  if (kind === 'css') return scanCssLinks(text);
  return [];
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The project file a reference points at, or null for external URLs and anchors. */
export function resolveLink(fromFile: string, ref: Pick<LinkRef, 'url' | 'rooted'>): string | null {
  if (isExternalUrl(ref.url)) return null;
  const { path } = splitUrl(ref.url);
  if (!path) return null;
  const decoded = safeDecode(path);
  if (ref.rooted) return normalize(decoded);
  if (decoded.startsWith('/')) return normalize(decoded.slice(1));
  return join(dirname(fromFile), decoded);
}

/** A directory URL ("blog/") resolves to its index page. */
export function withIndex(target: string, exists: (path: string) => boolean): string {
  if (exists(target)) return target;
  const index = join(target, 'index.html');
  return exists(index) ? index : target;
}

/**
 * Edits that keep a file's links valid after files move.
 *
 * @param filePath  where the file lived when `text` was read
 * @param moves     old path -> new path for every moved file
 * @param newFilePath  where this file itself now lives, if it moved
 */
export function retargetLinks(filePath: string, text: string, moves: Map<string, string>, newFilePath = filePath): TextEdit[] {
  const edits: TextEdit[] = [];
  const selfMoved = dirname(newFilePath) !== dirname(filePath);
  for (const ref of scanLinks(filePath, text)) {
    const target = resolveLink(filePath, ref);
    if (target === null) continue;
    const moved = moves.get(target);
    if (!moved && (!selfMoved || ref.rooted)) continue;
    const dest = moved ?? target;
    const { path, suffix } = splitUrl(ref.url);
    let next: string;
    if (ref.rooted) next = dest;
    else if (path.startsWith('/')) next = '/' + dest;
    else next = relative(dirname(newFilePath), dest);
    next = encodeURI(next) + suffix;
    if (next !== ref.url) edits.push({ start: ref.start, end: ref.end, text: next });
  }
  return edits;
}
