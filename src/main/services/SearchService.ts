/**
 * Project-wide find and replace. Runs in the main process so a large site
 * never blocks the UI thread; unsaved editor buffers are passed in as
 * overlays so results always match what the user sees.
 */

import { applyEdits, TextEdit } from '../../shared/text';
import type { SearchFileResult, SearchMatch, SearchQuery, SearchResult } from '../../shared/types';
import type { ProjectService } from './ProjectService';

const MAX_MATCHES = 5000;
const PREVIEW_BEFORE = 40;
const PREVIEW_LENGTH = 160;

export function buildPattern(query: SearchQuery): RegExp {
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (query.wholeWord) source = `(?<![\\w-])(?:${source})(?![\\w-])`;
  return new RegExp(source, query.caseSensitive ? 'gmu' : 'gimu');
}

/** Turns "*.html, css/**" into a predicate over site-relative paths. */
export function globFilter(include: string): (path: string) => boolean {
  const globs = include
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  if (!globs.length) return () => true;
  const patterns = globs.map((glob) => {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          re += '.*';
          i++;
          if (glob[i + 1] === '/') i++;
        } else re += '[^/]*';
      } else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    // A glob without a slash matches by file name anywhere in the tree.
    return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
  });
  return (path) => patterns.some((p) => p.test(path));
}

export function findInText(text: string, pattern: RegExp, limit = MAX_MATCHES): SearchMatch[] {
  const matches: SearchMatch[] = [];
  pattern.lastIndex = 0;
  let line = 1;
  let lineStartOffset = 0;
  let scanned = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) && matches.length < limit) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    for (let nl = text.indexOf('\n', scanned); nl !== -1 && nl < m.index; nl = text.indexOf('\n', nl + 1)) {
      line++;
      lineStartOffset = nl + 1;
    }
    scanned = m.index;
    let lineEndOffset = text.indexOf('\n', m.index);
    if (lineEndOffset === -1) lineEndOffset = text.length;
    const col = m.index - lineStartOffset;
    const from = Math.max(0, col - PREVIEW_BEFORE);
    const lineText = text.slice(lineStartOffset, lineEndOffset).replace(/\r$/, '');
    const leading = from === 0 ? lineText.length - lineText.trimStart().length : 0;
    const start = Math.min(from + leading, col);
    const preview = lineText.slice(start, start + PREVIEW_LENGTH);
    matches.push({
      line,
      col: col + 1,
      start: m.index,
      end: m.index + m[0].length,
      preview,
      previewStart: col - start,
      previewLength: Math.min(m[0].length, preview.length - (col - start)),
    });
  }
  return matches;
}

/** Edits that replace every match, expanding $1-style groups for regex queries. */
export function replaceEdits(text: string, query: SearchQuery, replacement: string): TextEdit[] {
  const pattern = buildPattern(query);
  const edits: TextEdit[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    const out = query.regex ? m[0].replace(single, replacement) : replacement;
    edits.push({ start: m.index, end: m.index + m[0].length, text: out });
  }
  return edits;
}

export class SearchService {
  constructor(private readonly project: ProjectService) {}

  async search(query: SearchQuery, overlays: Record<string, string> = {}): Promise<SearchResult> {
    if (!query.text) return { files: [], total: 0, truncated: false };
    let pattern: RegExp;
    try {
      pattern = buildPattern(query);
    } catch (err) {
      return { files: [], total: 0, truncated: false, error: `That is not a valid regular expression: ${(err as Error).message}` };
    }
    const accept = globFilter(query.include);
    const files: SearchFileResult[] = [];
    let total = 0;
    const tree = await this.project.tree();
    const queue = [tree];
    while (queue.length) {
      const node = queue.shift()!;
      if (node.dir) {
        queue.unshift(...(node.children ?? []));
        continue;
      }
      if (!accept(node.path) || !this.project.isSearchable(node.path, node.size)) continue;
      const text = overlays[node.path] ?? this.project.readSync(node.path);
      if (text === null) continue;
      const matches = findInText(text, pattern, MAX_MATCHES - total);
      if (matches.length) {
        files.push({ path: node.path, matches });
        total += matches.length;
        if (total >= MAX_MATCHES) return { files, total, truncated: true };
      }
    }
    return { files, total, truncated: false };
  }

  /** Replaces every match in files on disk. Open, unsaved files are handled by the renderer instead. */
  async replaceInFiles(query: SearchQuery, replacement: string, paths: string[]): Promise<{ path: string; count: number }[]> {
    const out: { path: string; count: number }[] = [];
    for (const path of paths) {
      const text = this.project.readSync(path);
      if (text === null) continue;
      const edits = replaceEdits(text, query, replacement);
      if (!edits.length) continue;
      await this.project.write(path, applyEdits(text, edits));
      out.push({ path, count: edits.length });
    }
    return out;
  }
}
