/**
 * What panels may ask of the workbench. Panels depend on this interface, not
 * on the Workbench class, which keeps each panel testable and replaceable.
 */

import type { InsertPayload, SelectionInfo } from '../../shared/protocol';
import type { ProjectDiagnostics, ProjectIndex, ProjectInfo, TreeNode } from '../../shared/types';
import type { CanvasController } from '../canvas/CanvasController';
import type { StyleWriter } from '../canvas/StyleWriter';
import type { CommandRegistry } from '../core/commands';
import type { Emitter } from '../core/events';
import type { DocumentStore } from '../documents/DocumentStore';
import type { CodeEditor } from '../editor/CodeEditor';

export type ViewMode = 'canvas' | 'split' | 'source';

export interface OpenOptions {
  line?: number;
  col?: number;
  length?: number;
  view?: ViewMode;
}

export interface Shell {
  readonly project: ProjectInfo;
  readonly docs: DocumentStore;
  readonly canvas: CanvasController;
  readonly editor: CodeEditor;
  readonly styles: StyleWriter;
  readonly commands: CommandRegistry;

  readonly onTree: Emitter<TreeNode>;
  readonly onIndex: Emitter<ProjectIndex>;
  /** The active tab changed (payload is its path, or null when no file is open). */
  readonly onActive: Emitter<string | null>;
  readonly onSelection: Emitter<SelectionInfo | null>;
  readonly onDiagnostics: Emitter<ProjectDiagnostics>;

  tree(): TreeNode | null;
  index(): ProjectIndex | null;
  activePath(): string | null;
  viewMode(): ViewMode;
  selection(): SelectionInfo | null;
  diagnostics(): ProjectDiagnostics;

  openFile(path: string, options?: OpenOptions): Promise<void>;
  closeFile(path: string): Promise<boolean>;
  refreshProject(): Promise<void>;
  notify(message: string, kind?: 'info' | 'success' | 'error'): void;
  previewUrl(path: string): string;

  /** Inserts something without dragging: next to the canvas selection, or at the caret in Source view. */
  insert(payload: InsertPayload): Promise<void>;
  /** Tells the canvas what is being dragged from a panel; null when the drag ends. */
  setDragPayload(payload: InsertPayload | null): void;
}
