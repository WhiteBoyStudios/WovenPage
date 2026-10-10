/**
 * Owns one open site: its manifest, its files, and the watcher that notices
 * changes made outside the app. Everything it accepts and returns uses
 * site-root-relative forward-slash paths; `abs()` is the single place those
 * become OS paths, and it refuses anything that would leave the root.
 *
 * This class deliberately has no dependency on Electron so it can be unit
 * tested and reused from a command-line build.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import { applyEdits } from '../../shared/text';
import { basename, compiledCssPath, dirname, escapesRoot, extname, fileKind, isSass, isSassPartial, isTextFile, join, normalize } from '../../shared/paths';
import { collectFacts, parseCss } from '../../shared/css/model';
import { listParams, listSlots } from '../../shared/compose';
import { parseHtml, attrValue } from '../../shared/html/parse';
import { retargetLinks } from '../../shared/links';
import {
  FileStat,
  LayoutInfo,
  MANIFEST_FILE,
  PartInfo,
  ProjectChange,
  ProjectIndex,
  ProjectManifest,
  STATE_DIR,
  StarterKind,
  TreeNode,
} from '../../shared/types';
import { defaultManifest, starterFiles } from '../starter';

const ALWAYS_IGNORED = new Set(['node_modules', '.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db', STATE_DIR]);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export class ProjectError extends Error {}

export class ProjectService extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** Paths this process wrote recently, so the watcher can tell its own echoes apart. */
  private ownWrites = new Map<string, number>();
  private manifestOnDisk = false;

  private constructor(
    readonly root: string,
    public manifest: ProjectManifest,
  ) {
    super();
  }

  // ------------------------------------------------------------ lifecycle

  /** Opens any folder as a site. A manifest is only written once there is something to store in it. */
  static async open(root: string): Promise<ProjectService> {
    const abs = nodePath.resolve(root);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new ProjectError(`"${root}" is not a folder.`);
    let manifest = defaultManifest(nodePath.basename(abs));
    let onDisk = false;
    try {
      const raw = JSON.parse(await fsp.readFile(nodePath.join(abs, MANIFEST_FILE), 'utf8'));
      manifest = { ...manifest, ...raw, targets: Array.isArray(raw.targets) ? raw.targets : [] };
      onDisk = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ProjectError(`${MANIFEST_FILE} could not be read: ${(err as Error).message}`);
      }
    }
    const project = new ProjectService(abs, manifest);
    project.manifestOnDisk = onDisk;
    return project;
  }

  /** Creates a site in an empty (or new) folder and opens it. */
  static async create(root: string, name: string, starter: StarterKind): Promise<ProjectService> {
    const abs = nodePath.resolve(root);
    await fsp.mkdir(abs, { recursive: true });
    const existing = (await fsp.readdir(abs)).filter((n) => !ALWAYS_IGNORED.has(n));
    if (existing.length) throw new ProjectError('Choose an empty folder for a new site.');
    const project = new ProjectService(abs, defaultManifest(name));
    for (const [path, content] of Object.entries(starterFiles(starter))) {
      await project.write(path, content);
    }
    await project.saveManifest();
    return project;
  }

  async saveManifest(manifest?: ProjectManifest): Promise<void> {
    if (manifest) this.manifest = manifest;
    this.noteOwnWrite(MANIFEST_FILE);
    await fsp.writeFile(nodePath.join(this.root, MANIFEST_FILE), JSON.stringify(this.manifest, null, 2) + '\n', 'utf8');
    this.manifestOnDisk = true;
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.removeAllListeners();
  }

  // ----------------------------------------------------------------- paths

  /** Absolute OS path for a site-relative path. Throws if it would escape the site. */
  abs(path: string): string {
    const rel = normalize(path);
    if (escapesRoot(rel) || nodePath.isAbsolute(path)) throw new ProjectError(`"${path}" is outside the site folder.`);
    const full = nodePath.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) {
      throw new ProjectError(`"${path}" is outside the site folder.`);
    }
    return full;
  }

  /** Site-relative path for an absolute one, or null if it is outside the site. */
  rel(absolute: string): string | null {
    const r = nodePath.relative(this.root, absolute);
    if (r.startsWith('..') || nodePath.isAbsolute(r)) return null;
    return r.split(nodePath.sep).join('/');
  }

  isIgnored(path: string): boolean {
    const parts = normalize(path).split('/');
    if (parts.some((p) => ALWAYS_IGNORED.has(p))) return true;
    const out = normalize(this.manifest.outDir);
    return !!out && (parts[0] === out || normalize(path).startsWith(out + '/'));
  }

  existsSync(path: string): boolean {
    try {
      return fs.existsSync(this.abs(path));
    } catch {
      return false;
    }
  }

  /** Synchronous text read used by the composer. Returns null for a missing file. */
  readSync(path: string): string | null {
    try {
      return fs.readFileSync(this.abs(path), 'utf8');
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ tree

  async tree(): Promise<TreeNode> {
    const walk = async (rel: string): Promise<TreeNode[]> => {
      const entries = await fsp.readdir(this.abs(rel), { withFileTypes: true });
      const nodes: TreeNode[] = [];
      for (const entry of entries) {
        const path = join(rel, entry.name);
        if (this.isIgnored(path) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, path, dir: true, kind: 'folder', size: 0, mtime: 0, children: await walk(path) });
        } else if (entry.isFile()) {
          const stat = await fsp.stat(this.abs(path)).catch(() => null);
          nodes.push({ name: entry.name, path, dir: false, kind: fileKind(path), size: stat?.size ?? 0, mtime: stat?.mtimeMs ?? 0 });
        }
      }
      return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    };
    return { name: this.manifest.name, path: '', dir: true, kind: 'folder', size: 0, mtime: 0, children: await walk('') };
  }

  /** Every file in the site, depth-first, excluding ignored folders. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const visit = (node: TreeNode) => {
      if (!node.dir) out.push(node.path);
      node.children?.forEach(visit);
    };
    visit(await this.tree());
    return out;
  }

  // ----------------------------------------------------------------- files

  async read(path: string): Promise<{ text: string; mtime: number }> {
    const abs = this.abs(path);
    const stat = await fsp.stat(abs);
    if (stat.size > MAX_TEXT_BYTES) throw new ProjectError(`"${path}" is too large to open as text.`);
    return { text: await fsp.readFile(abs, 'utf8'), mtime: stat.mtimeMs };
  }

  async write(path: string, text: string): Promise<{ mtime: number }> {
    const abs = this.abs(path);
    await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
    this.noteOwnWrite(path);
    await fsp.writeFile(abs, text, 'utf8');
    return { mtime: (await fsp.stat(abs)).mtimeMs };
  }

  async stat(path: string): Promise<FileStat> {
    const stat = await fsp.stat(this.abs(path));
    return { path: normalize(path), size: stat.size, mtime: stat.mtimeMs, kind: fileKind(path) };
  }

  async createFile(path: string, content: string): Promise<string> {
    const rel = normalize(path);
    if (!rel) throw new ProjectError('Give the file a name.');
    if (fs.existsSync(this.abs(rel))) throw new ProjectError(`"${rel}" already exists.`);
    await this.write(rel, content);
    return rel;
  }

  async createFolder(path: string): Promise<string> {
    const rel = normalize(path);
    if (!rel) throw new ProjectError('Give the folder a name.');
    if (fs.existsSync(this.abs(rel))) throw new ProjectError(`"${rel}" already exists.`);
    this.noteOwnWrite(rel);
    await fsp.mkdir(this.abs(rel), { recursive: true });
    return rel;
  }

  /** A sibling path that does not exist yet: "hero.png" -> "hero-2.png". */
  freePath(path: string): string {
    const rel = normalize(path);
    if (!this.existsSync(rel)) return rel;
    const ext = extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!this.existsSync(candidate)) return candidate;
    }
  }

  async duplicate(path: string): Promise<string> {
    const target = this.freePath(path);
    this.noteOwnWrite(target);
    await fsp.cp(this.abs(path), this.abs(target), { recursive: true });
    return target;
  }

  /** Copies files from anywhere on disk into the site. Returns the new site-relative paths. */
  async importFiles(absolutePaths: string[], destDir: string): Promise<string[]> {
    const added: string[] = [];
    await fsp.mkdir(this.abs(destDir), { recursive: true });
    for (const source of absolutePaths) {
      const inside = this.rel(source);
      if (inside !== null && !this.isIgnored(inside)) {
        added.push(inside);
        continue;
      }
      const safeName = nodePath.basename(source).replace(/[^\w.\-() ]+/g, '-');
      const target = this.freePath(join(destDir, safeName));
      this.noteOwnWrite(target);
      await fsp.copyFile(source, this.abs(target));
      added.push(target);
    }
    return added;
  }

  /**
   * Renames or moves a file or folder. With `updateLinks`, every reference to
   * a moved file - and every relative link inside a moved file - is rewritten
   * so nothing breaks.
   */
  async rename(from: string, to: string, updateLinks: boolean): Promise<{ changed: string[] }> {
    const src = normalize(from);
    const dest = normalize(to);
    if (!src || !dest) throw new ProjectError('Give the file a name.');
    if (src === dest) return { changed: [] };
    if (dest.startsWith(src + '/')) throw new ProjectError('A folder cannot be moved inside itself.');
    const sameFileDifferentCase = src.toLowerCase() === dest.toLowerCase();
    if (fs.existsSync(this.abs(dest)) && !sameFileDifferentCase) throw new ProjectError(`"${dest}" already exists.`);

    const moves = new Map<string, string>();
    const stat = await fsp.stat(this.abs(src));
    const all = await this.listFiles();
    if (stat.isDirectory()) {
      for (const file of all) if (file.startsWith(src + '/')) moves.set(file, dest + file.slice(src.length));
    } else {
      moves.set(src, dest);
    }

    // Pages link the stylesheet a Sass file compiles to, so that link follows the Sass file.
    for (const [oldPath, newPath] of [...moves]) {
      if (isSass(oldPath) && !isSassPartial(oldPath) && !all.includes(compiledCssPath(oldPath))) moves.set(compiledCssPath(oldPath), compiledCssPath(newPath));
    }

    const rewrites: { path: string; text: string }[] = [];
    if (updateLinks) {
      for (const file of all) {
        const kind = fileKind(file);
        if (kind !== 'html' && kind !== 'css') continue;
        const text = this.readSync(file);
        if (text === null) continue;
        const newPath = moves.get(file) ?? file;
        const edits = retargetLinks(file, text, moves, newPath);
        if (edits.length) rewrites.push({ path: newPath, text: applyEdits(text, edits) });
      }
    }

    await fsp.mkdir(nodePath.dirname(this.abs(dest)), { recursive: true });
    this.noteOwnWrite(src);
    this.noteOwnWrite(dest);
    await fsp.rename(this.abs(src), this.abs(dest));
    for (const rewrite of rewrites) await this.write(rewrite.path, rewrite.text);
    return { changed: rewrites.map((r) => r.path) };
  }

  /** Permanently removes a path. The app layer prefers the recycle bin and only falls back to this. */
  async remove(path: string): Promise<void> {
    const rel = normalize(path);
    if (!rel) throw new ProjectError('The site folder itself cannot be deleted from here.');
    this.noteOwnWrite(rel);
    await fsp.rm(this.abs(rel), { recursive: true, force: true });
  }

  // ----------------------------------------------------------------- index

  /** Harvests names for completion, pickers and the Add panel. */
  async index(overlays: Record<string, string> = {}): Promise<ProjectIndex> {
    const files = await this.listFiles();
    const layoutsDir = normalize(this.manifest.layoutsDir) + '/';
    const partsDir = normalize(this.manifest.partsDir) + '/';
    const classes = new Set<string>();
    const ids = new Set<string>();
    const props = new Set<string>();
    const fonts = new Set<string>();
    const layouts: LayoutInfo[] = [];
    const parts: PartInfo[] = [];
    const pages: string[] = [];
    const stylesheets: string[] = [];
    const scripts: string[] = [];
    const text = (path: string) => overlays[path] ?? this.readSync(path) ?? '';
    const niceName = (path: string) => basename(path).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ');

    for (const file of files) {
      const kind = fileKind(file);
      if (kind === 'css') {
        stylesheets.push(file);
        // Sass line comments are not CSS; drop them so a stray brace or quote in one cannot skew the harvest.
        const sheet = isSass(file) ? text(file).replace(/(^|[^:])\/\/.*$/gm, '$1') : text(file);
        const facts = collectFacts(parseCss(sheet));
        facts.classes.forEach((c) => classes.add(c));
        facts.ids.forEach((c) => ids.add(c));
        facts.customProperties.forEach((c) => props.add(c));
        facts.fontFamilies.forEach((c) => fonts.add(c));
      } else if (kind === 'js') {
        scripts.push(file);
      } else if (kind === 'html') {
        const source = text(file);
        if (file.startsWith(layoutsDir)) {
          layouts.push({ path: file, name: niceName(file), slots: listSlots(source).map((s) => s.name), params: listParams(source) });
        } else if (file.startsWith(partsDir)) {
          parts.push({ path: file, name: niceName(file), params: listParams(source), hasSlot: listSlots(source).length > 0 });
        } else {
          pages.push(file);
        }
        for (const el of parseHtml(source).elements) {
          const id = attrValue(el, 'id');
          if (id && !id.includes('{{')) ids.add(id);
        }
      }
    }
    return {
      files,
      pages,
      stylesheets,
      scripts,
      layouts,
      parts,
      classes: [...classes].sort(),
      ids: [...ids].sort(),
      customProperties: [...props].sort(),
      fontFamilies: [...fonts].sort(),
    };
  }

  // --------------------------------------------------------------- watcher

  /** Starts emitting 'changed' (ProjectChange) when files change on disk. */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(nodePath.sep).join('/');
        if (this.isIgnored(rel)) return;
        this.pending.add(rel);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flush(), 120);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // Recursive watching is unavailable on a few filesystems; the app still
      // works, it just will not notice external edits until a manual refresh.
      this.watcher = null;
    }
  }

  private flush(): void {
    const now = Date.now();
    for (const [path, at] of this.ownWrites) if (now - at > 2500) this.ownWrites.delete(path);
    const paths = [...this.pending];
    this.pending.clear();
    if (!paths.length) return;
    const isOwn = (path: string) => {
      for (const own of this.ownWrites.keys()) {
        if (path === own || path.startsWith(own + '/') || own.startsWith(path + '/')) return true;
      }
      return false;
    };
    const change: ProjectChange = { paths, self: paths.every(isOwn) };
    this.emit('changed', change);
  }

  private noteOwnWrite(path: string): void {
    this.ownWrites.set(normalize(path), Date.now());
  }

  /** True for files the editor can open as text and that are small enough to read whole. */
  isSearchable(path: string, size: number): boolean {
    return isTextFile(path) && size <= MAX_TEXT_BYTES;
  }

  stateFile(name: string): string {
    return nodePath.join(this.root, STATE_DIR, name);
  }

  get hasManifest(): boolean {
    return this.manifestOnDisk;
  }

  dirOf(path: string): string {
    return dirname(normalize(path));
  }
}
