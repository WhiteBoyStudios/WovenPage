/**
 * Validation that runs without a browser: structural HTML checks from the
 * parser, a handful of authoring rules, CSS structure checks, and link checks.
 * (Deep CSS and JavaScript diagnostics in the editor come from Monaco's
 * language services; these rules cover what those do not, and they also power
 * the project-wide Problems scan.)
 */

import { lineColAt } from './text';
import { HtmlDoc, IssueSeverity, attrValue, getAttr, parseHtml } from './html/parse';
import { parseCss } from './css/model';
import { FILL_TAG, PAGE_TAG, PART_TAG, SLOT_TAG } from './compose';
import { resolveLink, scanCssLinks, scanHtmlLinks, withIndex } from './links';

export interface Diagnostic {
  code: string;
  message: string;
  severity: IssueSeverity;
  start: number;
  end: number;
  line: number;
  col: number;
}

export interface LintContext {
  /** Path of the file being checked, relative to the site root. */
  path: string;
  /** Returns whether a site-root-relative path exists. Omit to skip link checks. */
  exists?: (path: string) => boolean;
}

const OBSOLETE = new Set(['font', 'center', 'marquee', 'blink', 'big', 'strike', 'tt', 'frame', 'frameset', 'acronym']);
const COMPOSITION_TAGS = new Set([PAGE_TAG, FILL_TAG, SLOT_TAG, PART_TAG]);

function finish(text: string, items: Omit<Diagnostic, 'line' | 'col'>[]): Diagnostic[] {
  return items
    .sort((a, b) => a.start - b.start)
    .map((item) => ({ ...item, ...lineColAt(text, item.start) }));
}

export function lintHtml(text: string, ctx: LintContext, parsed?: HtmlDoc): Diagnostic[] {
  const doc = parsed ?? parseHtml(text);
  const out: Omit<Diagnostic, 'line' | 'col'>[] = doc.issues.map((i) => ({ ...i }));
  const ids = new Map<string, number>();
  const isFullDocument = doc.elements.some((el) => el.name === 'html');
  const isPage = doc.roots.some((el) => el.name === PAGE_TAG);

  if (isFullDocument && !doc.hasDoctype) {
    out.push({ code: 'missing-doctype', message: 'Document has no <!doctype html>; browsers will render it in quirks mode.', severity: 'warning', start: 0, end: Math.min(text.length, 1) });
  }

  for (const el of doc.elements) {
    const openRange = { start: el.start, end: el.openEnd };

    if (el.name.startsWith('w-') && !COMPOSITION_TAGS.has(el.name)) {
      out.push({ code: 'unknown-composition-tag', message: `<${el.name}> is not a Wovenpage tag. Did you mean w-page, w-fill, w-slot or w-part?`, severity: 'error', ...openRange });
    }
    if (el.name === FILL_TAG && el.parent?.name !== PAGE_TAG) {
      out.push({ code: 'fill-outside-page', message: '<w-fill> only works directly inside <w-page>.', severity: 'error', ...openRange });
    }
    if (el.name === PAGE_TAG && !attrValue(el, 'layout')) {
      out.push({ code: 'page-without-layout', message: '<w-page> needs a layout attribute, e.g. layout="layouts/base.html".', severity: 'error', ...openRange });
    }
    if (el.name === PART_TAG && !attrValue(el, 'src')) {
      out.push({ code: 'part-without-src', message: '<w-part> needs a src attribute, e.g. src="parts/card.html".', severity: 'error', ...openRange });
    }
    if (el.name === SLOT_TAG && isPage) {
      out.push({ code: 'slot-in-page', message: '<w-slot> belongs in layouts and parts; pages use <w-fill>.', severity: 'warning', ...openRange });
    }

    if (OBSOLETE.has(el.name)) {
      out.push({ code: 'obsolete-element', message: `<${el.name}> is obsolete; use CSS instead.`, severity: 'warning', ...openRange });
    }

    const id = getAttr(el, 'id');
    if (id?.value && !id.value.includes('{{')) {
      if (ids.has(id.value)) {
        out.push({ code: 'duplicate-id', message: `id "${id.value}" is already used earlier in this file.`, severity: 'error', start: id.start, end: id.end });
      } else {
        ids.set(id.value, id.start);
      }
    }

    if (el.name === 'img' && !getAttr(el, 'alt')) {
      out.push({ code: 'img-alt', message: 'Image has no alt attribute. Describe it, or use alt="" if it is decorative.', severity: 'warning', ...openRange });
    }
    if (el.name === 'a' && !getAttr(el, 'href') && !getAttr(el, 'name') && !getAttr(el, 'id')) {
      out.push({ code: 'anchor-without-href', message: 'Link has no href, so it cannot be followed or focused.', severity: 'info', ...openRange });
    }
    if (el.name === 'html' && !getAttr(el, 'lang')) {
      out.push({ code: 'html-lang', message: '<html> has no lang attribute; screen readers use it to pick a voice.', severity: 'info', ...openRange });
    }
    if ((el.name === 'input' || el.name === 'select' || el.name === 'textarea') && attrValue(el, 'type') !== 'hidden') {
      const labelled = getAttr(el, 'aria-label') || getAttr(el, 'aria-labelledby') || getAttr(el, 'title');
      const controlId = attrValue(el, 'id');
      let wrapped = false;
      for (let p = el.parent; p; p = p.parent) if (p.name === 'label') wrapped = true;
      const hasFor = controlId ? doc.elements.some((l) => l.name === 'label' && attrValue(l, 'for') === controlId) : false;
      const type = attrValue(el, 'type');
      if (!labelled && !wrapped && !hasFor && type !== 'submit' && type !== 'button' && type !== 'reset') {
        out.push({ code: 'control-label', message: `<${el.name}> has no label.`, severity: 'info', ...openRange });
      }
    }
  }

  if (ctx.exists) {
    const exists = ctx.exists;
    for (const ref of scanHtmlLinks(doc)) {
      const target = resolveLink(ctx.path, ref);
      if (target === null) continue;
      const resolved = withIndex(target, exists);
      if (!exists(resolved)) {
        out.push({ code: 'broken-link', message: `"${ref.url}" points to a file that does not exist (${target || 'site root'}).`, severity: 'error', start: ref.start, end: ref.end });
      }
    }
  }

  return finish(text, out);
}

export function lintCss(text: string, ctx: LintContext): Diagnostic[] {
  const model = parseCss(text);
  const out: Omit<Diagnostic, 'line' | 'col'>[] = model.issues.map((i) => ({ ...i }));
  for (const rule of model.styleRules) {
    if (!rule.decls.length && !rule.children.length) {
      out.push({ code: 'empty-rule', message: `Rule "${rule.selector}" is empty.`, severity: 'info', start: rule.start, end: rule.bodyStart });
    }
    const seen = new Map<string, number>();
    for (const decl of rule.decls) {
      if (seen.has(decl.prop) && !decl.prop.startsWith('--')) {
        // Repeating a property is a legitimate fallback technique only when values differ.
        const earlier = rule.decls[seen.get(decl.prop)!];
        if (earlier.value === decl.value) {
          out.push({ code: 'duplicate-declaration', message: `"${decl.prop}" is declared twice with the same value.`, severity: 'warning', start: decl.start, end: decl.end });
        }
      }
      seen.set(decl.prop, rule.decls.indexOf(decl));
    }
  }
  if (ctx.exists) {
    for (const ref of scanCssLinks(text)) {
      const target = resolveLink(ctx.path, ref);
      if (target !== null && !ctx.exists(target)) {
        out.push({ code: 'broken-link', message: `"${ref.url}" points to a file that does not exist (${target}).`, severity: 'error', start: ref.start, end: ref.end });
      }
    }
  }
  return finish(text, out);
}
