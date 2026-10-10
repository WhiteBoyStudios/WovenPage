/**
 * Text primitives shared by every patcher.
 *
 * Every edit Wovenpage makes to a source file - whether it comes from the
 * canvas, the inspector, a rename, or project-wide replace - is expressed as a
 * list of TextEdit values. That single representation is what lets visual
 * edits flow through the code editor's undo stack.
 */

export interface TextEdit {
  /** Offset of the first replaced character. */
  start: number;
  /** Offset just past the last replaced character (== start for an insert). */
  end: number;
  text: string;
}

/** Orders edits by position; inserts sort ahead of a replacement at the same offset. */
export function sortEdits(edits: readonly TextEdit[]): TextEdit[] {
  return [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = sortEdits(edits);
  let out = '';
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      throw new Error(`Overlapping text edits at offset ${edit.start}`);
    }
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/**
 * Where an offset in the original text lands after the edits are applied.
 * Offsets inside a replaced range collapse to the start of the replacement.
 */
export function mapOffset(edits: readonly TextEdit[], offset: number): number {
  let delta = 0;
  for (const edit of sortEdits(edits)) {
    if (edit.end <= offset) {
      delta += edit.text.length - (edit.end - edit.start);
    } else if (edit.start < offset) {
      return edit.start + delta;
    }
  }
  return offset + delta;
}

/** Offset, in the edited text, at which the text of `target` begins. */
export function insertedOffset(edits: readonly TextEdit[], target: TextEdit): number {
  let delta = 0;
  for (const edit of sortEdits(edits)) {
    if (edit === target) break;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return target.start + delta;
}

export function lineStart(text: string, offset: number): number {
  const nl = text.lastIndexOf('\n', offset - 1);
  return nl + 1;
}

/** Offset of the newline that ends the line (or text.length). */
export function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl;
}

/** Leading whitespace of the line that contains the offset. */
export function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(start, i);
}

/** True when only whitespace sits between the start of the line and the offset. */
export function startsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

/** True when only whitespace sits between the offset and the end of the line. */
export function endsLine(text: string, offset: number): boolean {
  return /^[ \t\r]*$/.test(text.slice(offset, lineEnd(text, offset)));
}

export interface LineCol {
  /** 1-based */
  line: number;
  /** 1-based */
  col: number;
}

export function lineColAt(text: string, offset: number): LineCol {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, col: offset - last };
}

/** Indent unit used by a file: a tab, or the smallest run of leading spaces. */
export function detectIndentUnit(text: string): string {
  let smallest = 0;
  const re = /^([ \t]+)\S/gm;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(text)) && seen < 400) {
    seen++;
    if (m[1][0] === '\t') return '\t';
    const n = m[1].length;
    if (n > 0 && (smallest === 0 || n < smallest)) smallest = n;
  }
  return ' '.repeat(smallest >= 2 && smallest <= 8 ? smallest : 2);
}

/**
 * Strips the indentation a fragment was written with and re-indents every
 * line after the first with `indent`. The first line is left bare so callers
 * can place it wherever they need.
 */
export function reindent(fragment: string, indent: string): string {
  const lines = fragment.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '').split('\n');
  let common = Infinity;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const lead = /^[ \t]*/.exec(lines[i])![0].length;
    common = Math.min(common, lead);
  }
  if (!Number.isFinite(common)) common = 0;
  return lines
    .map((line, i) => {
      if (i === 0) return line.trimStart();
      if (!line.trim()) return '';
      return indent + line.slice(common);
    })
    .join('\n');
}

export function escapeAttr(value: string): string {
  return value.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;').replace(/"/g, '&quot;');
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}
