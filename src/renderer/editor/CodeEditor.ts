/**
 * The source view: one Monaco editor instance that is pointed at whichever
 * document is active. Monaco supplies syntax highlighting, line numbers,
 * folding, auto-indent, bracket matching, multi-cursor, in-file find/replace
 * and language-aware completion; this class adds what is specific to
 * Wovenpage - per-file view state, cursor <-> canvas synchronisation, and the
 * highlight that shows which source range the canvas selection maps to.
 */

import { Emitter } from '../core/events';
import type { Doc } from '../documents/DocumentStore';
import { monaco, monacoTheme } from './monacoSetup';

export interface CursorInfo {
  path: string;
  offset: number;
  line: number;
  col: number;
  /** True when the user moved the caret (rather than an edit or the app moving it). */
  byUser: boolean;
}

export class CodeEditor {
  readonly onCursor = new Emitter<CursorInfo>();
  readonly editor: monaco.editor.IStandaloneCodeEditor;

  private doc: Doc | null = null;
  private viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private selectionMark: monaco.editor.IEditorDecorationsCollection;

  constructor(host: HTMLElement, theme: 'linen' | 'indigo') {
    this.editor = monaco.editor.create(host, {
      model: null,
      theme: monacoTheme(theme),
      automaticLayout: true,
      fontFamily: '"Commit Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      lineNumbers: 'on',
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'mouseover',
      autoIndent: 'full',
      formatOnPaste: true,
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      linkedEditing: true,
      bracketPairColorization: { enabled: false },
      guides: { indentation: true, bracketPairs: false },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      wordWrap: 'off',
      tabSize: 2,
      padding: { top: 10, bottom: 10 },
      suggest: { showWords: false },
      quickSuggestions: { other: true, comments: false, strings: true },
      stickyScroll: { enabled: false },
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    });
    this.selectionMark = this.editor.createDecorationsCollection();

    this.editor.onDidChangeCursorPosition((e) => {
      const model = this.editor.getModel();
      if (!model || !this.doc) return;
      const byUser = e.source === 'mouse' || e.source === 'keyboard';
      this.onCursor.emit({
        path: this.doc.path,
        offset: model.getOffsetAt(e.position),
        line: e.position.lineNumber,
        col: e.position.column,
        byUser,
      });
    });
  }

  get path(): string | null {
    return this.doc?.path ?? null;
  }

  setTheme(theme: 'linen' | 'indigo'): void {
    monaco.editor.setTheme(monacoTheme(theme));
  }

  /** Points the editor at a document, restoring its scroll position and selection. */
  show(doc: Doc | null): void {
    if (this.doc && this.doc !== doc) this.viewStates.set(this.doc.path, this.editor.saveViewState());
    this.doc = doc;
    this.selectionMark.clear();
    this.editor.setModel(doc?.model ?? null);
    if (doc) {
      const state = this.viewStates.get(doc.path);
      if (state) this.editor.restoreViewState(state);
    }
  }

  forget(path: string): void {
    this.viewStates.delete(path);
    if (this.doc?.path === path) this.show(null);
  }

  focus(): void {
    this.editor.focus();
  }

  hasFocus(): boolean {
    return this.editor.hasTextFocus();
  }

  /** Moves the caret to a position and brings it into view. */
  goTo(line: number, col = 1, length = 0): void {
    const model = this.editor.getModel();
    if (!model) return;
    const range = new monaco.Range(line, col, line, col + length);
    this.editor.setSelection(range);
    this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
    this.editor.focus();
  }

  /**
   * Marks the source range of the element selected on the canvas, without
   * stealing focus or moving the caret.
   */
  markRange(start: number, end: number, reveal: boolean): void {
    const model = this.editor.getModel();
    if (!model) return;
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(end);
    this.selectionMark.set([
      {
        range: new monaco.Range(from.lineNumber, 1, to.lineNumber, 1),
        options: { isWholeLine: true, className: 'wp-source-mark', linesDecorationsClassName: 'wp-source-mark-gutter' },
      },
    ]);
    if (reveal) this.editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(from.lineNumber, 1, Math.min(to.lineNumber, from.lineNumber + 12), 1), monaco.editor.ScrollType.Smooth);
  }

  clearMark(): void {
    this.selectionMark.clear();
  }

  /** Inserts text at the caret (used when adding a snippet or asset in Source view). */
  insertAtCursor(text: string): void {
    const selection = this.editor.getSelection();
    if (!selection) return;
    this.editor.pushUndoStop();
    this.editor.executeEdits('wovenpage', [{ range: selection, text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
    this.editor.focus();
  }

  run(actionId: string): void {
    this.editor.focus();
    void this.editor.getAction(actionId)?.run();
  }

  trigger(handlerId: string): void {
    this.editor.focus();
    this.editor.trigger('wovenpage', handlerId, null);
  }

  layout(): void {
    this.editor.layout();
  }
}
