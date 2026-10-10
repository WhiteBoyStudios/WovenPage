/**
 * The single source of truth for file contents while the app is open.
 *
 * Every open file is a Monaco text model. The code editor edits models
 * directly; the canvas, the inspector, rename and project-wide replace all
 * edit them through `applyEdits`. Because there is exactly one buffer per
 * file, the two views cannot drift apart, and every change - visual or typed -
 * lands on the same undo stack.
 *
 * The store also mirrors each buffer to the preview server as an overlay, so
 * previews reflect unsaved work.
 */

import { TextEdit, sortEdits } from '../../shared/text';
import { isTextFile } from '../../shared/paths';
import { api } from '../core/api';
import { Emitter } from '../core/events';
import { languageFor, monaco, uriFor } from '../editor/monacoSetup';

/**
 * Why a buffer changed. The canvas uses this to decide whether its element
 * ids are still valid: "canvas-stable" edits (a style or attribute change)
 * leave the element order untouched, everything else may not.
 */
export type ChangeSource = 'user' | 'canvas-stable' | 'canvas-struct' | 'external';

export interface Doc {
  path: string;
  model: monaco.editor.ITextModel;
  /** Model version at the last save or load. */
  savedVersion: number;
  mtime: number;
}

export interface DocChange {
  path: string;
  source: ChangeSource;
}

const OVERLAY_DELAY = 140;

export class DocumentStore {
  readonly onChange = new Emitter<DocChange>();
  readonly onDirtyChange = new Emitter<void>();
  readonly onSaved = new Emitter<string>();
  readonly onConflict = new Emitter<string>();

  private docs = new Map<string, Doc>();
  private loading = new Map<string, Promise<Doc>>();
  private source: ChangeSource = 'user';
  private overlayTimers = new Map<string, number>();
  private overlaySends = new Set<Promise<unknown>>();
  private lastDirtyCount = 0;

  get(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  all(): Doc[] {
    return [...this.docs.values()];
  }

  text(path: string): string | null {
    return this.docs.get(path)?.model.getValue() ?? null;
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path);
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  dirtyPaths(): string[] {
    return [...this.docs.keys()].filter((p) => this.isDirty(p));
  }

  /** Unsaved buffers, for services that must see what the user sees (search, lint, build). */
  dirtyOverlays(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of this.dirtyPaths()) out[path] = this.docs.get(path)!.model.getValue();
    return out;
  }

  /** Opens a file as a model, loading it from disk the first time. */
  open(path: string): Promise<Doc> {
    const existing = this.docs.get(path);
    if (existing) return Promise.resolve(existing);
    let pending = this.loading.get(path);
    if (!pending) {
      pending = this.load(path).finally(() => this.loading.delete(path));
      this.loading.set(path, pending);
    }
    return pending;
  }

  private async load(path: string): Promise<Doc> {
    if (!isTextFile(path)) throw new Error(`"${path}" is not a text file.`);
    const { text, mtime } = await api.readFile(path);
    const uri = uriFor(path);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(text, languageFor(path), uri);
    model.updateOptions({ tabSize: 2, insertSpaces: true });
    model.setEOL(text.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    const doc: Doc = { path, model, savedVersion: model.getAlternativeVersionId(), mtime };
    model.onDidChangeContent(() => {
      this.scheduleOverlay(path);
      this.onChange.emit({ path, source: this.source });
      this.noteDirty();
    });
    this.docs.set(path, doc);
    return doc;
  }

  /**
   * Applies text edits to a file as one undoable step. Offsets refer to the
   * model's current text.
   */
  applyEdits(path: string, edits: readonly TextEdit[], source: ChangeSource): void {
    const doc = this.docs.get(path);
    if (!doc) throw new Error(`"${path}" is not open.`);
    if (!edits.length) return;
    const model = doc.model;
    const operations = sortEdits(edits).map((edit) => {
      const start = model.getPositionAt(edit.start);
      const end = model.getPositionAt(edit.end);
      return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text, forceMoveMarkers: true };
    });
    this.withSource(source, () => {
      model.pushStackElement();
      model.pushEditOperations(null, operations, () => null);
      model.pushStackElement();
    });
  }

  /** Runs `fn` with model changes attributed to `source`. */
  withSource<T>(source: ChangeSource, fn: () => T): T {
    const previous = this.source;
    this.source = source;
    try {
      return fn();
    } finally {
      this.source = previous;
    }
  }

  async undo(path: string, source: ChangeSource): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    const previous = this.source;
    this.source = source;
    try {
      await doc.model.undo();
    } finally {
      this.source = previous;
    }
  }

  async redo(path: string, source: ChangeSource): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    const previous = this.source;
    this.source = source;
    try {
      await doc.model.redo();
    } finally {
      this.source = previous;
    }
  }

  async save(path: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    const version = doc.model.getAlternativeVersionId();
    const { mtime } = await api.writeFile(path, doc.model.getValue());
    doc.savedVersion = version;
    doc.mtime = mtime;
    this.onSaved.emit(path);
    this.noteDirty(true);
  }

  async saveAll(): Promise<number> {
    const dirty = this.dirtyPaths();
    for (const path of dirty) await this.save(path);
    return dirty.length;
  }

  close(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.docs.delete(path);
    const timer = this.overlayTimers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    this.overlayTimers.delete(path);
    doc.model.dispose();
    void api.clearOverlay(path).catch(() => undefined);
    this.noteDirty(true);
  }

  closeAll(): void {
    for (const path of [...this.docs.keys()]) this.close(path);
  }

  /** Forgets a file that was renamed or deleted on disk; any unsaved text is discarded. */
  forget(path: string): void {
    this.close(path);
  }

  /**
   * Reconciles open buffers with a change on disk. Clean buffers silently
   * take the new contents; a buffer with unsaved edits is left alone and a
   * conflict is reported instead.
   */
  async reconcile(paths: string[], selfInflicted: boolean): Promise<void> {
    for (const path of paths) {
      const doc = this.docs.get(path);
      if (!doc) continue;
      let disk: { text: string; mtime: number };
      try {
        disk = await api.readFile(path);
      } catch {
        continue; // deleted; the workbench closes the tab when the tree refreshes
      }
      if (disk.text === doc.model.getValue()) {
        doc.mtime = disk.mtime;
        continue;
      }
      if (this.isDirty(path)) {
        if (!selfInflicted) this.onConflict.emit(path);
        continue;
      }
      this.replaceContents(path, disk.text, disk.mtime);
    }
  }

  /** Replaces a buffer with what is on disk and marks it clean. */
  async revert(path: string): Promise<void> {
    const disk = await api.readFile(path);
    this.replaceContents(path, disk.text, disk.mtime);
  }

  private replaceContents(path: string, text: string, mtime: number): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.withSource('external', () => {
      doc.model.pushEditOperations(null, [{ range: doc.model.getFullModelRange(), text }], () => null);
      doc.model.pushStackElement();
    });
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.mtime = mtime;
    this.noteDirty(true);
  }

  // ------------------------------------------------------------- overlays

  private scheduleOverlay(path: string): void {
    const existing = this.overlayTimers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    this.overlayTimers.set(path, window.setTimeout(() => this.sendOverlay(path), OVERLAY_DELAY));
  }

  private sendOverlay(path: string): void {
    this.overlayTimers.delete(path);
    const doc = this.docs.get(path);
    if (!doc) return;
    const send = api.setOverlay(path, doc.model.getValue()).catch(() => undefined);
    this.overlaySends.add(send);
    void send.finally(() => this.overlaySends.delete(send));
  }

  /** Resolves once the preview server has every buffer's latest text. */
  async flushOverlays(): Promise<void> {
    for (const path of [...this.overlayTimers.keys()]) {
      clearTimeout(this.overlayTimers.get(path));
      this.sendOverlay(path);
    }
    await Promise.all([...this.overlaySends]);
  }

  private noteDirty(force = false): void {
    const count = this.dirtyPaths().length;
    if (count !== this.lastDirtyCount || force) {
      this.lastDirtyCount = count;
      void api.setDirtyCount(count).catch(() => undefined);
      this.onDirtyChange.emit();
    }
  }
}
