/**
 * A range-preserving CSS model.
 *
 * The style inspector edits real stylesheets, so - exactly as with HTML - it
 * needs to know where each rule and declaration sits in the text. Style rules
 * are numbered depth-first in document order; the canvas agent numbers the
 * browser's CSSOM the same way, which is how "the rule the browser matched"
 * becomes "these characters in css/site.css".
 */

import { TextEdit, detectIndentUnit, indentAt, lineStart, startsLine } from '../text';
import type { ParseIssue } from '../html/parse';

export interface CssDecl {
  prop: string;
  value: string;
  important: boolean;
  start: number;
  /** Just past the terminating semicolon when there is one. */
  end: number;
  valueStart: number;
  valueEnd: number;
  terminated: boolean;
}

export interface CssRule {
  kind: 'style' | 'at' | 'keyframe';
  /** Selector text, or the at-rule's prelude (e.g. "(min-width: 40rem)"). */
  selector: string;
  /** At-rule name without the @, for kind === 'at'. */
  name?: string;
  /** Depth-first ordinal among style rules; -1 for everything else. */
  ordinal: number;
  /** Enclosing conditional at-rules, outermost first, e.g. ["@media (min-width: 40rem)"]. */
  context: string[];
  start: number;
  end: number;
  /** Offsets just inside the braces. Equal to `end` for statement at-rules. */
  bodyStart: number;
  bodyEnd: number;
  decls: CssDecl[];
  children: CssRule[];
}

export interface CssModel {
  text: string;
  rules: CssRule[];
  /** Style rules by ordinal. */
  styleRules: CssRule[];
  issues: ParseIssue[];
}

/** At-rules whose block contains declarations rather than nested rules. */
const DECLARATION_AT_RULES = new Set([
  'font-face', 'page', 'property', 'counter-style', 'font-palette-values', 'position-try', 'view-transition',
]);

export function parseCss(text: string): CssModel {
  const issues: ParseIssue[] = [];
  const styleRules: CssRule[] = [];
  const len = text.length;

  /** Skips a comment or string starting at i; returns the new offset, or i if neither. */
  const skipOpaque = (i: number): number => {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        issues.push({ code: 'unterminated-comment', message: 'Comment is never closed with */.', severity: 'error', start: i, end: i + 2 });
        return len;
      }
      return close + 2;
    }
    // Sass interpolation, #{...}, never occurs in CSS; treating it as opaque
    // lets this model read .scss files well enough to harvest names from them.
    if (ch === '#' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2);
      return close === -1 ? len : close + 1;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len && text[j] !== ch) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n') {
          issues.push({ code: 'unterminated-string', message: 'String is missing its closing quote.', severity: 'error', start: i, end: j });
          return j;
        }
        j++;
      }
      return Math.min(len, j + 1);
    }
    return i;
  };

  /** Scans forward to the first `;`, `{` or `}` that is not nested in () or []. */
  const scanStatement = (from: number): { stop: number; ch: string } => {
    let depth = 0;
    let i = from;
    while (i < len) {
      const skipped = skipOpaque(i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      const ch = text[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) return { stop: i, ch };
      i++;
    }
    return { stop: len, ch: '' };
  };

  const skipSpace = (i: number): number => {
    for (;;) {
      while (i < len && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '*') {
        const next = skipOpaque(i);
        if (next === i) return i;
        i = next;
      } else return i;
    }
  };

  const trimEnd = (from: number, to: number): number => {
    while (to > from && /\s/.test(text[to - 1])) to--;
    return to;
  };

  const parseDecl = (start: number, stop: number, terminated: boolean): CssDecl | null => {
    const raw = text.slice(start, stop);
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      if (raw.trim()) {
        issues.push({ code: 'bad-declaration', message: `"${raw.trim().slice(0, 40)}" is not a property: value pair.`, severity: 'warning', start, end: stop });
      }
      return null;
    }
    const propRaw = raw.slice(0, colon).trim();
    let valueStart = start + colon + 1;
    while (valueStart < stop && /\s/.test(text[valueStart])) valueStart++;
    const valueEnd = trimEnd(valueStart, stop);
    let value = text.slice(valueStart, valueEnd);
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important\s*$/i, '');
    return {
      prop: propRaw.startsWith('--') ? propRaw : propRaw.toLowerCase(),
      value,
      important,
      start,
      end: terminated ? stop + 1 : valueEnd,
      valueStart,
      valueEnd,
      terminated,
    };
  };

  /**
   * Parses the inside of a block (or the top level when `top` is true) and
   * returns the offset of the closing brace.
   */
  const parseBlock = (from: number, top: boolean, owner: CssRule | null, context: string[], mode: 'rules' | 'style' | 'decls' | 'keyframes', out: CssRule[]): number => {
    let i = from;
    for (;;) {
      i = skipSpace(i);
      if (i >= len) {
        if (!top && owner) {
          issues.push({ code: 'unclosed-block', message: `Block opened for "${owner.selector.slice(0, 40)}" is never closed with }.`, severity: 'error', start: owner.start, end: owner.bodyStart });
        }
        return len;
      }
      if (text[i] === '}') {
        if (top) {
          issues.push({ code: 'stray-brace', message: 'Unexpected } with no open block.', severity: 'error', start: i, end: i + 1 });
          i++;
          continue;
        }
        return i;
      }
      if (text[i] === ';') {
        i++;
        continue;
      }
      const { stop, ch } = scanStatement(i);
      if (ch === '{') {
        const preludeEnd = trimEnd(i, stop);
        const prelude = text.slice(i, preludeEnd);
        const rule: CssRule = {
          kind: 'style',
          selector: prelude,
          ordinal: -1,
          context,
          start: i,
          end: len,
          bodyStart: stop + 1,
          bodyEnd: len,
          decls: [],
          children: [],
        };
        let childMode: 'rules' | 'style' | 'decls' | 'keyframes' = 'style';
        let childContext = context;
        if (prelude[0] === '@') {
          const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)!;
          rule.kind = 'at';
          rule.name = m[1].toLowerCase();
          rule.selector = m[2].trim();
          if (rule.name.endsWith('keyframes')) childMode = 'keyframes';
          else if (DECLARATION_AT_RULES.has(rule.name)) childMode = 'decls';
          else {
            // Conditional group rules. Inside a style rule they hold declarations too.
            childMode = mode === 'style' ? 'style' : 'rules';
            childContext = [...context, `@${rule.name} ${rule.selector}`.trim()];
          }
        } else if (mode === 'keyframes') {
          rule.kind = 'keyframe';
          childMode = 'decls';
        } else {
          rule.ordinal = styleRules.length;
          styleRules.push(rule);
        }
        out.push(rule);
        const close = parseBlock(stop + 1, false, rule, childContext, childMode, rule.children);
        rule.bodyEnd = close;
        rule.end = Math.min(len, close + 1);
        i = rule.end;
        continue;
      }
      // A statement ended by ; or by the block's closing brace.
      const terminated = ch === ';';
      const stmtEnd = stop;
      const head = text.slice(i, stmtEnd).trim();
      if (head[0] === '@') {
        const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(head);
        out.push({
          kind: 'at',
          name: m ? m[1].toLowerCase() : '',
          selector: m ? m[2].trim() : head,
          ordinal: -1,
          context,
          start: i,
          end: terminated ? stmtEnd + 1 : stmtEnd,
          bodyStart: terminated ? stmtEnd + 1 : stmtEnd,
          bodyEnd: terminated ? stmtEnd + 1 : stmtEnd,
          decls: [],
          children: [],
        });
      } else if (owner && mode !== 'rules' && mode !== 'keyframes') {
        const decl = parseDecl(i, stmtEnd, terminated);
        if (decl) owner.decls.push(decl);
      } else if (head) {
        issues.push({ code: 'unexpected-text', message: `"${head.slice(0, 40)}" is not inside a rule.`, severity: 'error', start: i, end: stmtEnd });
      }
      if (ch === '') return len;
      i = terminated ? stmtEnd + 1 : stmtEnd;
    }
  };

  const rules: CssRule[] = [];
  parseBlock(0, true, null, [], 'rules', rules);
  return { text, rules, styleRules, issues };
}

/** Collapses whitespace so a selector written in source can be compared with CSSOM's selectorText. */
export function normalizeSelector(selector: string): string {
  return selector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/"/g, "'")
    .trim()
    .toLowerCase();
}

/**
 * Finds the source rule the browser reported. The ordinal is tried first and
 * verified against the selector; if the browser dropped an invalid rule and
 * the numbering drifted, the selector and its occurrence index decide.
 */
export function locateRule(model: CssModel, ordinal: number, selector: string): CssRule | null {
  const want = normalizeSelector(selector);
  const direct = model.styleRules[ordinal];
  if (direct && normalizeSelector(direct.selector) === want) return direct;
  let best: CssRule | null = null;
  let bestDistance = Infinity;
  for (const rule of model.styleRules) {
    if (normalizeSelector(rule.selector) !== want) continue;
    const distance = Math.abs(rule.ordinal - ordinal);
    if (distance < bestDistance) {
      best = rule;
      bestDistance = distance;
    }
  }
  return best;
}

export function findDecl(rule: CssRule, prop: string): CssDecl | undefined {
  for (let i = rule.decls.length - 1; i >= 0; i--) if (rule.decls[i].prop === prop) return rule.decls[i];
  return undefined;
}

/** Sets a declaration on a rule, or removes it when value is null. */
export function setDeclaration(model: CssModel, rule: CssRule, prop: string, value: string | null): TextEdit[] {
  const text = model.text;
  const existing = findDecl(rule, prop);
  if (value !== null) value = value.trim();

  if (existing) {
    if (value === null || value === '') {
      // Remove the declaration, and the whole line if it had one to itself.
      let start = existing.start;
      let end = existing.end;
      if (startsLine(text, start)) {
        const after = text.slice(end).match(/^[ \t]*(\/\*[^\n]*?\*\/)?[ \t]*\r?\n/);
        if (after && !after[1]) {
          start = lineStart(text, start);
          end += after[0].length;
        }
      } else if (text[end] === ' ') {
        end++;
      }
      return [{ start, end, text: '' }];
    }
    return [{ start: existing.valueStart, end: existing.valueEnd, text: existing.important ? `${value} !important` : value }];
  }

  if (value === null || value === '') return [];

  const edits: TextEdit[] = [];
  const last = rule.decls[rule.decls.length - 1];
  if (last && !last.terminated) edits.push({ start: last.end, end: last.end, text: ';' });

  const multiline = text.slice(rule.bodyStart, rule.bodyEnd).includes('\n');
  if (multiline && startsLine(text, rule.bodyEnd)) {
    const indent = indentAt(text, rule.start) + detectIndentUnit(text);
    // Keep declarations together, ahead of any nested rules.
    const firstChild = rule.children[0];
    const at = last ? lineStartAfter(text, last.end) : firstChild ? lineStart(text, firstChild.start) : lineStart(text, rule.bodyEnd);
    edits.push({ start: at, end: at, text: `${indent}${prop}: ${value};\n` });
  } else if (last) {
    edits.push({ start: last.end, end: last.end, text: ` ${prop}: ${value};` });
  } else {
    const inner = text.slice(rule.bodyStart, rule.bodyEnd);
    edits.push({ start: rule.bodyStart, end: rule.bodyEnd, text: /^\s*$/.test(inner) ? ` ${prop}: ${value}; ` : ` ${prop}: ${value};${inner}` });
  }
  return edits;
}

/** Offset of the start of the line after the one containing `offset`. */
function lineStartAfter(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
}

export function formatRule(selector: string, decls: Record<string, string>, unit = '  '): string {
  const body = Object.entries(decls)
    .map(([prop, value]) => `${unit}${prop}: ${value};\n`)
    .join('');
  return `${selector} {\n${body}}\n`;
}

/** Appends a new rule to the end of a stylesheet. */
export function appendRule(text: string, selector: string, decls: Record<string, string> = {}): TextEdit[] {
  const trimmed = text.replace(/\s+$/, '');
  const lead = trimmed ? '\n\n' : '';
  return [{ start: trimmed.length, end: text.length, text: lead + formatRule(selector, decls, detectIndentUnit(text)) }];
}

export interface CssFacts {
  classes: string[];
  ids: string[];
  customProperties: string[];
  fontFamilies: string[];
}

/** Harvests the names a stylesheet defines, for completion and the font picker. */
export function collectFacts(model: CssModel): CssFacts {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const props = new Set<string>();
  const fonts = new Set<string>();
  const visit = (rules: CssRule[]) => {
    for (const rule of rules) {
      if (rule.kind === 'style') {
        const sel = rule.selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"|'[^']*'/g, '');
        for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
        for (const m of sel.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) ids.add(m[1]);
      }
      if (rule.kind === 'at' && rule.name === 'font-face') {
        const family = findDecl(rule, 'font-family');
        if (family) fonts.add(family.value.replace(/^["']|["']$/g, ''));
      }
      if (rule.kind === 'at' && rule.name === 'property' && rule.selector.startsWith('--')) props.add(rule.selector);
      for (const decl of rule.decls) if (decl.prop.startsWith('--')) props.add(decl.prop);
      visit(rule.children);
    }
  };
  visit(model.rules);
  return {
    classes: [...classes].sort(),
    ids: [...ids].sort(),
    customProperties: [...props].sort(),
    fontFamilies: [...fonts].sort(),
  };
}
