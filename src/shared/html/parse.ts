/**
 * Position-tracking HTML parser.
 *
 * This is the foundation of source-mapped visual editing. It does not try to
 * be a spec-complete tree builder; it answers one question precisely: "where,
 * in this exact text, does element number N start and end?" Elements are
 * numbered in the order their open tags appear, which is the one property that
 * is stable no matter how a browser later repairs the tree - so the number can
 * be stamped onto the open tag, round-tripped through a real browser, and used
 * to find the same characters again.
 */

import { decodeEntities } from '../text';

export interface AttrNode {
  /** Lower-cased attribute name. */
  name: string;
  /** Raw value exactly as written (entities not decoded); null for a bare attribute. */
  value: string | null;
  start: number;
  end: number;
  /** Range of the value without its quotes; equal when there is no value. */
  valueStart: number;
  valueEnd: number;
  quote: '"' | "'" | '';
}

export interface ElementNode {
  /** Ordinal of the open tag in document order. */
  index: number;
  /** Lower-cased tag name. */
  name: string;
  /** Offset of the `<` that opens the element. */
  start: number;
  /** Offset just past the tag name inside the open tag. */
  nameEnd: number;
  /** Offset just past the `>` of the open tag. */
  openEnd: number;
  /** Offset of the `<` of the close tag; equals `end` when there is none. */
  closeStart: number;
  /** Offset just past the whole element. */
  end: number;
  selfClosing: boolean;
  isVoid: boolean;
  /** True when the element was closed by something other than its own end tag. */
  implicitEnd: boolean;
  attrs: AttrNode[];
  parent: ElementNode | null;
  children: ElementNode[];
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ParseIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
  start: number;
  end: number;
}

export interface HtmlDoc {
  text: string;
  /** Every element, indexed by ordinal. */
  elements: ElementNode[];
  roots: ElementNode[];
  issues: ParseIssue[];
  hasDoctype: boolean;
}

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Elements whose end tag may legally be omitted. */
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
  'option', 'optgroup', 'colgroup', 'caption', 'rp', 'rt',
]);

/** Opening any of these implicitly closes an open <p>. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

const TABLE_SECTIONS = new Set(['thead', 'tbody', 'tfoot']);
const CELLS = new Set(['td', 'th']);

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isNameStart(ch: string | undefined): boolean {
  return !!ch && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

export function parseHtml(text: string): HtmlDoc {
  const elements: ElementNode[] = [];
  const roots: ElementNode[] = [];
  const issues: ParseIssue[] = [];
  const stack: ElementNode[] = [];
  let hasDoctype = false;
  const len = text.length;
  let i = 0;

  const top = () => stack[stack.length - 1];

  /** Closes the innermost open element at `at` without consuming an end tag. */
  const closeImplicitly = (at: number, report: boolean) => {
    const el = stack.pop()!;
    el.closeStart = at;
    el.end = at;
    el.implicitEnd = true;
    if (report && !OPTIONAL_END.has(el.name)) {
      issues.push({
        code: 'unclosed-element',
        message: `<${el.name}> is never closed.`,
        severity: 'error',
        start: el.start,
        end: el.openEnd,
      });
    }
  };

  const insideForeign = () => stack.some((el) => el.name === 'svg' || el.name === 'math');

  const applyAutoClose = (name: string, at: number) => {
    const t = top();
    if (!t) return;
    if (t.name === 'p' && CLOSES_P.has(name)) return closeImplicitly(at, false);
    if (name === 'li' && t.name === 'li') return closeImplicitly(at, false);
    if ((name === 'dt' || name === 'dd') && (t.name === 'dt' || t.name === 'dd')) return closeImplicitly(at, false);
    if (name === 'option' && t.name === 'option') return closeImplicitly(at, false);
    if (name === 'optgroup') {
      if (top()?.name === 'option') closeImplicitly(at, false);
      if (top()?.name === 'optgroup') closeImplicitly(at, false);
      return;
    }
    if (CELLS.has(name) && CELLS.has(t.name)) return closeImplicitly(at, false);
    if (name === 'tr') {
      if (CELLS.has(top()?.name ?? '')) closeImplicitly(at, false);
      if (top()?.name === 'tr') closeImplicitly(at, false);
      return;
    }
    if (TABLE_SECTIONS.has(name)) {
      if (CELLS.has(top()?.name ?? '')) closeImplicitly(at, false);
      if (top()?.name === 'tr') closeImplicitly(at, false);
      if (TABLE_SECTIONS.has(top()?.name ?? '')) closeImplicitly(at, false);
    }
  };

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    const next = text[i + 1];

    // Comment
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close === -1) {
        issues.push({ code: 'unterminated-comment', message: 'Comment is never closed with -->.', severity: 'error', start: i, end: i + 4 });
        i = len;
      } else {
        i = close + 3;
      }
      continue;
    }

    // Doctype, CDATA, processing instruction
    if (next === '!' || next === '?') {
      if (/^<!doctype/i.test(text.slice(i, i + 9))) hasDoctype = true;
      const close = text.indexOf('>', i + 2);
      i = close === -1 ? len : close + 1;
      continue;
    }

    // End tag
    if (next === '/') {
      let j = i + 2;
      while (j < len && !isSpace(text[j]) && text[j] !== '>') j++;
      const name = text.slice(i + 2, j).toLowerCase();
      const close = text.indexOf('>', j);
      const tagEnd = close === -1 ? len : close + 1;
      let depth = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].name === name) {
          depth = s;
          break;
        }
      }
      if (depth === -1) {
        if (name) {
          issues.push({
            code: 'stray-end-tag',
            message: VOID_ELEMENTS.has(name) ? `<${name}> is a void element and takes no end tag.` : `</${name}> has no matching open tag.`,
            severity: VOID_ELEMENTS.has(name) ? 'warning' : 'error',
            start: i,
            end: tagEnd,
          });
        }
      } else {
        while (stack.length - 1 > depth) closeImplicitly(i, true);
        const el = stack.pop()!;
        el.closeStart = i;
        el.end = tagEnd;
      }
      i = tagEnd;
      continue;
    }

    // Anything that is not a tag is text.
    if (!isNameStart(next)) {
      i++;
      continue;
    }

    // Open tag
    let j = i + 1;
    while (j < len && !isSpace(text[j]) && text[j] !== '>' && text[j] !== '/') j++;
    const name = text.slice(i + 1, j).toLowerCase();
    const nameEnd = j;
    const attrs: AttrNode[] = [];
    let selfClosingSyntax = false;
    let closed = false;

    while (j < len) {
      while (j < len && isSpace(text[j])) j++;
      if (j >= len) break;
      const ch = text[j];
      if (ch === '>') {
        j++;
        closed = true;
        break;
      }
      if (ch === '/') {
        if (text[j + 1] === '>') {
          selfClosingSyntax = true;
          j += 2;
          closed = true;
          break;
        }
        j++;
        continue;
      }
      if (ch === '<') {
        // A new tag began before this one ended; treat the tag as closed here.
        break;
      }
      const attrStart = j;
      while (j < len && !isSpace(text[j]) && text[j] !== '=' && text[j] !== '>' && !(text[j] === '/' && text[j + 1] === '>')) j++;
      const attrName = text.slice(attrStart, j).toLowerCase();
      let k = j;
      while (k < len && isSpace(text[k])) k++;
      if (text[k] !== '=') {
        attrs.push({ name: attrName, value: null, start: attrStart, end: j, valueStart: j, valueEnd: j, quote: '' });
        continue;
      }
      k++;
      while (k < len && isSpace(text[k])) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const endQuote = text.indexOf(q, k + 1);
        if (endQuote === -1) {
          issues.push({ code: 'unterminated-attribute', message: `Value of "${attrName}" is missing its closing quote.`, severity: 'error', start: attrStart, end: k + 1 });
          attrs.push({ name: attrName, value: text.slice(k + 1), start: attrStart, end: len, valueStart: k + 1, valueEnd: len, quote: q });
          j = len;
          break;
        }
        attrs.push({ name: attrName, value: text.slice(k + 1, endQuote), start: attrStart, end: endQuote + 1, valueStart: k + 1, valueEnd: endQuote, quote: q });
        j = endQuote + 1;
      } else {
        let v = k;
        while (v < len && !isSpace(text[v]) && text[v] !== '>') v++;
        attrs.push({ name: attrName, value: text.slice(k, v), start: attrStart, end: v, valueStart: k, valueEnd: v, quote: '' });
        j = v;
      }
    }

    if (!closed) {
      issues.push({ code: 'unterminated-tag', message: `<${name}> tag is missing its closing >.`, severity: 'error', start: i, end: nameEnd });
    }

    applyAutoClose(name, i);

    const isVoid = VOID_ELEMENTS.has(name);
    // In HTML a trailing slash only means something on void elements, inside
    // SVG/MathML, and on Wovenpage's own composition tags (which never reach
    // a browser).
    const selfClosing = selfClosingSyntax && (isVoid || name.startsWith('w-') || insideForeign() || name === 'svg');
    if (selfClosingSyntax && !selfClosing) {
      issues.push({
        code: 'self-closing-non-void',
        message: `<${name}/> is not self-closing in HTML; browsers treat it as an open tag.`,
        severity: 'warning',
        start: i,
        end: j,
      });
    }

    const parent = top() ?? null;
    const el: ElementNode = {
      index: elements.length,
      name,
      start: i,
      nameEnd,
      openEnd: j,
      closeStart: j,
      end: j,
      selfClosing,
      isVoid,
      implicitEnd: false,
      attrs,
      parent,
      children: [],
    };
    elements.push(el);
    if (parent) parent.children.push(el);
    else roots.push(el);

    const seen = new Set<string>();
    for (const attr of attrs) {
      if (seen.has(attr.name)) {
        issues.push({ code: 'duplicate-attribute', message: `Attribute "${attr.name}" appears more than once; browsers keep only the first.`, severity: 'warning', start: attr.start, end: attr.end });
      }
      seen.add(attr.name);
    }

    i = j;
    if (isVoid || selfClosing) continue;

    if (RAW_TEXT.has(name) && !insideForeign()) {
      // Contents are opaque text up to the matching end tag.
      const re = new RegExp(`</${name}(?=[\\s>/])`, 'ig');
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m) {
        el.closeStart = len;
        el.end = len;
        el.implicitEnd = true;
        issues.push({ code: 'unclosed-element', message: `<${name}> is never closed.`, severity: 'error', start: el.start, end: el.openEnd });
        i = len;
      } else {
        const close = text.indexOf('>', m.index);
        el.closeStart = m.index;
        el.end = close === -1 ? len : close + 1;
        i = el.end;
      }
      continue;
    }

    stack.push(el);
  }

  while (stack.length) closeImplicitly(len, true);

  return { text, elements, roots, issues, hasDoctype };
}

export function getAttr(el: ElementNode, name: string): AttrNode | undefined {
  for (const attr of el.attrs) if (attr.name === name) return attr;
  return undefined;
}

/** Decoded attribute value, or undefined when the attribute is absent. */
export function attrValue(el: ElementNode, name: string): string | undefined {
  const attr = getAttr(el, name);
  if (!attr) return undefined;
  return attr.value === null ? '' : decodeEntities(attr.value);
}

/** Deepest element whose source range contains the offset. */
export function elementAt(doc: HtmlDoc, offset: number): ElementNode | null {
  let found: ElementNode | null = null;
  let level = doc.roots;
  for (;;) {
    let hit: ElementNode | null = null;
    for (const el of level) {
      if (offset >= el.start && offset < el.end) {
        hit = el;
        break;
      }
      if (el.start > offset) break;
    }
    if (!hit) return found;
    found = hit;
    level = hit.children;
  }
}

export function innerText(doc: HtmlDoc, el: ElementNode): string {
  return doc.text.slice(el.openEnd, el.closeStart);
}

export function outerText(doc: HtmlDoc, el: ElementNode): string {
  return doc.text.slice(el.start, el.end);
}

export function contains(outer: ElementNode, inner: ElementNode): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** Short human label, e.g. `section.hero` or `a#home`. */
export function elementLabel(el: ElementNode): string {
  const id = attrValue(el, 'id');
  const cls = attrValue(el, 'class');
  let label = el.name;
  if (id) label += `#${id}`;
  else if (cls) {
    const first = cls.trim().split(/\s+/)[0];
    if (first) label += `.${first}`;
  }
  return label;
}
