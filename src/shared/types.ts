/** Data shapes shared by the main process and the renderer. */

import type { Diagnostic } from './lint';
import type { FileKind } from './paths';

export type { Diagnostic, FileKind };

export const MANIFEST_FILE = 'wovenpage.json';
/** Per-machine working data (deploy ledgers); never published. */
export const STATE_DIR = '.wovenpage';

export interface ProjectManifest {
  name: string;
  formatVersion: 1;
  /** Folder the published site is built into, relative to the site root. */
  outDir: string;
  layoutsDir: string;
  partsDir: string;
  assetsDir: string;
  targets: DeployTarget[];
}

export type DeployProtocol = 'sftp' | 'ftp' | 'ftps' | 'folder';

export interface DeployTarget {
  id: string;
  name: string;
  protocol: DeployProtocol;
  host: string;
  port: number;
  user: string;
  /** Remote directory (or local folder, for the folder protocol) that receives the site. */
  remoteRoot: string;
  auth: 'password' | 'key';
  /** Absolute path of a private key file, for SFTP key auth. */
  keyPath?: string;
  /** Remove remote files that this app uploaded earlier but the site no longer contains. */
  prune: boolean;
}

export interface TreeNode {
  name: string;
  /** Site-root-relative path; '' for the root. */
  path: string;
  dir: boolean;
  kind: FileKind | 'folder';
  size: number;
  mtime: number;
  children?: TreeNode[];
}

export interface ProjectInfo {
  root: string;
  manifest: ProjectManifest;
  previewOrigin: string;
}

export interface PartInfo {
  path: string;
  name: string;
  params: string[];
  hasSlot: boolean;
}

export interface LayoutInfo {
  path: string;
  name: string;
  slots: string[];
  params: string[];
}

/** Names harvested from the project, for completion and pickers. */
export interface ProjectIndex {
  files: string[];
  pages: string[];
  stylesheets: string[];
  scripts: string[];
  layouts: LayoutInfo[];
  parts: PartInfo[];
  classes: string[];
  ids: string[];
  customProperties: string[];
  fontFamilies: string[];
}

export interface SearchQuery {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Comma-separated globs, e.g. "*.html, css/**". Empty searches every text file. */
  include: string;
}

export interface SearchMatch {
  /** 1-based */
  line: number;
  /** 1-based */
  col: number;
  /** Absolute offsets in the file. */
  start: number;
  end: number;
  /** The line's text, trimmed to a window around the match. */
  preview: string;
  /** Offset of the match within `preview`. */
  previewStart: number;
  previewLength: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFileResult[];
  total: number;
  truncated: boolean;
  error?: string;
}

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
  kind: FileKind;
  width?: number;
  height?: number;
}

export interface ProjectChange {
  paths: string[];
  /** True when every change was written by this app. */
  self: boolean;
}

export interface BuildIssue {
  file: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface BuildResult {
  outDir: string;
  files: string[];
  pages: number;
  issues: BuildIssue[];
  ms: number;
}

export type PlanAction = 'upload' | 'delete' | 'skip';

export interface PlanItem {
  path: string;
  action: PlanAction;
  size: number;
  reason: 'new' | 'changed' | 'unchanged' | 'removed locally' | 'forced';
}

export interface DeployPlan {
  targetId: string;
  items: PlanItem[];
  uploadBytes: number;
  build: BuildResult;
  /** When this target last received a successful publish, if ever. */
  lastPublished: number | null;
}

export interface DeployProgress {
  targetId: string;
  phase: 'connecting' | 'uploading' | 'deleting' | 'done' | 'error';
  path?: string;
  done: number;
  total: number;
  message?: string;
}

export interface DeployResult {
  ok: boolean;
  uploaded: number;
  deleted: number;
  failed: { path: string; message: string }[];
  message?: string;
}

export type ProjectDiagnostics = Record<string, Diagnostic[]>;

export interface RecentProject {
  root: string;
  name: string;
  opened: number;
}

export type StarterKind = 'starter' | 'blank';

export interface AppSettings {
  theme: 'linen' | 'indigo';
  recent: RecentProject[];
  /** A site folder passed on the command line, to open at launch. */
  initialProject: string | null;
}
