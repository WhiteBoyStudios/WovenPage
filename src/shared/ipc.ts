/**
 * The contract between the renderer and the main process.
 *
 * `Api` is implemented once in main (src/main/ipc.ts) and consumed through a
 * typed proxy in the renderer. The preload script forwards only the method
 * names listed in API_METHODS and the events in API_EVENTS, so the renderer
 * has no other way to reach Node or the file system.
 */

import type {
  AppSettings,
  BuildResult,
  DeployPlan,
  DeployProgress,
  DeployResult,
  DeployTarget,
  FileStat,
  ProjectChange,
  ProjectDiagnostics,
  ProjectIndex,
  ProjectInfo,
  ProjectManifest,
  SearchQuery,
  SearchResult,
  StarterKind,
  TreeNode,
} from './types';

export type Overlays = Record<string, string>;

export interface Api {
  // application
  getSettings(): Promise<AppSettings>;
  setTheme(theme: AppSettings['theme']): Promise<void>;
  setDirtyCount(count: number): Promise<void>;
  closeWindowNow(): Promise<void>;
  openExternal(url: string): Promise<void>;

  // project lifecycle
  openProjectDialog(): Promise<ProjectInfo | null>;
  openProject(root: string): Promise<ProjectInfo>;
  createProject(name: string, starter: StarterKind): Promise<ProjectInfo | null>;
  closeProject(): Promise<void>;
  saveManifest(manifest: ProjectManifest): Promise<void>;

  // files
  getTree(): Promise<TreeNode>;
  getIndex(overlays: Overlays): Promise<ProjectIndex>;
  readFile(path: string): Promise<{ text: string; mtime: number }>;
  writeFile(path: string, text: string): Promise<{ mtime: number }>;
  statFile(path: string): Promise<FileStat>;
  createFile(path: string, content: string): Promise<string>;
  createFolder(path: string): Promise<string>;
  renamePath(from: string, to: string, updateLinks: boolean): Promise<{ changed: string[] }>;
  duplicatePath(path: string): Promise<string>;
  deletePath(path: string): Promise<void>;
  importFilesDialog(destDir: string, kind: 'any' | 'media'): Promise<string[]>;
  revealPath(path: string): Promise<void>;
  pickFile(title: string): Promise<string | null>;
  pickFolder(title: string): Promise<string | null>;

  // preview
  setOverlay(path: string, text: string): Promise<void>;
  clearOverlay(path: string): Promise<void>;
  openInBrowser(path: string): Promise<void>;

  // search, validation, build
  search(query: SearchQuery, overlays: Overlays): Promise<SearchResult>;
  replaceInFiles(query: SearchQuery, replacement: string, paths: string[]): Promise<{ path: string; count: number }[]>;
  lintProject(overlays: Overlays): Promise<ProjectDiagnostics>;
  build(overlays: Overlays): Promise<BuildResult>;

  // publishing
  setTargetPassword(targetId: string, password: string | null): Promise<void>;
  hasTargetPassword(targetId: string): Promise<boolean>;
  testTarget(target: DeployTarget, password?: string): Promise<{ ok: boolean; message: string }>;
  planPublish(targetId: string, force: boolean, overlays: Overlays): Promise<DeployPlan>;
  publish(targetId: string, force: boolean, overlays: Overlays): Promise<DeployResult>;
  resetPublishHistory(targetId: string): Promise<void>;
}

export const API_METHODS: (keyof Api)[] = [
  'getSettings', 'setTheme', 'setDirtyCount', 'closeWindowNow', 'openExternal',
  'openProjectDialog', 'openProject', 'createProject', 'closeProject', 'saveManifest',
  'getTree', 'getIndex', 'readFile', 'writeFile', 'statFile', 'createFile', 'createFolder',
  'renamePath', 'duplicatePath', 'deletePath', 'importFilesDialog', 'revealPath', 'pickFile', 'pickFolder',
  'setOverlay', 'clearOverlay', 'openInBrowser',
  'search', 'replaceInFiles', 'lintProject', 'build',
  'setTargetPassword', 'hasTargetPassword', 'testTarget', 'planPublish', 'publish', 'resetPublishHistory',
];

export interface ApiEvents {
  /** Files changed on disk. */
  'project:changed': ProjectChange;
  /** A native menu item was chosen; the payload is a command id. */
  'menu:command': string;
  'deploy:progress': DeployProgress;
  /** The window wants to close but there are unsaved files; save them, then call closeWindowNow. */
  'app:save-and-close': null;
}

export const API_EVENTS: (keyof ApiEvents)[] = ['project:changed', 'menu:command', 'deploy:progress', 'app:save-and-close'];

export const IPC_INVOKE = 'wovenpage:invoke';
export const IPC_EVENT = 'wovenpage:event';

/** What the preload script exposes as `window.wovenpage`. */
export interface Bridge {
  invoke(method: keyof Api, args: unknown[]): Promise<unknown>;
  on<K extends keyof ApiEvents>(event: K, listener: (payload: ApiEvents[K]) => void): () => void;
  platform: string;
}
