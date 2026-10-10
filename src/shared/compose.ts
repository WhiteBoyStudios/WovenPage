/**
 * The Wovenpage composition format.
 *
 * Three custom tags let a static site share structure without a runtime:
 *
 *   Layout  (layouts/base.html)  - a full HTML document with holes:
 *       <title>{{title}}</title> ... <w-slot name="main">fallback</w-slot>
 *
 *   Page    (about.html)         - names a layout and fills its holes:
 *       <w-page layout="layouts/base.html" title="About">
 *         <w-fill slot="main"> ... </w-fill>
 *       </w-page>
 *
 *   Part    (parts/card.html)    - a reusable fragment with parameters:
 *       <article class="card"><h3>{{heading}}</h3><w-slot></w-slot></article>
 *     used as
 *       <w-part src="parts/card.html" heading="Hello">body</w-part>
 *
 * Composition is pure text splicing over the position-tracking parser, so it
 * works identically on instrumented text (for the canvas) and on raw text (for
 * the browser preview and the published build). Relative URLs inside layouts
 * and parts are rebased so they still resolve from the page that includes them.
 *
 * Paths in `layout` and `src` are relative to the site root.
 */

import { TextEdit, applyEdits, decodeEntities, escapeText } from './text';
import { ElementNode, HtmlDoc, attrValue, getAttr, parseHtml } from './html/parse';
import { DROP_ATTR, ID_ATTR, INSTANCE_ATTR } from './html/instrument';
import { dirname, isExternalUrl, join, normalize, relative, splitUrl } from './paths';

export const PAGE_TAG = 'w-page';
export const FILL_TAG = 'w-fill';
export const SLOT_TAG = 'w-slot';
export const PART_TAG = 'w-part';
export const EMPTY_TAG = 'w-empty';

export const DEFAULT_SLOT = 'main';
const MAX_PART_DEPTH = 12;

/** Attributes whose value is a single URL. */
export const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'data', 'formaction']);

export interface ComposeIssue {
  file: string;
  message: string;
  severity: 'error' | 'warning';
  /** Offset in the file as the reader supplied it (not meaningful for instrumented text). */
  offset?: number;
}

export interface ComposeOptions {
  /** Returns the text of a site-root-relative file, or null if it does not exist. */
  read: (path: string) => string | null;
  /** Emit drop placeholders for empty fills; used only by the design canvas. */
  canvas?: boolean;
}

export interface ComposeResult {
  html: string;
  /** Every file that contributed, starting with the page itself. */
  files: string[];
  issues: ComposeIssue[];
  layout: string | null;
}

export interface PageMeta {
  layout: string;
  vars: Record<string, string>;
  fills: string[];
}

function findPageRoot(doc: HtmlDoc): ElementNode | null {
  return doc.roots.find((el) => el.name === PAGE_TAG) ?? null;
}

/** Reads a page's layout binding, or null for an ordinary HTML document. */
export function pageMeta(text: string): PageMeta | null {
  const doc = parseHtml(text);
  const root = findPageRoot(doc);
  if (!root) return null;
  const vars: Record<string, string> = {};
  for (const attr of root.attrs) {
    if (attr.name !== 'layout' && !attr.name.startsWith('data-wp')) vars[attr.name] = decodeEntities(attr.value ?? '');
  }
  return {
    layout: normalize(attrValue(root, 'layout') ?? ''),
    vars,
    fills: root.children.filter((c) => c.name === FILL_TAG).map((c) => attrValue(c, 'slot') || DEFAULT_SLOT),
  };
}

export interface SlotInfo {
  name: string;
  fallback: string;
}

/** Names of the slots a layout or part exposes. */
export function listSlots(text: string): SlotInfo[] {
  const doc = parseHtml(text);
  const seen = new Set<string>();
  const out: SlotInfo[] = [];
  for (const el of doc.elements) {
    if (el.name !== SLOT_TAG) continue;
    const name = attrValue(el, 'name') || DEFAULT_SLOT;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, fallback: doc.text.slice(el.openEnd, el.closeStart).trim() });
  }
  return out;
}

/** Names of the {{parameters}} a part or layout reads. */
export function listParams(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\w-]+)\s*(?:\|[^}]*)?\}\}/g)) names.add(m[1]);
  return [...names];
}

/** Replaces {{name}} and {{name | fallback}} with values. Unknown names without a fallback become empty. */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_whole, name: string, fallback?: string) => {
    const value = vars[name.toLowerCase()] ?? vars[name];
    if (value !== undefined && value !== '') return escapeText(value).replace(/"/g, '&quot;');
    return fallback !== undefined ? fallback.trim() : '';
  });
}

function rebaseOne(url: string, fromDir: string, toDir: string): string {
  if (isExternalUrl(url) || url.startsWith('/')) return url;
  const { path, suffix } = splitUrl(url);
  if (!path) return url;
  return relative(toDir, join(fromDir, path)) + suffix;
}

/**
 * Rewrites relative URLs written for a file in `fromDir` so that they resolve
 * from `toDir`. Composition tags are skipped; their paths are root-relative.
 */
export function rebaseUrls(text: string, fromDir: string, toDir: string): string {
  if (normalize(fromDir) === normalize(toDir)) return text;
  const doc = parseHtml(text);
  const edits: TextEdit[] = [];
  for (const el of doc.elements) {
    if (el.name.startsWith('w-')) continue;
    for (const attr of el.attrs) {
      if (attr.value === null) continue;
      if (URL_ATTRS.has(attr.name)) {
        const next = rebaseOne(attr.value.trim(), fromDir, toDir);
        if (next !== attr.value.trim()) edits.push({ start: attr.valueStart, end: attr.valueEnd, text: next });
      } else if (attr.name === 'srcset') {
        const next = attr.value
          .split(',')
          .map((candidate) => {
            const m = /^(\s*)(\S+)(.*)$/s.exec(candidate);
            return m ? m[1] + rebaseOne(m[2], fromDir, toDir) + m[3] : candidate;
          })
          .join(',');
        if (next !== attr.value) edits.push({ start: attr.valueStart, end: attr.valueEnd, text: next });
      }
    }
  }
  return edits.length ? applyEdits(text, edits) : text;
}

/** Elements that are not nested inside another element of the same tag name. */
function outermost(doc: HtmlDoc, tag: string): ElementNode[] {
  const out: ElementNode[] = [];
  let lastEnd = -1;
  for (const el of doc.elements) {
    if (el.name !== tag || el.start < lastEnd) continue;
    out.push(el);
    lastEnd = el.end;
  }
  return out;
}

/** Copies a part instance's source address onto the root elements it expands to. */
function tagInstanceRoots(text: string, instanceId: string): string {
  const doc = parseHtml(text);
  const edits: TextEdit[] = doc.roots
    .filter((el) => !getAttr(el, INSTANCE_ATTR))
    .map((el) => ({ start: el.nameEnd, end: el.nameEnd, text: ` ${INSTANCE_ATTR}="${instanceId}"` }));
  return edits.length ? applyEdits(text, edits) : text;
}

class Composer {
  readonly files: string[] = [];
  readonly issues: ComposeIssue[] = [];

  constructor(
    private readonly opts: ComposeOptions,
    private readonly pageDir: string,
  ) {}

  read(path: string, requestedBy: string): string | null {
    const text = this.opts.read(path);
    if (text === null) {
      this.issues.push({ file: requestedBy, message: `"${path}" does not exist.`, severity: 'error' });
      return null;
    }
    if (!this.files.includes(path)) this.files.push(path);
    return text;
  }

  /**
   * Expands every <w-part> in `text`. The text's own URLs must already be
   * relative to the page being composed.
   */
  expandParts(text: string, file: string, stack: string[]): string {
    if (text.indexOf('<' + PART_TAG) === -1) return text;
    const doc = parseHtml(text);
    const edits: TextEdit[] = [];
    for (const el of outermost(doc, PART_TAG)) {
      const src = normalize(attrValue(el, 'src') ?? '');
      let replacement = '';
      if (!src) {
        this.issues.push({ file, message: '<w-part> is missing its src attribute.', severity: 'error', offset: el.start });
      } else if (stack.includes(src)) {
        this.issues.push({ file, message: `Part "${src}" includes itself (${[...stack, src].join(' > ')}).`, severity: 'error', offset: el.start });
      } else if (stack.length >= MAX_PART_DEPTH) {
        this.issues.push({ file, message: `Parts are nested more than ${MAX_PART_DEPTH} levels deep.`, severity: 'error', offset: el.start });
      } else {
        const partText = this.read(src, file);
        if (partText !== null) {
          const params: Record<string, string> = {};
          for (const attr of el.attrs) {
            if (attr.name !== 'src' && !attr.name.startsWith('data-wp')) params[attr.name] = decodeEntities(attr.value ?? '');
          }
          let body = substituteVars(partText, params);
          body = rebaseUrls(body, dirname(src), this.pageDir);
          const children = doc.text.slice(el.openEnd, el.closeStart);
          // An instance with no content of its own gets the part's fallback.
          body = this.fillSlots(body, children.trim() ? new Map([[DEFAULT_SLOT, children]]) : new Map(), null);
          body = this.expandParts(body, src, [...stack, src]);
          const instanceId = attrValue(el, ID_ATTR);
          if (instanceId) body = tagInstanceRoots(body, instanceId);
          replacement = body.trim();
        }
      }
      edits.push({ start: el.start, end: el.end, text: replacement });
    }
    return applyEdits(text, edits);
  }

  /**
   * Replaces each <w-slot> with the matching fill, or with the slot's own
   * fallback content when the page supplies none.
   */
  fillSlots(text: string, fills: Map<string, string>, emptyIds: Map<string, string> | null): string {
    if (text.indexOf('<' + SLOT_TAG) === -1) return text;
    const doc = parseHtml(text);
    const edits: TextEdit[] = [];
    for (const el of outermost(doc, SLOT_TAG)) {
      const name = attrValue(el, 'name') || DEFAULT_SLOT;
      let content = fills.get(name);
      if (content === undefined) {
        content = doc.text.slice(el.openEnd, el.closeStart);
      } else if (!content.trim() && emptyIds?.has(name)) {
        content = `<${EMPTY_TAG} ${DROP_ATTR}="${emptyIds.get(name)}" data-slot="${name}"></${EMPTY_TAG}>`;
      }
      edits.push({ start: el.start, end: el.end, text: content.trim() });
    }
    return applyEdits(text, edits);
  }
}

/** Builds the HTML a browser should receive for a page. */
export function composePage(pagePath: string, opts: ComposeOptions): ComposeResult {
  const page = normalize(pagePath);
  const pageDir = dirname(page);
  const composer = new Composer(opts, pageDir);
  const source = composer.read(page, page);
  if (source === null) return { html: '', files: composer.files, issues: composer.issues, layout: null };

  const doc = parseHtml(source);
  const root = findPageRoot(doc);
  if (!root) {
    return { html: composer.expandParts(source, page, [page]), files: composer.files, issues: composer.issues, layout: null };
  }

  const layoutPath = normalize(attrValue(root, 'layout') ?? '');
  const layoutText = layoutPath ? composer.read(layoutPath, page) : null;
  if (!layoutPath) composer.issues.push({ file: page, message: '<w-page> is missing its layout attribute.', severity: 'error', offset: root.start });

  const vars: Record<string, string> = {};
  for (const attr of root.attrs) {
    if (attr.name !== 'layout' && !attr.name.startsWith('data-wp')) vars[attr.name] = decodeEntities(attr.value ?? '');
  }

  const fills = new Map<string, string>();
  const emptyIds = new Map<string, string>();
  for (const child of root.children) {
    if (child.name !== FILL_TAG) continue;
    const name = attrValue(child, 'slot') || DEFAULT_SLOT;
    if (fills.has(name)) {
      composer.issues.push({ file: page, message: `Slot "${name}" is filled more than once; the first fill is used.`, severity: 'warning', offset: child.start });
      continue;
    }
    fills.set(name, composer.expandParts(source.slice(child.openEnd, child.closeStart), page, [page]));
    const id = attrValue(child, ID_ATTR);
    if (opts.canvas && id) emptyIds.set(name, id);
  }

  if (layoutText === null) {
    // Without a layout, still show the page's content so it can be edited.
    const body = [...fills.values()].join('\n');
    return { html: `<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n${body}\n</body></html>`, files: composer.files, issues: composer.issues, layout: layoutPath || null };
  }

  const known = new Set(listSlots(layoutText).map((s) => s.name));
  for (const name of fills.keys()) {
    if (!known.has(name)) composer.issues.push({ file: page, message: `Layout "${layoutPath}" has no slot named "${name}".`, severity: 'warning' });
  }

  let html = substituteVars(layoutText, vars);
  html = rebaseUrls(html, dirname(layoutPath), pageDir);
  html = composer.expandParts(html, layoutPath, [page, layoutPath]);
  html = composer.fillSlots(html, fills, emptyIds);
  return { html, files: composer.files, issues: composer.issues, layout: layoutPath };
}

// ------------------------------------------------------------- authoring aids

/** Source for a new page bound to a layout, with one fill per slot. */
export function newLayoutPage(layoutPath: string, slots: SlotInfo[], title: string): string {
  const names = slots.length ? slots : [{ name: DEFAULT_SLOT, fallback: '' }];
  const fills = names
    .map((slot) => {
      const starter = slot.name === DEFAULT_SLOT ? `\n    <h1>${escapeText(title)}</h1>\n    <p>Start writing here.</p>\n  ` : '';
      return `  <w-fill slot="${slot.name}">${starter}</w-fill>`;
    })
    .join('\n');
  return `<w-page layout="${layoutPath}" title="${escapeText(title).replace(/"/g, '&quot;')}">\n${fills}\n</w-page>\n`;
}

export function newPlainPage(title: string, stylesheetHref?: string): string {
  const link = stylesheetHref ? `\n  <link rel="stylesheet" href="${stylesheetHref}">` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeText(title)}</title>${link}
</head>
<body>
  <h1>${escapeText(title)}</h1>
  <p>Start writing here.</p>
</body>
</html>
`;
}

export function newLayout(title: string, stylesheetHref?: string): string {
  const link = stylesheetHref ? `\n  <link rel="stylesheet" href="${stylesheetHref}">` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title | ${escapeText(title)}}}</title>${link}
</head>
<body>
  <main>
    <w-slot name="main"></w-slot>
  </main>
</body>
</html>
`;
}

/**
 * Converts an ordinary HTML document into a page bound to a layout: the
 * contents of <body> become the fill for `slot` and the <title> becomes the
 * page's title. A page that already has a layout is simply re-pointed.
 */
export function bindToLayout(pageText: string, layoutPath: string, slot = DEFAULT_SLOT): string {
  const doc = parseHtml(pageText);
  const root = findPageRoot(doc);
  if (root) {
    const attr = getAttr(root, 'layout');
    if (attr) return applyEdits(pageText, [{ start: attr.valueStart, end: attr.valueEnd, text: layoutPath }]);
    return applyEdits(pageText, [{ start: root.nameEnd, end: root.nameEnd, text: ` layout="${layoutPath}"` }]);
  }
  const body = doc.elements.find((el) => el.name === 'body');
  const titleEl = doc.elements.find((el) => el.name === 'title');
  const title = titleEl ? pageText.slice(titleEl.openEnd, titleEl.closeStart).trim() : '';
  const content = (body ? pageText.slice(body.openEnd, body.closeStart) : pageText).replace(/^\s*\n/, '').replace(/\s+$/, '');
  const lines = content.split('\n');
  const lead = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length), Infinity);
  const indented = lines.map((l) => (l.trim() ? '    ' + l.slice(Number.isFinite(lead) ? lead : 0) : '')).join('\n');
  const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
  return `<w-page layout="${layoutPath}"${titleAttr}>\n  <w-fill slot="${slot}">\n${indented}\n  </w-fill>\n</w-page>\n`;
}
