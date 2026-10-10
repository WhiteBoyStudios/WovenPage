/**
 * The design view, seen from the workbench.
 *
 * It owns the iframe that shows the instrumented page, speaks the canvas
 * protocol with the agent inside it, and is the place where a visual
 * operation becomes a source edit:
 *
 *   agent: { kind: 'move', id: '0:14', ref: '0:9', where: 'before' }
 *     -> resolve ids to (file, element ordinal)
 *     -> shared patcher computes minimal text edits
 *     -> DocumentStore applies them to the Monaco model (undoable)
 *     -> preview overlay is flushed and the canvas reloads
 *
 * Epochs keep the two sides honest. Element ids are only meaningful for the
 * exact text they were generated from, so every change that could renumber
 * elements bumps the epoch, and operations from an older epoch are dropped.
 */

import { parseNodeId, makeNodeId, NodeId } from '../../shared/ids';
import { ElementNode, HtmlDoc, elementAt, innerText, outerText, parseHtml } from '../../shared/html/parse';
import {
  PatchError,
  PatchResult,
  combinedHtml,
  duplicateElement,
  duplicateElements,
  insertHtml,
  moveElement,
  moveElements,
  removeElement,
  removeElements,
  setAttribute,
  setInnerHtml,
  wrapElements,
} from '../../shared/html/patch';
import { rebaseUrls } from '../../shared/compose';
import { basename, dirname, fileKind, relative } from '../../shared/paths';
import { AgentMessage, CANVAS_QUERY, CanvasMode, CanvasOp, HostMessage, InsertPayload, SelectionInfo, unwrap, wrap } from '../../shared/protocol';
import { applyEdits, escapeAttr } from '../../shared/text';
import type { ProjectIndex } from '../../shared/types';
import type { KeyLike } from '../core/commands';
import { h } from '../core/dom';
import { Emitter } from '../core/events';
import type { DocumentStore } from '../documents/DocumentStore';
import type { StyleWriter } from './StyleWriter';

export interface Address {
  path: string;
  index: number;
}

export interface CanvasHost {
  index: () => ProjectIndex | null;
  notify: (message: string, kind?: 'info' | 'error') => void;
  styles: () => StyleWriter;
}

const CODE_RELOAD_DELAY = 320;

export class CanvasController {
  readonly el: HTMLElement;
  readonly onSelection = new Emitter<{ info: SelectionInfo | null; by: 'user' | 'host' }>();
  readonly onReady = new Emitter<{ files: string[]; title: string }>();
  readonly onNavigate = new Emitter<string>();
  readonly onKey = new Emitter<KeyLike>();
  readonly onMenu = new Emitter<{ info: SelectionInfo; x: number; y: number }>();
  readonly onSize = new Emitter<{ width: number; scale: number }>();

  private iframe: HTMLIFrameElement;
  private frame: HTMLElement;
  private stage: HTMLElement;
  private veil: HTMLElement;
  private shield: HTMLElement;
  private origin = '';
  private page: string | null = null;
  private visible = false;
  private stale = false;
  private epoch = 0;
  private readyEpoch = -1;
  private files: string[] = [];
  private selection: SelectionInfo | null = null;
  private wanted: (Address & { tag?: string }) | null = null;
  private mode: CanvasMode = 'edit';
  private width: number | null = null;
  private scale = 1;
  private reloadTimer: number | undefined;
  private cssTimer: number | undefined;
  private undoStack: string[][] = [];
  private redoStack: string[][] = [];
  private undoing = false;

  constructor(
    private readonly docs: DocumentStore,
    private readonly host: CanvasHost,
  ) {
    this.iframe = h<HTMLIFrameElement>('iframe.canvas__iframe', { title: 'Page canvas', sandbox: 'allow-scripts allow-same-origin allow-forms' });
    this.veil = h('div.canvas__veil', null, 'Loading page');
    this.shield = this.buildShield();
    this.frame = h('div.canvas__frame', null, this.iframe, this.veil, this.shield);
    this.stage = h('div.canvas__stage', null, this.frame);
    this.el = h('div.canvas', null, this.stage);

    window.addEventListener('message', (e) => this.onMessage(e));
    new ResizeObserver(() => this.fit()).observe(this.stage);
    docs.onChange.on((change) => this.onDocChange(change.path, change.source));
  }

  // ------------------------------------------------------------ lifecycle

  setOrigin(origin: string): void {
    this.origin = origin;
  }

  get currentPage(): string | null {
    return this.page;
  }

  get currentSelection(): SelectionInfo | null {
    return this.selection;
  }

  get currentMode(): CanvasMode {
    return this.mode;
  }

  get composedFiles(): string[] {
    return this.files;
  }

  /** Shows a page (or nothing). Reloads only if the page changed or the canvas is stale. */
  show(page: string | null): void {
    if (page === this.page && !this.stale) return;
    const changed = page !== this.page;
    this.page = page;
    if (changed) {
      this.selection = null;
      this.wanted = null;
      this.files = [];
      this.undoStack = [];
      this.redoStack = [];
      this.onSelection.emit({ info: null, by: 'host' });
    }
    if (!page) {
      this.iframe.src = 'about:blank';
      this.readyEpoch = -1;
      return;
    }
    if (this.visible) void this.reloadNow();
    else this.stale = true;
  }

  /** The canvas does no work while hidden (Source view); it catches up when shown again. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.stale && this.page) void this.reloadNow();
    if (visible) this.fit();
  }

  scheduleReload(delay: number): void {
    if (!this.page) return;
    if (!this.visible) {
      this.stale = true;
      return;
    }
    clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => void this.reloadNow(), delay);
  }

  async reloadNow(): Promise<void> {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    if (!this.page || !this.origin) return;
    this.stale = false;
    const page = this.page;
    const epoch = this.epoch;
    // Remember what was selected so it can be re-selected after the reload.
    if (!this.wanted && this.selection) {
      const address = this.resolve(this.selection.id);
      if (address) this.wanted = { ...address, tag: this.selection.tag };
    }
    await this.docs.flushOverlays();
    if (page !== this.page || epoch !== this.epoch) return this.reloadNow();
    this.veil.classList.add('is-on');
    const url = `${this.origin}/${page.split('/').map(encodeURIComponent).join('/')}?${CANVAS_QUERY}=canvas&e=${epoch}&t=${Date.now()}`;
    this.iframe.src = url;
  }

  private onDocChange(path: string, source: string): void {
    if (!this.page) return;
    if (!this.undoing && (source === 'user' || source === 'external')) {
      this.undoStack = [];
      this.redoStack = [];
    }
    const kind = fileKind(path);
    if (source === 'canvas-stable') return; // the canvas already shows this change
    if (kind === 'css') {
      clearTimeout(this.cssTimer);
      this.cssTimer = window.setTimeout(async () => {
        await this.docs.flushOverlays();
        this.post({ t: 'refresh-css' });
      }, source === 'canvas-struct' ? 0 : 160);
      return;
    }
    if (kind === 'html') this.epoch++;
    this.scheduleReload(source === 'canvas-struct' ? 0 : CODE_RELOAD_DELAY);
  }

  /** Files changed on disk that are not open in the editor (an image was replaced, say). */
  externalChange(paths: string[]): void {
    if (!this.page) return;
    if (paths.every((p) => fileKind(p) === 'css')) {
      this.post({ t: 'refresh-css' });
      return;
    }
    if (paths.some((p) => fileKind(p) === 'html')) this.epoch++;
    this.scheduleReload(200);
  }

  // ------------------------------------------------------------- messaging

  private post(message: HostMessage): void {
    if (!this.origin) return;
    this.iframe.contentWindow?.postMessage(wrap(message), this.origin);
  }

  private get inSync(): boolean {
    return this.readyEpoch === this.epoch && this.reloadTimer === undefined;
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== this.iframe.contentWindow || e.origin !== this.origin) return;
    const msg = unwrap<AgentMessage>(e.data);
    if (!msg) return;
    switch (msg.t) {
      case 'ready': {
        this.files = msg.files;
        this.readyEpoch = msg.epoch;
        this.veil.classList.remove('is-on');
        this.post({ t: 'mode', mode: this.mode });
        this.onReady.emit({ files: msg.files, title: msg.title });
        if (msg.epoch !== this.epoch) break; // a newer reload is on its way
        const wanted = this.wanted;
        this.wanted = null;
        this.selection = null;
        const id = wanted ? this.idFor(wanted, wanted.tag) : null;
        if (id) this.post({ t: 'select', id, reveal: true });
        else this.onSelection.emit({ info: null, by: 'host' });
        break;
      }
      case 'select':
        this.selection = msg.info;
        this.onSelection.emit({ info: msg.info, by: msg.by });
        break;
      case 'op':
        if (msg.epoch !== this.epoch || !this.inSync) {
          // The canvas was showing an older version of the source; discard and resync.
          this.scheduleReload(0);
          break;
        }
        void this.run(msg.op);
        break;
      case 'key':
        this.onKey.emit({ key: msg.key, code: msg.code, ctrlKey: msg.ctrl, shiftKey: msg.shift, altKey: msg.alt, metaKey: msg.meta });
        break;
      case 'navigate':
        this.onNavigate.emit(msg.href);
        break;
      case 'menu': {
        if (!this.selection) break;
        const r = this.iframe.getBoundingClientRect();
        this.onMenu.emit({ info: this.selection, x: r.left + msg.x * this.scale, y: r.top + msg.y * this.scale });
        break;
      }
      case 'notice':
        this.host.notify(msg.message);
        break;
    }
  }

  // ------------------------------------------------------------ addressing

  /** Turns a canvas id into the file and element ordinal it names. */
  resolve(id: NodeId): Address | null {
    const parsed = parseNodeId(id);
    if (!parsed) return null;
    const path = this.files[parsed.file];
    return path ? { path, index: parsed.index } : null;
  }

  /** The canvas id for a source address, if that file is part of the page on screen. */
  idFor(address: Address, expectTag?: string): NodeId | null {
    const file = this.files.indexOf(address.path);
    if (file === -1) return null;
    if (expectTag) {
      // A file that is not open has not changed, so its numbering is still valid.
      const text = this.docs.text(address.path);
      if (text !== null && parseHtml(text).elements[address.index]?.name !== expectTag) return null;
    }
    return makeNodeId(file, address.index);
  }

  // ---------------------------------------------------------- host actions

  select(address: Address | null, reveal = true): void {
    if (!address) return this.post({ t: 'select', id: null });
    const id = this.inSync ? this.idFor(address) : null;
    if (id) this.post({ t: 'select', id, reveal });
    else this.wanted = address;
  }

  selectId(id: NodeId): void {
    this.post({ t: 'select', id, reveal: true });
  }

  /** Selects the element whose source contains `offset` - the Source-to-Canvas half of selection sync. */
  selectAtOffset(path: string, offset: number): void {
    if (!this.inSync || this.files.indexOf(path) === -1) return;
    const text = this.docs.text(path);
    if (text === null) return;
    const el = elementAt(parseHtml(text), offset);
    if (!el) return;
    const id = this.idFor({ path, index: el.index });
    if (id && id !== this.selection?.id) this.post({ t: 'select', id, reveal: true });
  }

  previewStyle(id: NodeId, styles: Record<string, string | null>): void {
    this.post({ t: 'preview-style', id, styles });
  }

  previewRule(href: string, ordinal: number, selector: string, prop: string, value: string | null): void {
    this.post({ t: 'preview-rule', href, ordinal, selector, prop, value });
  }

  refreshInfo(): void {
    this.post({ t: 'request-info' });
  }

  setMode(mode: CanvasMode): void {
    this.mode = mode;
    this.el.classList.toggle('is-interact', mode === 'interact');
    this.post({ t: 'mode', mode });
  }

  /**
   * Announces what is being dragged from a panel (null when the drag ends).
   * While a drag is in progress a transparent shield covers the iframe, so the
   * drag events arrive in this document and are relayed as coordinates.
   */
  setDragPayload(payload: InsertPayload | null): void {
    if (payload) {
      this.post({ t: 'drag-payload', payload });
      this.shield.classList.add('is-on');
      return;
    }
    this.shield.classList.remove('is-on');
    // A drop is processed before the drag ends; clear the payload a moment later so they cannot race.
    window.setTimeout(() => this.post({ t: 'drag-payload', payload: null }), 120);
  }

  private buildShield(): HTMLElement {
    const shield = h('div.canvas__shield');
    const point = (e: DragEvent) => {
      const r = this.iframe.getBoundingClientRect();
      return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
    };
    shield.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.post({ t: 'drag-over', at: point(e) });
    });
    shield.addEventListener('dragleave', () => this.post({ t: 'drag-over', at: null }));
    shield.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!this.inSync) {
        this.host.notify('The canvas is still catching up with the source. Try again in a moment.');
        return;
      }
      this.post({ t: 'drag-drop', at: point(e) });
    });
    return shield;
  }

  /** Device width in CSS pixels, or null to fill the available space. */
  setWidth(width: number | null): void {
    this.width = width;
    this.fit();
  }

  private fit(): void {
    const available = this.stage.clientWidth - 32;
    const height = this.stage.clientHeight - 32;
    if (available <= 0 || height <= 0) return;
    const width = this.width ?? available;
    this.scale = Math.min(1, available / width);
    this.frame.style.width = `${width}px`;
    this.frame.style.height = `${height / this.scale}px`;
    this.frame.style.transform = this.scale < 1 ? `scale(${this.scale})` : '';
    this.frame.style.marginBottom = this.scale < 1 ? `${-(height / this.scale) * (1 - this.scale)}px` : '';
    this.el.classList.toggle('is-device', this.width !== null);
    this.onSize.emit({ width: Math.round(width), scale: this.scale });
  }

  /** Sets an attribute on the selected element, in source and on the canvas. */
  async setAttribute(info: SelectionInfo, name: string, value: string | null): Promise<void> {
    const address = this.resolve(info.id);
    if (!address) return;
    const doc = await this.docs.open(address.path);
    const result = setAttribute(parseHtml(doc.model.getValue()), address.index, name, value);
    this.docs.applyEdits(address.path, result.edits, 'canvas-stable');
    this.noteEdit([address.path]);
    this.post({ t: 'preview-attr', id: info.id, name, value });
  }

  // ------------------------------------------------------------ operations

  /** Records which files an edit touched, so Undo on the canvas reverses it. */
  noteEdit(paths: string[]): void {
    this.undoStack.push(paths);
    this.redoStack = [];
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  async undo(): Promise<boolean> {
    const paths = this.undoStack.pop();
    if (!paths) return false;
    this.undoing = true;
    try {
      for (const path of [...paths].reverse()) await this.docs.undo(path, 'user');
    } finally {
      this.undoing = false;
    }
    this.redoStack.push(paths);
    return true;
  }

  async redo(): Promise<boolean> {
    const paths = this.redoStack.pop();
    if (!paths) return false;
    this.undoing = true;
    try {
      for (const path of paths) await this.docs.redo(path, 'user');
    } finally {
      this.undoing = false;
    }
    this.undoStack.push(paths);
    return true;
  }

  private async parsed(path: string): Promise<HtmlDoc> {
    const doc = await this.docs.open(path);
    return parseHtml(doc.model.getValue());
  }

  /** Applies a patch and arranges for the affected element to be selected after the reload. */
  private commit(path: string, parsed: HtmlDoc, result: PatchResult, stable = false): void {
    if (!result.edits.length) return;
    const next = applyEdits(parsed.text, result.edits);
    const focus = elementAt(parseHtml(next), result.focus);
    if (!stable) this.wanted = focus ? { path, index: focus.index } : null;
    this.docs.applyEdits(path, result.edits, stable ? 'canvas-stable' : 'canvas-struct');
  }

  markupFor(payload: InsertPayload, targetFile: string): string | null {
    if (payload.type === 'html') return payload.html;
    if (payload.type === 'part') {
      const part = this.host.index()?.parts.find((p) => p.path === payload.path);
      const params = (part?.params ?? []).map((p) => ` ${p}="${escapeAttr(p.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()))}"`).join('');
      return `<w-part src="${payload.path}"${params}></w-part>`;
    }
    const url = encodeURI(relative(dirname(targetFile), payload.path));
    const name = basename(payload.path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    switch (fileKind(payload.path)) {
      case 'image':
        return `<img src="${url}" alt="${escapeAttr(name)}">`;
      case 'video':
        return `<video src="${url}" controls></video>`;
      case 'audio':
        return `<audio src="${url}" controls></audio>`;
      case 'html':
        return `<a href="${url}">${name}</a>`;
      case 'font':
        this.host.notify('Fonts are added to a stylesheet, not to the page. Use "Use this font" in the Assets panel.');
        return null;
      default:
        return `<a href="${url}">${basename(payload.path)}</a>`;
    }
  }

  /** Runs one canvas operation against the source. Also callable from menus and shortcuts. */
  async run(op: CanvasOp): Promise<void> {
    try {
      await this.apply(op);
    } catch (err) {
      this.host.notify(err instanceof PatchError || err instanceof Error ? err.message : String(err), 'error');
      this.scheduleReload(0);
    }
  }

  private async apply(op: CanvasOp): Promise<void> {
    switch (op.kind) {
      case 'setStyles': {
        const info = this.selection;
        if (!info || info.id !== op.id) throw new Error('Select the element again and retry.');
        const styles = this.host.styles();
        const toRule = styles.targetFor(info).type === 'rule';
        const edited = await styles.set(info, op.styles, true);
        this.noteEdit(edited);
        // The drag left pixel sizes inline on the canvas; if they were written
        // to a rule instead, reload so the canvas matches the source exactly.
        if (toRule) this.scheduleReload(0);
        else this.refreshInfo();
        return;
      }
      case 'setText': {
        const at = this.need(op.id);
        const parsed = await this.parsed(at.path);
        const el = this.element(parsed, at.index);
        if (innerText(parsed, el).includes('{{')) {
          this.scheduleReload(0);
          throw new Error(`This text comes from a part parameter. Change it on the <w-part> that uses ${at.path}, or edit the part in Source view.`);
        }
        const stable = el.children.length === 0 && !/<[a-zA-Z]/.test(op.html);
        this.commit(at.path, parsed, setInnerHtml(parsed, at.index, op.html), stable);
        this.noteEdit([at.path]);
        return;
      }
      case 'remove': {
        const at = this.need(op.id);
        const parsed = await this.parsed(at.path);
        this.commit(at.path, parsed, removeElement(parsed, at.index));
        this.noteEdit([at.path]);
        return;
      }
      case 'duplicate': {
        const at = this.need(op.id);
        const parsed = await this.parsed(at.path);
        this.commit(at.path, parsed, duplicateElement(parsed, at.index));
        this.noteEdit([at.path]);
        return;
      }
      case 'insert': {
        const at = this.need(op.ref);
        const html = this.markupFor(op.payload, at.path);
        if (html === null) return;
        const parsed = await this.parsed(at.path);
        this.commit(at.path, parsed, insertHtml(parsed, at.index, op.where, html));
        this.noteEdit([at.path]);
        return;
      }
      case 'removeMany': {
        const files = this.byFile(op.ids);
        for (const [path, indices] of files) {
          const parsed = await this.parsed(path);
          this.commit(path, parsed, removeElements(parsed, indices));
        }
        this.noteEdit([...files.keys()]);
        return;
      }
      case 'duplicateMany': {
        const files = this.byFile(op.ids);
        for (const [path, indices] of files) {
          const parsed = await this.parsed(path);
          this.commit(path, parsed, duplicateElements(parsed, indices));
        }
        this.noteEdit([...files.keys()]);
        return;
      }
      case 'group': {
        const files = this.byFile(op.ids);
        if (files.size !== 1) throw new Error('These elements live in different files, so they cannot share a box. Group elements from one file at a time.');
        const [[path, indices]] = [...files];
        const parsed = await this.parsed(path);
        this.commit(path, parsed, wrapElements(parsed, indices, '<div>', '</div>'));
        this.noteEdit([path]);
        return;
      }
      case 'moveMany': {
        const files = this.byFile(op.ids);
        const to = this.need(op.ref);
        if (files.size === 1 && files.has(to.path)) {
          const parsed = await this.parsed(to.path);
          this.commit(to.path, parsed, moveElements(parsed, files.get(to.path)!, to.index, op.where));
          this.noteEdit([to.path]);
          return;
        }
        // Across files: gather the markup (rebased to its new home), insert it once, then remove the originals.
        const pieces: string[] = [];
        for (const [path, indices] of files) {
          if (path === to.path) throw new Error('Move elements that share a file with the target separately from the others.');
          pieces.push(rebaseUrls(combinedHtml(await this.parsed(path), indices), dirname(path), dirname(to.path)));
        }
        const target = await this.parsed(to.path);
        this.commit(to.path, target, insertHtml(target, to.index, op.where, pieces.join('\n')));
        const wanted = this.wanted;
        for (const [path, indices] of files) {
          const parsed = await this.parsed(path);
          this.commit(path, parsed, removeElements(parsed, indices));
        }
        this.wanted = wanted;
        this.noteEdit([to.path, ...files.keys()]);
        return;
      }
      case 'move': {
        const from = this.need(op.id);
        const to = this.need(op.ref);
        if (from.path === to.path) {
          const parsed = await this.parsed(from.path);
          this.commit(from.path, parsed, moveElement(parsed, from.index, to.index, op.where));
          this.noteEdit([from.path]);
          return;
        }
        // Across files: copy into the destination (rebasing its URLs), then remove from the origin.
        const source = await this.parsed(from.path);
        const target = await this.parsed(to.path);
        const html = rebaseUrls(outerText(source, this.element(source, from.index)), dirname(from.path), dirname(to.path));
        this.commit(to.path, target, insertHtml(target, to.index, op.where, html));
        const again = await this.parsed(from.path);
        const wanted = this.wanted;
        this.commit(from.path, again, removeElement(again, from.index));
        this.wanted = wanted;
        this.noteEdit([to.path, from.path]);
        return;
      }
    }
  }

  /** Resolves a multiple selection and buckets it by file, preserving first-seen file order. */
  private byFile(ids: NodeId[]): Map<string, number[]> {
    const files = new Map<string, number[]>();
    for (const id of ids) {
      const at = this.need(id);
      const list = files.get(at.path) ?? [];
      list.push(at.index);
      files.set(at.path, list);
    }
    return files;
  }

  private need(id: NodeId): Address {
    const address = this.resolve(id);
    if (!address) throw new Error('That element is not part of a file in this site.');
    return address;
  }

  private element(parsed: HtmlDoc, index: number): ElementNode {
    const el = parsed.elements[index];
    if (!el) throw new PatchError('The source changed under the canvas. Reloading.');
    return el;
  }
}
