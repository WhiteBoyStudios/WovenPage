/**
 * HTML source patcher.
 *
 * Each function turns one visual operation into the smallest set of text edits
 * that expresses it, leaving every other character of the file untouched. The
 * functions are pure: they take a parsed document and return edits, plus the
 * offset (in the edited text) of the element the user will expect to remain
 * selected.
 */

import {
  TextEdit,
  detectIndentUnit,
  endsLine,
  escapeAttr,
  indentAt,
  insertedOffset,
  lineEnd,
  lineStart,
  mapOffset,
  reindent,
  startsLine,
} from '../text';
import { ElementNode, HtmlDoc, contains, getAttr } from './parse';
import { decodeEntities } from '../text';

import type { Where } from '../protocol';
export type { Where };

export interface PatchResult {
  edits: TextEdit[];
  /** Offset in the edited text where the affected element begins. */
  focus: number;
}

export class PatchError extends Error {}

function element(doc: HtmlDoc, index: number): ElementNode {
  const el = doc.elements[index];
  if (!el) throw new PatchError(`Element ${index} no longer exists in the source.`);
  return el;
}

// ---------------------------------------------------------------- attributes

export function setAttribute(doc: HtmlDoc, index: number, name: string, value: string | null): PatchResult {
  const el = element(doc, index);
  const attr = getAttr(el, name.toLowerCase());
  const edits: TextEdit[] = [];
  if (attr) {
    if (value === null) {
      let start = attr.start;
      while (start > el.nameEnd && /\s/.test(doc.text[start - 1])) start--;
      edits.push({ start, end: attr.end, text: '' });
    } else if (attr.value === null) {
      edits.push({ start: attr.start, end: attr.end, text: `${name}="${escapeAttr(value)}"` });
    } else if (attr.quote === "'" && !value.includes("'")) {
      edits.push({ start: attr.valueStart, end: attr.valueEnd, text: value.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;') });
    } else {
      edits.push({ start: attr.valueStart - attr.quote.length, end: attr.valueEnd + attr.quote.length, text: `"${escapeAttr(value)}"` });
    }
  } else if (value !== null) {
    const last = el.attrs[el.attrs.length - 1];
    const at = last ? last.end : el.nameEnd;
    edits.push({ start: at, end: at, text: ` ${name}="${escapeAttr(value)}"` });
  }
  return { edits, focus: el.start };
}

// -------------------------------------------------------------- inline style

export interface StyleDecl {
  prop: string;
  value: string;
}

/** Splits a style attribute into declarations, respecting quotes and parentheses. */
export function parseInlineStyle(css: string): StyleDecl[] {
  const out: StyleDecl[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const push = (end: number) => {
    const chunk = css.slice(start, end);
    const colon = chunk.indexOf(':');
    if (colon > 0) {
      const prop = chunk.slice(0, colon).trim();
      const value = chunk.slice(colon + 1).trim();
      if (prop && value) out.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value });
    }
    start = end + 1;
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) push(i);
  }
  push(css.length);
  return out;
}

export function serializeInlineStyle(decls: StyleDecl[]): string {
  return decls.map((d) => `${d.prop}: ${d.value}`).join('; ') + (decls.length ? ';' : '');
}

/** Sets (or, with null, removes) properties in an element's style attribute. */
export function setInlineStyle(doc: HtmlDoc, index: number, changes: Record<string, string | null>): PatchResult {
  const el = element(doc, index);
  const attr = getAttr(el, 'style');
  const decls = attr?.value ? parseInlineStyle(decodeEntities(attr.value)) : [];
  for (const [prop, value] of Object.entries(changes)) {
    const at = decls.findIndex((d) => d.prop === prop);
    if (value === null || value.trim() === '') {
      if (at !== -1) decls.splice(at, 1);
    } else if (at !== -1) {
      decls[at] = { prop, value: value.trim() };
    } else {
      decls.push({ prop, value: value.trim() });
    }
  }
  return setAttribute(doc, index, 'style', decls.length ? serializeInlineStyle(decls) : null);
}

// ------------------------------------------------------------------- content

export function setInnerHtml(doc: HtmlDoc, index: number, html: string): PatchResult {
  const el = element(doc, index);
  if (el.isVoid || el.selfClosing) throw new PatchError(`<${el.name}> cannot hold content.`);
  return { edits: [{ start: el.openEnd, end: el.closeStart, text: html }], focus: el.start };
}

/** Range to delete so that removing an element does not leave a blank line behind. */
function removalRange(doc: HtmlDoc, el: ElementNode): { start: number; end: number } {
  const text = doc.text;
  if (startsLine(text, el.start) && endsLine(text, el.end)) {
    const start = lineStart(text, el.start);
    const nl = lineEnd(text, el.end);
    return { start, end: nl < text.length ? nl + 1 : nl };
  }
  return { start: el.start, end: el.end };
}

export function removeElement(doc: HtmlDoc, index: number): PatchResult {
  const el = element(doc, index);
  const range = removalRange(doc, el);
  const focus = el.parent ? el.parent.start : 0;
  return { edits: [{ start: range.start, end: range.end, text: '' }], focus };
}

// ----------------------------------------------------------------- insertion

function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}

/**
 * Builds the edit that places `html` relative to a reference element, matching
 * the indentation style the surrounding code already uses.
 */
function insertionEdit(doc: HtmlDoc, ref: ElementNode, where: Where, html: string): { edit: TextEdit; lead: number } {
  const text = doc.text;
  const unit = detectIndentUnit(text);

  if (where === 'before' || where === 'after') {
    const blockFormatted = startsLine(text, ref.start);
    const indent = indentAt(text, ref.start);
    if (!blockFormatted) {
      const at = where === 'before' ? ref.start : ref.end;
      return { edit: { start: at, end: at, text: reindent(html, indent) }, lead: 0 };
    }
    const body = reindent(html, indent);
    if (where === 'before') {
      return { edit: { start: ref.start, end: ref.start, text: `${body}\n${indent}` }, lead: 0 };
    }
    return { edit: { start: ref.end, end: ref.end, text: `\n${indent}${body}` }, lead: 1 + indent.length };
  }

  if (ref.isVoid || ref.selfClosing) throw new PatchError(`<${ref.name}> cannot contain other elements.`);

  const indent = indentAt(text, ref.start);
  const childIndent = indent + unit;
  const inner = text.slice(ref.openEnd, ref.closeStart);
  const refIsBlock = startsLine(text, ref.start);

  if (isBlank(inner) && refIsBlock && !ref.implicitEnd) {
    // <div></div>  ->  <div>\n  child\n</div>
    const body = reindent(html, childIndent);
    return {
      edit: { start: ref.openEnd, end: ref.closeStart, text: `\n${childIndent}${body}\n${indent}` },
      lead: 1 + childIndent.length,
    };
  }

  if (where === 'inside-end') {
    if (!ref.implicitEnd && startsLine(text, ref.closeStart)) {
      const at = lineStart(text, ref.closeStart);
      const body = reindent(html, childIndent);
      return { edit: { start: at, end: at, text: `${childIndent}${body}\n` }, lead: childIndent.length };
    }
    return { edit: { start: ref.closeStart, end: ref.closeStart, text: reindent(html, indent) }, lead: 0 };
  }

  // inside-start
  if (endsLine(text, ref.openEnd) && ref.openEnd < ref.closeStart) {
    const body = reindent(html, childIndent);
    return { edit: { start: ref.openEnd, end: ref.openEnd, text: `\n${childIndent}${body}` }, lead: 1 + childIndent.length };
  }
  return { edit: { start: ref.openEnd, end: ref.openEnd, text: reindent(html, indent) }, lead: 0 };
}

export function insertHtml(doc: HtmlDoc, refIndex: number, where: Where, html: string): PatchResult {
  const { edit, lead } = insertionEdit(doc, element(doc, refIndex), where, html);
  return { edits: [edit], focus: edit.start + lead };
}

export function duplicateElement(doc: HtmlDoc, index: number): PatchResult {
  const el = element(doc, index);
  return insertHtml(doc, index, 'after', doc.text.slice(el.start, el.end));
}

/** Moves an element to a new position in the same file. */
export function moveElement(doc: HtmlDoc, index: number, refIndex: number, where: Where): PatchResult {
  const el = element(doc, index);
  const ref = element(doc, refIndex);
  if (contains(el, ref)) throw new PatchError('An element cannot be moved inside itself.');

  const html = doc.text.slice(el.start, el.end);
  const { edit: insert, lead } = insertionEdit(doc, ref, where, html);

  let range = removalRange(doc, el);
  const overlaps = (r: { start: number; end: number }) =>
    insert.start < r.end && insert.end > r.start ? true : insert.start > r.start && insert.start < r.end;
  if (overlaps(range)) range = { start: el.start, end: el.end };
  if (overlaps(range)) return { edits: [], focus: el.start };

  const remove: TextEdit = { start: range.start, end: range.end, text: '' };
  const edits = [remove, insert];
  return { edits, focus: insertedOffset(edits, insert) + lead };
}

/** Wraps an element in a new parent, e.g. to turn a block into a link target. */
export function wrapElement(doc: HtmlDoc, index: number, openTag: string, closeTag: string): PatchResult {
  const el = element(doc, index);
  const text = doc.text;
  if (startsLine(text, el.start) && endsLine(text, el.end)) {
    const indent = indentAt(text, el.start);
    const unit = detectIndentUnit(text);
    const body = text
      .slice(el.start, el.end)
      .split('\n')
      .map((line, i) => (i === 0 ? indent + unit + line : line.trim() ? unit + line : line))
      .join('\n');
    return { edits: [{ start: el.start, end: el.end, text: `${openTag}\n${body}\n${indent}${closeTag}` }], focus: el.start };
  }
  return {
    edits: [
      { start: el.start, end: el.start, text: openTag },
      { start: el.end, end: el.end, text: closeTag },
    ],
    focus: el.start,
  };
}

/** Maps an offset through a patch; convenience for callers tracking a caret. */
export function follow(result: PatchResult, offset: number): number {
  return mapOffset(result.edits, offset);
}

/** Replaces a whole element with other markup (used when turning an element into a part). */
export function replaceElement(doc: HtmlDoc, index: number, html: string): PatchResult {
  const el = element(doc, index);
  const indent = indentAt(doc.text, el.start);
  return { edits: [{ start: el.start, end: el.end, text: reindent(html, indent) }], focus: el.start };
}

// ------------------------------------------------------- several elements

/**
 * Reduces a selection to the elements that matter for a structural edit:
 * anything nested inside another selected element is dropped (it travels with
 * its ancestor), and the rest are returned in document order.
 */
export function topLevel(doc: HtmlDoc, indices: readonly number[]): ElementNode[] {
  const els = [...new Set(indices)].map((i) => element(doc, i)).sort((a, b) => a.start - b.start);
  return els.filter((el) => !els.some((other) => other !== el && contains(other, el)));
}

export function removeElements(doc: HtmlDoc, indices: readonly number[]): PatchResult {
  const els = topLevel(doc, indices);
  if (!els.length) return { edits: [], focus: 0 };
  const edits = els.map((el) => {
    const range = removalRange(doc, el);
    return { start: range.start, end: range.end, text: '' };
  });
  return { edits, focus: els[0].parent ? els[0].parent.start : 0 };
}

export function duplicateElements(doc: HtmlDoc, indices: readonly number[]): PatchResult {
  const els = topLevel(doc, indices);
  if (!els.length) return { edits: [], focus: 0 };
  const edits = els.map((el) => insertionEdit(doc, el, 'after', doc.text.slice(el.start, el.end)).edit);
  return { edits, focus: els[0].start };
}

/** Source of several elements as one fragment, each normalised to start at column zero. */
export function combinedHtml(doc: HtmlDoc, indices: readonly number[]): string {
  return topLevel(doc, indices)
    .map((el) => reindent(doc.text.slice(el.start, el.end), ''))
    .join('\n');
}

/** Moves several elements, keeping their order, to one new position in the same file. */
export function moveElements(doc: HtmlDoc, indices: readonly number[], refIndex: number, where: Where): PatchResult {
  const els = topLevel(doc, indices);
  const ref = element(doc, refIndex);
  if (!els.length) return { edits: [], focus: ref.start };
  if (els.some((el) => contains(el, ref))) {
    if (els.some((el) => el === ref)) return { edits: [], focus: els[0].start };
    throw new PatchError('Elements cannot be moved inside themselves.');
  }
  const { edit: insert, lead } = insertionEdit(doc, ref, where, combinedHtml(doc, indices));
  const edits: TextEdit[] = [];
  for (const el of els) {
    let range = removalRange(doc, el);
    const clash = (r: { start: number; end: number }) => (insert.end > insert.start ? insert.start < r.end && insert.end > r.start : insert.start > r.start && insert.start < r.end);
    if (clash(range)) range = { start: el.start, end: el.end };
    if (clash(range)) return { edits: [], focus: els[0].start };
    edits.push({ start: range.start, end: range.end, text: '' });
  }
  edits.push(insert);
  return { edits, focus: insertedOffset(edits, insert) + lead };
}

/**
 * Wraps a run of sibling elements in a new parent ("group into a box").
 * The elements must share a parent and sit next to each other.
 */
export function wrapElements(doc: HtmlDoc, indices: readonly number[], openTag: string, closeTag: string): PatchResult {
  const els = topLevel(doc, indices);
  if (!els.length) return { edits: [], focus: 0 };
  const parent = els[0].parent;
  if (els.some((el) => el.parent !== parent)) throw new PatchError('Only elements that share a parent can be grouped.');
  const siblings = parent ? parent.children : doc.roots;
  const first = siblings.indexOf(els[0]);
  if (els.some((el, i) => siblings[first + i] !== el)) throw new PatchError('Only elements that sit next to each other can be grouped.');

  const text = doc.text;
  const start = els[0].start;
  const end = els[els.length - 1].end;
  if (startsLine(text, start) && endsLine(text, end)) {
    const indent = indentAt(text, start);
    const unit = detectIndentUnit(text);
    const body = text
      .slice(start, end)
      .split('\n')
      .map((line, i) => (i === 0 ? indent + unit + line : line.trim() ? unit + line : line))
      .join('\n');
    return { edits: [{ start, end, text: `${openTag}\n${body}\n${indent}${closeTag}` }], focus: start };
  }
  return {
    edits: [
      { start, end: start, text: openTag },
      { start: end, end, text: closeTag },
    ],
    focus: start,
  };
}
