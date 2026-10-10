/**
 * The canvas agent.
 *
 * This script is injected into the instrumented build of a page and runs
 * inside the design view's iframe - a real browser document rendering the
 * user's real HTML, CSS and JavaScript. It never edits source itself. Its job
 * is to translate gestures into operations addressed by source id:
 *
 *     drag  ->  { kind: 'move', id: '0:14', ref: '0:9', where: 'before' }
 *
 * and to report what the browser knows about the selected element (computed
 * styles, matching CSS rules) so the inspector can show it. The workbench
 * applies each operation to the source text and reloads the canvas when the
 * structure changed.
 */

import { DROP_ATTR, ID_ATTR, INSTANCE_ATTR, NodeId, parseNodeId } from '../shared/ids';
import {
  AgentMessage,
  CanvasMode,
  CanvasOp,
  Crumb,
  HostMessage,
  InsertPayload,
  MatchedRule,
  SelectionInfo,
  Where,
  unwrap,
  wrap,
} from '../shared/protocol';
import { INSPECTOR_PROPS } from '../shared/styleSchema';

interface Boot {
  epoch: number;
  files: string[];
  path: string;
  issues: { file: string; message: string }[];
}

interface SnapTargets {
  /** Vertical lines (x positions) and horizontal lines (y positions) worth aligning to. */
  xs: number[];
  ys: number[];
  /** Sizes of siblings, for "same width / same height" snapping. */
  sizes: { el: Element; w: number; h: number }[];
}

interface DropTarget {
  ref: Element;
  where: Where;
  /** Where to draw the indicator. */
  line: { x: number; y: number; w: number; h: number } | null;
  box: Element | null;
}

(function main() {
  const found = (window as unknown as { __WOVENPAGE__?: Boot }).__WOVENPAGE__;
  if (!found || window.parent === window) return;
  const boot: Boot = found;

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const NO_CHILDREN = new Set([...VOID, 'video', 'audio', 'iframe', 'canvas', 'svg', 'textarea', 'select', 'script', 'style', 'picture', 'object', 'title', 'w-empty']);
  const TEXT_LEAVES = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'strong', 'em', 'b', 'i', 'label', 'button', 'figcaption', 'small', 'code', 'li', 'dt', 'dd', 'td', 'th', 'summary', 'caption', 'legend', 'blockquote', 'pre', 'time', 'mark', 'q', 'cite']);
  const INLINE = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'em', 'i', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr']);
  const FIXED = new Set(['html', 'head', 'body']);

  let mode: CanvasMode = 'edit';
  let selected: Element | null = null;
  let hovered: Element | null = null;
  let editing: HTMLElement | null = null;
  let editSnapshot = '';
  let dragPayload: InsertPayload | null = null;
  /** Further selected elements, beyond the primary one in `selected`. */
  let extras: Element[] = [];
  /** `inGroup`: the press landed on a member of a multiple selection, so a drag moves them all. */
  let press: { el: Element; x: number; y: number; dragging: boolean; inGroup: boolean } | null = null;
  let resize: { el: HTMLElement; dir: string; x: number; y: number; w: number; h: number; ratio: number; snap: SnapTargets } | null = null;
  let drop: DropTarget | null = null;
  /** Alignment guides shown while resizing, in viewport coordinates. */
  let guides: { x: number; y: number; w: number; h: number }[] = [];
  /** A sibling whose size the element being resized currently matches. */
  let matched: Element | null = null;
  const SNAP = 6;

  const post = (message: AgentMessage) => window.parent.postMessage(wrap(message), '*');
  const sendOp = (op: CanvasOp) => post({ t: 'op', epoch: boot.epoch, op });

  // ------------------------------------------------------------ addressing

  const idOf = (el: Element | null): NodeId | null => el?.getAttribute(ID_ATTR) ?? null;
  const structIdOf = (el: Element): NodeId => el.getAttribute(INSTANCE_ATTR) ?? el.getAttribute(ID_ATTR)!;
  const tagOf = (el: Element) => el.localName;
  const fileOf = (id: NodeId | null): string | null => {
    const parsed = id ? parseNodeId(id) : null;
    return parsed ? (boot.files[parsed.file] ?? null) : null;
  };
  const isShared = (el: Element) => {
    const file = fileOf(idOf(el));
    return file !== null && file !== boot.path;
  };

  /** Nearest element that has a source address (elements created by page scripts do not). */
  function owner(node: Node | null): Element | null {
    let el = node instanceof Element ? node : (node?.parentElement ?? null);
    while (el) {
      if (el === uiHost) return null;
      if (el.hasAttribute(ID_ATTR) || el.hasAttribute(DROP_ATTR)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function pick(x: number, y: number): Element | null {
    return owner(document.elementFromPoint(x, y));
  }

  function byId(id: NodeId): Element | null {
    return document.querySelector(`[${ID_ATTR}="${id}"]`);
  }

  function labelOf(el: Element): string {
    let label = tagOf(el);
    if (el.id) label += `#${el.id}`;
    else if (el.classList.length) label += `.${el.classList[0]}`;
    return label;
  }

  // ------------------------------------------------------------- overlay UI

  const uiHost = document.createElement('div');
  uiHost.setAttribute('data-wp-ui', '');
  uiHost.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = uiHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { --own: #3346c8; --shared: #b0306a; --ink: #fff; }
      /* The host is reset with all:initial, so the typeface is set on the pieces that show text. */
      .chip, .size, .banner { font: 500 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
      .box { position: fixed; display: none; box-sizing: border-box; pointer-events: none; }
      .hover { border: 1px solid color-mix(in srgb, var(--c) 70%, transparent); background: color-mix(in srgb, var(--c) 6%, transparent); }
      .sel { border: 1.5px solid var(--c); }
      .sel.extra { border-style: dashed; }
      .guide { position: fixed; display: none; background: #d9730d; }
      .match { border: 1.5px dashed #d9730d; }
      .chip { position: absolute; left: -1.5px; bottom: 100%; max-width: 60vw; padding: 3px 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              color: var(--ink); background: var(--c); border-radius: 3px 3px 0 0; pointer-events: none; }
      .chip.inside { bottom: auto; top: -1.5px; border-radius: 0 0 3px 0; }
      .chip small { font: inherit; opacity: .8; margin-left: 6px; }
      .handle { position: absolute; width: 9px; height: 9px; background: #fff; border: 1.5px solid var(--c); border-radius: 2px; pointer-events: auto; }
      .handle.e { right: -5.5px; top: calc(50% - 4.5px); cursor: ew-resize; }
      .handle.s { bottom: -5.5px; left: calc(50% - 4.5px); cursor: ns-resize; }
      .handle.se { right: -5.5px; bottom: -5.5px; cursor: nwse-resize; }
      .size { position: absolute; right: 0; top: 100%; margin-top: 6px; padding: 2px 6px; color: #fff; background: #1b2030; border-radius: 3px; display: none; white-space: nowrap; }
      .line { position: fixed; display: none; background: var(--own); border-radius: 2px; box-shadow: 0 0 0 1px #fff; }
      .dropbox { border: 2px solid var(--own); background: color-mix(in srgb, var(--own) 10%, transparent); border-radius: 2px; }
      .banner { position: fixed; left: 12px; right: 12px; top: 12px; display: none; padding: 10px 12px; color: #fff; background: #8a1f2c; border-radius: 4px; font-size: 12px; line-height: 1.5; pointer-events: auto; }
      .banner b { font-weight: 600; }
    </style>
    <div class="box hover"></div>
    <div class="box sel"><div class="chip"></div><div class="handle e" data-dir="e"></div><div class="handle s" data-dir="s"></div><div class="handle se" data-dir="se"></div><div class="size"></div></div>
    <div class="box dropbox"></div>
    <div class="box match"></div>
    <div class="guide"></div>
    <div class="guide"></div>
    <div class="line"></div>
    <div class="banner"></div>`;
  const $ = <T extends HTMLElement>(sel: string) => shadow.querySelector(sel) as T;
  const hoverBox = $('.hover');
  const selBox = $('.sel');
  const chip = $('.chip');
  const sizeTag = $('.size');
  const lineEl = $('.line');
  const dropBox = $('.dropbox');
  const matchBox = $('.match');
  const guideEls = Array.from(shadow.querySelectorAll<HTMLElement>('.guide'));
  const extraBoxes: HTMLElement[] = [];
  const banner = $('.banner');

  const pageStyle = document.createElement('style');
  pageStyle.setAttribute('data-wp-ui', '');
  pageStyle.textContent = `
    w-empty { display: grid; place-items: center; min-height: 88px; margin: 8px 0; border: 1.5px dashed #8b93b8; border-radius: 4px; background: rgb(51 70 200 / 0.05);
              color: #5a6185; font: 13px/1.4 "Segoe UI", system-ui, sans-serif; }
    w-empty::before { content: "Drop elements here"; }
    w-slot { display: block; min-height: 56px; outline: 1.5px dashed #b0306a; outline-offset: -1.5px; position: relative; }
    w-slot::after { content: "slot: " attr(name); position: absolute; right: 0; top: 0; padding: 2px 6px; color: #fff; background: #b0306a; font: 11px/1.3 "Segoe UI", system-ui, sans-serif; }
    [contenteditable="true"][${ID_ATTR}] { outline: 2px solid #3346c8 !important; outline-offset: 2px; cursor: text; }
  `;

  function place(box: HTMLElement, el: Element | null, colorFor?: Element) {
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    if (colorFor) box.style.setProperty('--c', isShared(colorFor) ? 'var(--shared)' : 'var(--own)');
  }

  function frame() {
    const showChrome = mode === 'edit' && !editing;
    place(hoverBox, showChrome && hovered !== selected && !press?.dragging && !resize ? hovered : null, hovered ?? undefined);
    place(selBox, showChrome ? selected : null, selected ?? undefined);
    const members = showChrome ? extras.filter((el) => el.isConnected) : [];
    while (extraBoxes.length < members.length) {
      const box = document.createElement('div');
      box.className = 'box sel extra';
      shadow.insertBefore(box, selBox);
      extraBoxes.push(box);
    }
    extraBoxes.forEach((box, i) => place(box, members[i] ?? null, members[i]));
    if (showChrome && selected?.isConnected) {
      const r = selected.getBoundingClientRect();
      chip.classList.toggle('inside', r.top < 22);
      // Handles resize one element; a multiple selection has none.
      const resizable = movable(selected) && !members.length;
      selBox.querySelectorAll<HTMLElement>('.handle').forEach((h) => (h.style.display = resizable && !press?.dragging ? 'block' : 'none'));
    }
    guideEls.forEach((el, i) => {
      const line = resize ? guides[i] : undefined;
      el.style.display = line ? 'block' : 'none';
      if (line) Object.assign(el.style, { left: `${line.x}px`, top: `${line.y}px`, width: `${line.w}px`, height: `${line.h}px` });
    });
    place(matchBox, resize ? matched : null);
    if (drop) {
      place(dropBox, drop.box);
      if (drop.line) {
        lineEl.style.display = 'block';
        lineEl.style.left = `${drop.line.x}px`;
        lineEl.style.top = `${drop.line.y}px`;
        lineEl.style.width = `${drop.line.w}px`;
        lineEl.style.height = `${drop.line.h}px`;
      } else lineEl.style.display = 'none';
    } else {
      dropBox.style.display = 'none';
      lineEl.style.display = 'none';
    }
    requestAnimationFrame(frame);
  }

  function updateChip() {
    if (!selected) return;
    if (extras.length) {
      chip.textContent = `${extras.length + 1} elements`;
      return;
    }
    const file = fileOf(idOf(selected));
    const shared = file !== null && file !== boot.path;
    chip.textContent = labelOf(selected);
    if (shared) {
      const where = document.createElement('small');
      where.textContent = `in ${file}`;
      chip.append(where);
    }
  }

  // -------------------------------------------------------------- selection

  function matchesSafely(el: Element, selector: string): boolean {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  function sheetPath(sheet: CSSStyleSheet): string | null {
    if (!sheet.href) return null;
    try {
      const url = new URL(sheet.href);
      return url.origin === location.origin ? decodeURIComponent(url.pathname).replace(/^\/+/, '') : null;
    } catch {
      return null;
    }
  }

  /** Walks a sheet's style rules depth-first, numbering them exactly as the source-side CSS model does. */
  function walkSheet(sheet: CSSStyleSheet, visit: (rule: CSSStyleRule, ordinal: number, context: string[], resolved: string, active: boolean) => void, onImport?: (s: CSSStyleSheet) => void) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // cross-origin sheet
    }
    let n = 0;
    const walk = (list: CSSRuleList, context: string[], parentSelector: string, active: boolean) => {
      for (const rule of Array.from(list)) {
        const type = rule.constructor.name;
        if (type === 'CSSStyleRule') {
          const style = rule as CSSStyleRule;
          const sel = style.selectorText;
          const resolved = !parentSelector ? sel : sel.includes('&') ? sel.replace(/&/g, `:is(${parentSelector})`) : `:is(${parentSelector}) ${sel}`;
          visit(style, n++, context, resolved, active);
          if (style.cssRules?.length) walk(style.cssRules, context, resolved, active);
        } else if (type === 'CSSImportRule') {
          const imported = (rule as CSSImportRule).styleSheet;
          if (imported && onImport) onImport(imported);
        } else if (type === 'CSSKeyframesRule' || type === 'CSSFontFaceRule') {
          continue;
        } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
          let on = active;
          let label = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
          if (type === 'CSSMediaRule') {
            const media = (rule as CSSMediaRule).media.mediaText;
            on = active && window.matchMedia(media).matches;
            label = `@media ${media}`;
          } else if (type === 'CSSSupportsRule') {
            const cond = (rule as CSSSupportsRule).conditionText;
            on = active && CSS.supports(cond);
            label = `@supports ${cond}`;
          }
          walk((rule as CSSGroupingRule).cssRules, [...context, label], parentSelector, on);
        }
      }
    };
    walk(rules, [], '', true);
  }

  function pageSheets(): CSSStyleSheet[] {
    const out: CSSStyleSheet[] = [];
    const add = (sheet: CSSStyleSheet) => {
      const node = sheet.ownerNode as Element | null;
      if (node?.hasAttribute?.('data-wp-ui') || sheet.disabled) return;
      out.push(sheet);
      walkSheet(sheet, () => undefined, add);
    };
    Array.from(document.styleSheets).forEach(add);
    return out;
  }

  function matchedRules(el: Element): MatchedRule[] {
    const out: MatchedRule[] = [];
    for (const sheet of pageSheets()) {
      const href = sheetPath(sheet);
      walkSheet(sheet, (rule, ordinal, context, resolved, active) => {
        if (!active || !matchesSafely(el, resolved)) return;
        const decls: Record<string, string> = {};
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i];
          decls[prop] = rule.style.getPropertyValue(prop);
        }
        out.push({ href, selector: rule.selectorText, ordinal, context, decls });
      });
    }
    return out;
  }

  function describe(el: Element): SelectionInfo {
    const cs = getComputedStyle(el);
    const computed: Record<string, string> = {};
    for (const prop of INSPECTOR_PROPS) computed[prop] = cs.getPropertyValue(prop);
    const inline: Record<string, string> = {};
    const style = (el as HTMLElement).style;
    if (style) for (let i = 0; i < style.length; i++) inline[style[i]] = style.getPropertyValue(style[i]);
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith('data-wp') && attr.name !== 'contenteditable') attrs[attr.name] = attr.value;
    }
    const crumbs: Crumb[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const id = idOf(node);
      if (id) crumbs.unshift({ id, label: labelOf(node) });
    }
    const r = el.getBoundingClientRect();
    const sheets = pageSheets().map(sheetPath).filter((p): p is string => p !== null);
    return {
      group: (el === selected ? group() : [el]).map((m) => ({ id: idOf(m)!, structId: structIdOf(m), label: labelOf(m) })),
      id: idOf(el)!,
      structId: structIdOf(el),
      tag: tagOf(el),
      classes: Array.from(el.classList),
      attrs,
      inline,
      computed,
      rules: matchedRules(el),
      crumbs,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : 'block',
      sheets: [...new Set(sheets)],
      canHoldChildren: !NO_CHILDREN.has(tagOf(el)),
    };
  }

  const movable = (el: Element) => !FIXED.has(tagOf(el)) && !el.hasAttribute(DROP_ATTR);

  /** Every selected element, primary first. */
  function group(): Element[] {
    return selected ? [selected, ...extras.filter((el) => el.isConnected && el !== selected)] : [];
  }

  /** Adds an element to the selection, or takes it out (Shift- or Ctrl-click). */
  function toggle(el: Element) {
    if (!selected || !movable(selected) || !movable(el)) return select(el, 'user');
    if (el === selected) {
      if (!extras.length) return select(null, 'user');
      selected = extras.shift()!;
    } else if (extras.includes(el)) {
      extras = extras.filter((other) => other !== el);
    } else {
      extras.push(el);
    }
    updateChip();
    post({ t: 'select', info: describe(selected), by: 'user' });
  }

  function select(el: Element | null, by: 'user' | 'host', reveal = false) {
    if (el && !el.hasAttribute(ID_ATTR)) el = null;
    selected = el;
    extras = [];
    updateChip();
    if (el && reveal) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    post({ t: 'select', info: el ? describe(el) : null, by });
  }

  // -------------------------------------------------------------- dropping

  function childrenWithIds(container: Element, skip: Element[] = []): Element[] {
    return Array.from(container.children).filter((c) => c !== uiHost && !skip.includes(c) && (c.hasAttribute(ID_ATTR) || c.hasAttribute(DROP_ATTR)) && c.getClientRects().length > 0);
  }

  function axisOf(container: Element, kids: Element[]): 'row' | 'column' {
    if (kids.length >= 2) {
      const a = kids[0].getBoundingClientRect();
      const b = kids[1].getBoundingClientRect();
      return b.left >= a.right - 1 && Math.abs(b.top - a.top) < Math.max(a.height, b.height) * 0.5 ? 'row' : 'column';
    }
    const cs = getComputedStyle(container);
    if (cs.display.includes('flex')) return cs.flexDirection.startsWith('row') ? 'row' : 'column';
    if (kids[0] && getComputedStyle(kids[0]).display.startsWith('inline')) return 'row';
    return 'column';
  }

  function edgeLine(el: Element, axis: 'row' | 'column', after: boolean) {
    const r = el.getBoundingClientRect();
    return axis === 'row'
      ? { x: (after ? r.right : r.left) - 1.5, y: r.top, w: 3, h: r.height }
      : { x: r.left, y: (after ? r.bottom : r.top) - 1.5, w: r.width, h: 3 };
  }

  /** Chooses a position among a container's children nearest the pointer. */
  function placeInside(container: Element, x: number, y: number, dragged: Element[]): DropTarget {
    const kids = childrenWithIds(container, dragged);
    if (!kids.length) return { ref: container, where: 'inside-end', line: null, box: container };
    const axis = axisOf(container, kids);
    let best = kids[0];
    let bestDistance = Infinity;
    for (const kid of kids) {
      const r = kid.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        best = kid;
        bestDistance = d;
      }
    }
    const r = best.getBoundingClientRect();
    const after = axis === 'row' ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    return { ref: best, where: after ? 'after' : 'before', line: edgeLine(best, axis, after), box: container };
  }

  /** `dragged` lists the elements being moved, so they cannot be dropped onto themselves. */
  function findDrop(x: number, y: number, dragged: Element[]): DropTarget | null {
    const el = pick(x, y);
    if (el && dragged.some((d) => d === el || d.contains(el))) return null;
    if (!el || FIXED.has(tagOf(el))) {
      return document.body.hasAttribute(ID_ATTR) ? placeInside(document.body, x, y, dragged) : null;
    }
    if (el.hasAttribute(DROP_ATTR)) return { ref: el, where: 'inside-end', line: null, box: el };

    const tag = tagOf(el);
    const leaf = NO_CHILDREN.has(tag) || TEXT_LEAVES.has(tag) || INLINE.has(tag);
    const r = el.getBoundingClientRect();
    const parent = el.parentElement ? owner(el.parentElement) : null;
    const siblings = parent ? childrenWithIds(el.parentElement!, dragged) : [el];
    const axis = el.parentElement ? axisOf(el.parentElement, siblings.length ? siblings : [el]) : 'column';
    const along = axis === 'row' ? x - r.left : y - r.top;
    const extent = axis === 'row' ? r.width : r.height;

    if (leaf) {
      const after = along > extent / 2;
      return { ref: el, where: after ? 'after' : 'before', line: edgeLine(el, axis, after), box: null };
    }
    // Containers: a thin band at each edge means "next to", the middle means "inside".
    const edge = Math.min(extent * 0.25, 14);
    if (parent && !FIXED.has(tag)) {
      if (along < edge) return { ref: el, where: 'before', line: edgeLine(el, axis, false), box: null };
      if (along > extent - edge) return { ref: el, where: 'after', line: edgeLine(el, axis, true), box: null };
    }
    return placeInside(el, x, y, dragged);
  }

  function dropAddress(target: DropTarget): { ref: NodeId; where: Where } | null {
    const { ref, where } = target;
    if (ref.hasAttribute(DROP_ATTR)) return { ref: ref.getAttribute(DROP_ATTR)!, where: 'inside-end' };
    const id = where === 'before' || where === 'after' ? structIdOf(ref) : idOf(ref);
    return id ? { ref: id, where } : null;
  }

  // ----------------------------------------------------------- text editing

  function canEditText(el: Element): el is HTMLElement {
    if (!(el instanceof HTMLElement) || NO_CHILDREN.has(tagOf(el)) || FIXED.has(tagOf(el)) || tagOf(el).startsWith('w-')) return false;
    for (const child of Array.from(el.children)) if (!INLINE.has(tagOf(child))) return false;
    return true;
  }

  function cleanInner(el: Element): string {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) if (attr.name.startsWith('data-wp') || attr.name === 'contenteditable') node.removeAttribute(attr.name);
    });
    return clone.innerHTML;
  }

  function startEdit(el: HTMLElement, x: number, y: number) {
    editing = el;
    editSnapshot = cleanInner(el);
    el.setAttribute('contenteditable', 'true');
    el.focus({ preventScroll: true });
    const range = document.caretRangeFromPoint?.(x, y);
    if (range && el.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function endEdit(commit: boolean) {
    const el = editing;
    if (!el) return;
    editing = null;
    el.removeAttribute('contenteditable');
    el.blur();
    window.getSelection()?.removeAllRanges();
    const html = cleanInner(el);
    if (commit && html !== editSnapshot) {
      sendOp({ kind: 'setText', id: idOf(el)!, html });
    } else if (!commit && html !== editSnapshot) {
      // Cancelled: reload to restore the original content with its source ids intact.
      location.reload();
    }
  }

  // ----------------------------------------------------------------- events

  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  function onMouseDown(e: MouseEvent) {
    if (mode !== 'edit') return;
    // Events from inside the shadow tree are retargeted to its host, so ask the shadow root what was hit.
    const hit = e.target === uiHost ? (shadow.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) : null;
    if (e.target === uiHost && !hit?.classList.contains('handle')) return void stop(e);
    const handle = hit?.classList.contains('handle') ? hit : null;
    if (handle && selected instanceof HTMLElement) {
      stop(e);
      const r = selected.getBoundingClientRect();
      resize = { el: selected, dir: handle.dataset.dir!, x: e.clientX, y: e.clientY, w: r.width, h: r.height, ratio: r.height ? r.width / r.height : 1, snap: snapTargets(selected) };
      return;
    }
    if (editing) {
      if (editing.contains(e.target as Node)) return;
      endEdit(true);
    }
    if (e.button !== 0) return;
    stop(e);
    window.focus();
    const el = pick(e.clientX, e.clientY);
    if (el && el.hasAttribute(ID_ATTR)) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return toggle(el);
      // Pressing on a member of a multiple selection keeps the group, so it can be dragged as one.
      const inGroup = extras.length > 0 && (el === selected || extras.includes(el));
      press = { el, x: e.clientX, y: e.clientY, dragging: false, inGroup };
      if (!inGroup && (el !== selected || extras.length)) select(el, 'user');
    } else {
      select(null, 'user');
    }
  }

  /** Lines and sizes around an element that a resize can snap to. */
  function snapTargets(el: Element): SnapTargets {
    const targets: SnapTargets = { xs: [], ys: [], sizes: [] };
    const parent = el.parentElement;
    if (!parent) return targets;
    const pr = parent.getBoundingClientRect();
    const pcs = getComputedStyle(parent);
    // The inside edge of the parent: where the element would exactly fill it.
    targets.xs.push(pr.right - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderRightWidth));
    targets.ys.push(pr.bottom - parseFloat(pcs.paddingBottom) - parseFloat(pcs.borderBottomWidth));
    for (const sibling of Array.from(parent.children)) {
      if (sibling === el || sibling === uiHost || !sibling.getClientRects().length) continue;
      const r = sibling.getBoundingClientRect();
      targets.xs.push(r.left, r.right);
      targets.ys.push(r.top, r.bottom);
      targets.sizes.push({ el: sibling, w: r.width, h: r.height });
    }
    return targets;
  }

  function nearest(lines: number[], value: number): number | null {
    let best: number | null = null;
    for (const line of lines) {
      if (Math.abs(line - value) <= SNAP && (best === null || Math.abs(line - value) < Math.abs(best - value))) best = line;
    }
    return best;
  }

  function onMouseMove(e: MouseEvent) {
    if (mode !== 'edit') return;
    if (resize) {
      const dx = e.clientX - resize.x;
      const dy = e.clientY - resize.y;
      let w = resize.dir.includes('e') ? Math.max(8, Math.round(resize.w + dx)) : null;
      let h = resize.dir.includes('s') ? Math.max(8, Math.round(resize.h + dy)) : null;
      const keepRatio = resize.dir === 'se' && (tagOf(resize.el) === 'img' || tagOf(resize.el) === 'video' || e.shiftKey);
      // Snap the moving edge to nearby edges, or the size to a sibling's size. Hold Alt to resize freely.
      guides = [];
      matched = null;
      if (!e.altKey) {
        const box = resize.el.getBoundingClientRect();
        if (w !== null) {
          const line = nearest(resize.snap.xs, box.left + w);
          const same = resize.snap.sizes.find((size) => Math.abs(size.w - w!) <= SNAP);
          if (line !== null && line - box.left >= 8) {
            w = Math.round(line - box.left);
            guides.push({ x: line - 0.5, y: 0, w: 1, h: window.innerHeight });
          } else if (same) {
            w = Math.round(same.w);
            matched = same.el;
          }
        }
        if (h !== null && !keepRatio) {
          const line = nearest(resize.snap.ys, box.top + h);
          const same = resize.snap.sizes.find((size) => Math.abs(size.h - h!) <= SNAP);
          if (line !== null && line - box.top >= 8) {
            h = Math.round(line - box.top);
            guides.push({ x: 0, y: line - 0.5, w: window.innerWidth, h: 1 });
          } else if (same && !matched) {
            h = Math.round(same.h);
            matched = same.el;
          }
        }
      }
      if (keepRatio && w !== null) h = Math.max(8, Math.round(w / resize.ratio));
      if (w !== null) resize.el.style.width = `${w}px`;
      if (h !== null) resize.el.style.height = `${h}px`;
      const r = resize.el.getBoundingClientRect();
      sizeTag.style.display = 'block';
      sizeTag.textContent = `${Math.round(r.width)} x ${Math.round(r.height)}${matched ? ' - matches ' + labelOf(matched) : ''}`;
      return;
    }
    if (press) {
      if (!press.dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5 && !FIXED.has(tagOf(press.el))) {
        press.dragging = true;
        document.documentElement.style.cursor = 'grabbing';
      }
      if (press.dragging) drop = findDrop(e.clientX, e.clientY, press.inGroup ? group() : [press.el]);
      return;
    }
    if (!editing) hovered = pick(e.clientX, e.clientY);
  }

  function onMouseUp() {
    if (resize) {
      const styles: Record<string, string> = {};
      if (resize.dir.includes('e')) styles.width = resize.el.style.width;
      if (resize.el.style.height && (resize.dir.includes('s') || tagOf(resize.el) === 'img' || tagOf(resize.el) === 'video')) styles.height = resize.el.style.height;
      sizeTag.style.display = 'none';
      const el = resize.el;
      resize = null;
      guides = [];
      matched = null;
      sendOp({ kind: 'setStyles', id: idOf(el)!, styles });
      return;
    }
    if (press?.dragging && drop) {
      const address = dropAddress(drop);
      if (address && press.inGroup) {
        const ids = group().filter(movable).map(structIdOf);
        if (!ids.includes(address.ref)) sendOp({ kind: 'moveMany', ids, ref: address.ref, where: address.where });
      } else if (address) {
        const id = structIdOf(press.el);
        if (address.ref !== id) sendOp({ kind: 'move', id, ref: address.ref, where: address.where });
      }
    } else if (press && !press.dragging && press.inGroup) {
      // A plain click on one member of a multiple selection narrows the selection to it.
      select(press.el, 'user');
    }
    document.documentElement.style.cursor = '';
    press = null;
    drop = null;
  }

  function onClick(e: MouseEvent) {
    if (mode === 'interact') {
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin) return; // the workbench opens external links in the real browser
      if (url.pathname === location.pathname) return; // in-page anchor
      stop(e);
      post({ t: 'navigate', href: decodeURIComponent(url.pathname).replace(/^\/+/, '') });
      return;
    }
    if (editing && editing.contains(e.target as Node)) {
      e.preventDefault();
      return;
    }
    stop(e);
  }

  function onDoubleClick(e: MouseEvent) {
    if (mode !== 'edit' || editing) return;
    stop(e);
    const el = pick(e.clientX, e.clientY);
    if (el && canEditText(el)) {
      if (el !== selected) select(el, 'user');
      startEdit(el, e.clientX, e.clientY);
    } else if (el) {
      post({ t: 'notice', message: `Double-click edits text. <${tagOf(el)}> holds other elements, so select one of them instead.` });
    }
  }

  function onContextMenu(e: MouseEvent) {
    if (mode !== 'edit' || editing) return;
    stop(e);
    const el = pick(e.clientX, e.clientY);
    if (!el || !el.hasAttribute(ID_ATTR)) return;
    if (el !== selected && !extras.includes(el)) select(el, 'user');
    post({ t: 'menu', id: idOf(el)!, x: e.clientX, y: e.clientY });
  }

  function step(direction: 'parent' | 'child' | 'prev' | 'next') {
    if (!selected) return;
    let next: Element | null = null;
    if (direction === 'parent') next = selected.parentElement ? owner(selected.parentElement) : null;
    else if (direction === 'child') next = childrenWithIds(selected)[0] ?? null;
    else {
      const siblings = selected.parentElement ? childrenWithIds(selected.parentElement) : [];
      const at = siblings.indexOf(selected);
      next = siblings[at + (direction === 'next' ? 1 : -1)] ?? null;
    }
    if (next && next.hasAttribute(ID_ATTR)) select(next, 'user', true);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editing) {
      if (e.key === 'Escape') {
        stop(e);
        endEdit(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        stop(e);
        endEdit(true);
      } else if (e.key === 'Enter') {
        stop(e);
        document.execCommand('insertLineBreak');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        stop(e);
        endEdit(true);
        post({ t: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
      }
      return;
    }
    const combo = e.ctrlKey || e.metaKey;
    if (mode === 'edit' && selected && !combo) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        stop(e);
        const ids = group().filter(movable).map(structIdOf);
        if (ids.length > 1) sendOp({ kind: 'removeMany', ids });
        else if (ids.length) sendOp({ kind: 'remove', id: ids[0] });
        return;
      }
      // Escape first narrows a multiple selection to its primary element, then walks up to the parent.
      if (e.key === 'Escape') return void (stop(e), extras.length ? select(selected, 'user') : step('parent'));
      if (e.key === 'Enter' && canEditText(selected)) {
        stop(e);
        const r = selected.getBoundingClientRect();
        return startEdit(selected, r.left + 4, r.top + 4);
      }
      if (e.altKey && e.key === 'ArrowUp') return void (stop(e), step('parent'));
      if (e.altKey && e.key === 'ArrowDown') return void (stop(e), step('child'));
      if (e.altKey && e.key === 'ArrowLeft') return void (stop(e), step('prev'));
      if (e.altKey && e.key === 'ArrowRight') return void (stop(e), step('next'));
    }
    if (mode === 'edit' && selected && combo && (e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'g')) {
      stop(e);
      const ids = group().filter(movable).map(structIdOf);
      if (!ids.length) return;
      if (e.key.toLowerCase() === 'g') sendOp({ kind: 'group', ids });
      else if (ids.length > 1) sendOp({ kind: 'duplicateMany', ids });
      else sendOp({ kind: 'duplicate', id: ids[0] });
      return;
    }
    // Everything else with a modifier (save, undo, palette...) belongs to the workbench.
    if (combo || /^F\d+$/.test(e.key)) {
      const typingInPage = mode === 'interact' && /^(input|textarea|select)$/.test((e.target as Element)?.localName ?? '') && 'acvxz'.includes(e.key.toLowerCase());
      if (typingInPage) return;
      stop(e);
      post({ t: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    }
  }

  /**
   * Drags from the workbench's panels never reach this document as native drag
   * events: the workbench lays a shield over the canvas while dragging and
   * reports the pointer position instead. That keeps the gesture reliable
   * across the origin boundary and at any canvas zoom.
   */
  function dragOver(at: { x: number; y: number } | null) {
    if (mode !== 'edit' || !dragPayload || !at) {
      drop = null;
      return;
    }
    // Scroll when the pointer nears the top or bottom edge.
    if (at.y < 36) window.scrollBy(0, -14);
    else if (at.y > window.innerHeight - 36) window.scrollBy(0, 14);
    drop = findDrop(at.x, at.y, []);
  }

  function dragDrop(at: { x: number; y: number }) {
    if (mode !== 'edit' || !dragPayload) return;
    const target = findDrop(at.x, at.y, []);
    const address = target ? dropAddress(target) : null;
    if (address) sendOp({ kind: 'insert', ref: address.ref, where: address.where, payload: dragPayload });
    else post({ t: 'notice', message: 'That cannot be dropped there. Drop it on or next to an element of the page.' });
    drop = null;
    dragPayload = null;
  }

  function onPaste(e: ClipboardEvent) {
    if (!editing) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  }

  // ---------------------------------------------------------- host messages

  function findRule(href: string, ordinal: number, selector: string): CSSStyleRule | null {
    let found: CSSStyleRule | null = null;
    let fallback: CSSStyleRule | null = null;
    for (const sheet of pageSheets()) {
      if (sheetPath(sheet) !== href) continue;
      walkSheet(sheet, (rule, n) => {
        if (rule.selectorText !== selector) return;
        if (n === ordinal) found = rule;
        else fallback ??= rule;
      });
    }
    return found ?? fallback;
  }

  function refreshCss() {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'));
    let waiting = 0;
    const done = () => {
      if (--waiting <= 0 && selected) post({ t: 'select', info: describe(selected), by: 'host' });
    };
    for (const link of links) {
      let url: URL;
      try {
        url = new URL(link.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;
      url.searchParams.set('__v', String(Date.now()));
      // Load the fresh sheet beside the old one, then drop the old one: no unstyled flash.
      const fresh = link.cloneNode() as HTMLLinkElement;
      fresh.href = url.toString();
      waiting++;
      fresh.addEventListener('load', () => (link.remove(), done()), { once: true });
      fresh.addEventListener('error', () => (link.remove(), done()), { once: true });
      link.after(fresh);
    }
    if (!waiting && selected) post({ t: 'select', info: describe(selected), by: 'host' });
  }

  function onHostMessage(e: MessageEvent) {
    if (e.source !== window.parent) return;
    const msg = unwrap<HostMessage>(e.data);
    if (!msg) return;
    switch (msg.t) {
      case 'select': {
        const el = msg.id ? byId(msg.id) : null;
        if (el !== selected || extras.length) select(el, 'host', msg.reveal);
        break;
      }
      case 'preview-style': {
        const el = byId(msg.id) as HTMLElement | null;
        if (!el) break;
        for (const [prop, value] of Object.entries(msg.styles)) {
          if (value === null || value === '') el.style.removeProperty(prop);
          else el.style.setProperty(prop, value);
        }
        if (el === selected) post({ t: 'select', info: describe(el), by: 'host' });
        break;
      }
      case 'preview-rule': {
        const rule = findRule(msg.href, msg.ordinal, msg.selector);
        if (rule) {
          if (msg.value === null || msg.value === '') rule.style.removeProperty(msg.prop);
          else rule.style.setProperty(msg.prop, msg.value);
        }
        if (selected) post({ t: 'select', info: describe(selected), by: 'host' });
        break;
      }
      case 'preview-attr': {
        const el = byId(msg.id);
        if (!el || msg.name === 'style') break;
        if (msg.value === null) el.removeAttribute(msg.name);
        else el.setAttribute(msg.name, msg.value);
        if (el === selected) {
          updateChip();
          post({ t: 'select', info: describe(el), by: 'host' });
        }
        break;
      }
      case 'refresh-css':
        refreshCss();
        break;
      case 'mode':
        if (editing) endEdit(true);
        mode = msg.mode;
        hovered = null;
        document.documentElement.style.cursor = '';
        break;
      case 'drag-payload':
        dragPayload = msg.payload;
        if (!dragPayload) drop = null;
        break;
      case 'drag-over':
        dragOver(msg.at);
        break;
      case 'drag-drop':
        dragDrop(msg.at);
        break;
      case 'request-info':
        post({ t: 'select', info: selected?.isConnected ? describe(selected) : null, by: 'host' });
        break;
    }
  }

  // ------------------------------------------------------------------ start

  const scrollKey = `wovenpage-scroll:${boot.path}`;
  function restoreScroll() {
    try {
      const saved = sessionStorage.getItem(scrollKey);
      if (saved) {
        const [x, y] = saved.split(',').map(Number);
        window.scrollTo(x, y);
      }
    } catch {
      /* storage unavailable */
    }
  }

  window.addEventListener('message', onHostMessage);
  const capture = { capture: true } as const;
  window.addEventListener('mousedown', onMouseDown, capture);
  window.addEventListener('mousemove', onMouseMove, capture);
  window.addEventListener('mouseup', onMouseUp, capture);
  window.addEventListener('click', onClick, capture);
  window.addEventListener('auxclick', (e) => mode === 'edit' && stop(e), capture);
  window.addEventListener('dblclick', onDoubleClick, capture);
  window.addEventListener('contextmenu', onContextMenu, capture);
  window.addEventListener('keydown', onKeyDown, capture);
  window.addEventListener('submit', (e) => mode === 'edit' && stop(e), capture);
  window.addEventListener('dragstart', (e) => mode === 'edit' && stop(e), capture);
  window.addEventListener('paste', onPaste, capture);
  window.addEventListener('mouseleave', () => (hovered = null));
  document.addEventListener('mouseleave', () => (hovered = null));
  window.addEventListener('scroll', () => {
    try {
      sessionStorage.setItem(scrollKey, `${window.scrollX},${window.scrollY}`);
    } catch {
      /* storage unavailable */
    }
  }, { passive: true });

  function ready() {
    document.head.append(pageStyle);
    document.documentElement.append(uiHost);
    restoreScroll();
    if (boot.issues.length) {
      banner.style.display = 'block';
      banner.innerHTML = '';
      for (const issue of boot.issues.slice(0, 4)) {
        const row = document.createElement('div');
        const file = document.createElement('b');
        file.textContent = issue.file + ': ';
        row.append(file, issue.message);
        banner.append(row);
      }
    }
    requestAnimationFrame(frame);
    post({ t: 'ready', epoch: boot.epoch, files: boot.files, title: document.title, issues: boot.issues.map((i) => ({ file: i.file, message: i.message })) });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  window.addEventListener('load', restoreScroll, { once: true });
})();
