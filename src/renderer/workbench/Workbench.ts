/**
 * The workbench: builds the window layout for an open site and connects the
 * pieces - documents, code editor, canvas, inspector and side panels. It is
 * deliberately thin on logic of its own; behaviour lives in the commands it
 * registers and in the modules it wires together.
 */

import { parseHtml } from '../../shared/html/parse';
import { basename, extname, fileKind, isTextFile, normalize, sassSourcePath } from '../../shared/paths';
import type { InsertPayload, SelectionInfo } from '../../shared/protocol';
import type { AppSettings, ProjectChange, ProjectDiagnostics, ProjectIndex, ProjectInfo, TreeNode } from '../../shared/types';
import { CanvasController } from '../canvas/CanvasController';
import { StyleWriter } from '../canvas/StyleWriter';
import { api, onEvent } from '../core/api';
import { CommandRegistry, chordOf } from '../core/commands';
import { clear, debounce, dragResize, h } from '../core/dom';
import { Emitter } from '../core/events';
import { IconName, fileIcon, icon } from '../core/icons';
import { MenuItem, closeMenu, openModal, quickPick, showMenu, showMenuBelow, toast } from '../core/ui';
import { DocumentStore } from '../documents/DocumentStore';
import { CodeEditor } from '../editor/CodeEditor';
import { Diagnostics } from '../editor/diagnostics';
import { AddPanel } from '../panels/AddPanel';
import { AssetView } from '../panels/AssetView';
import { AssetsPanel } from '../panels/AssetsPanel';
import { FilesPanel } from '../panels/FilesPanel';
import { Inspector } from '../panels/Inspector';
import { weaveMark } from '../panels/Launcher';
import { OutlinePanel } from '../panels/OutlinePanel';
import { ProblemsPanel } from '../panels/ProblemsPanel';
import { openPublishDialog } from '../panels/PublishDialog';
import { SearchPanel } from '../panels/SearchPanel';
import type { OpenOptions, Shell, ViewMode } from './Shell';
import * as actions from './fileActions';

type DockId = 'site' | 'add' | 'assets' | 'search' | 'outline';

const DOCKS: { id: DockId; label: string; icon: IconName }[] = [
  { id: 'site', label: 'Site files', icon: 'site' },
  { id: 'add', label: 'Add elements and parts', icon: 'add' },
  { id: 'assets', label: 'Assets', icon: 'assets' },
  { id: 'search', label: 'Find in site', icon: 'search' },
  { id: 'outline', label: 'Outline', icon: 'outline' },
];

const DEVICES: { label: string; width: number | null; icon: IconName }[] = [
  { label: 'Fill the space', width: null, icon: 'fluid' },
  { label: 'Phone, 390 px', width: 390, icon: 'phone' },
  { label: 'Tablet, 820 px', width: 820, icon: 'tablet' },
  { label: 'Laptop, 1280 px', width: 1280, icon: 'laptop' },
];

export class Workbench implements Shell {
  readonly el: HTMLElement;
  readonly docs = new DocumentStore();
  readonly commands = new CommandRegistry();
  readonly canvas: CanvasController;
  readonly editor: CodeEditor;
  readonly styles: StyleWriter;

  readonly onTree = new Emitter<TreeNode>();
  readonly onIndex = new Emitter<ProjectIndex>();
  readonly onActive = new Emitter<string | null>();
  readonly onSelection = new Emitter<SelectionInfo | null>();
  readonly onDiagnostics = new Emitter<ProjectDiagnostics>();

  private treeData: TreeNode | null = null;
  private indexData: ProjectIndex | null = null;
  private problems: ProjectDiagnostics = {};
  private tabs: string[] = [];
  private active: string | null = null;
  private lastHtml: string | null = null;
  private modes = new Map<string, ViewMode>();
  private mode: ViewMode = 'split';
  private selected: SelectionInfo | null = null;
  private dock: DockId = 'site';
  private theme: AppSettings['theme'];
  private disposers: (() => void)[] = [];

  private tabStrip = h('div.tabs', { role: 'tablist', 'aria-label': 'Open files' });
  private dockHost = h('div.dock');
  private railButtons = new Map<DockId, HTMLElement>();
  private modeButtons = new Map<ViewMode, HTMLElement>();
  private deviceButtons: HTMLElement[] = [];
  private interactButton!: HTMLElement;
  private bar = h('div.bar');
  private barInfo = h('div.bar__info');
  private area = h('div.work__area');
  private sourceHost = h('div.work__source');
  private emptyHost = h('div.work__empty');
  private crumbs = h('div.status__crumbs', { 'aria-label': 'Selected element path' });
  private statusProblems = h('button.status__item', { type: 'button', title: 'Show problems (Ctrl+Shift+M)' });
  private statusCursor = h('span.status__item');
  private statusSaved = h('span.status__item');
  private drawer = h('div.drawer');
  private assetView: AssetView;
  private searchPanel: SearchPanel;
  private diagnosticsRunner: Diagnostics;

  constructor(
    readonly project: ProjectInfo,
    settings: AppSettings,
    private readonly onExit: () => void,
  ) {
    this.theme = settings.theme;
    this.commands.setErrorHandler((message) => this.notify(message, 'error'));

    this.styles = new StyleWriter(this.docs, () => this.canvas, (path) => !this.indexData || this.indexData.files.includes(path));
    this.canvas = new CanvasController(this.docs, {
      index: () => this.indexData,
      notify: (message, kind) => this.notify(message, kind),
      styles: () => this.styles,
    });
    this.canvas.setOrigin(project.previewOrigin);
    this.editor = new CodeEditor(this.sourceHost, this.theme);
    this.assetView = new AssetView(this);
    this.diagnosticsRunner = new Diagnostics(this.docs, () => {
      const files = this.indexData ? new Set(this.indexData.files) : null;
      // "blog/" resolves to its index page, so a folder counts as existing too.
      return files ? (path) => files.has(path) || files.has(sassSourcePath(path)) || [...files].some((f) => f.startsWith(path + '/')) : null;
    });

    const files = new FilesPanel(this);
    const add = new AddPanel(this);
    const assets = new AssetsPanel(this);
    this.searchPanel = new SearchPanel(this);
    const outline = new OutlinePanel(this);
    const panels: Record<DockId, HTMLElement> = { site: files.el, add: add.el, assets: assets.el, search: this.searchPanel.el, outline: outline.el };
    for (const [id, el] of Object.entries(panels)) {
      el.dataset.dock = id;
      this.dockHost.append(el);
    }
    const inspector = new Inspector(this);
    const problemsPanel = new ProblemsPanel(this);
    problemsPanel.onCounts(({ errors, warnings }) => {
      clear(this.statusProblems);
      this.statusProblems.append(icon(errors ? 'error' : warnings ? 'warning' : 'check', 14), errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'No problems');
      this.statusProblems.classList.toggle('is-error', errors > 0);
    });
    this.statusProblems.append(icon('check', 14), 'No problems');
    this.statusProblems.addEventListener('click', () => void this.commands.run('view.problems'));
    this.drawer.append(problemsPanel.el);

    this.el = this.build(inspector.el);
    this.registerCommands();
    this.wire();
    this.applyTheme();
    this.showDock('site');
    this.applyView();
  }

  // ------------------------------------------------------------------ Shell

  tree = () => this.treeData;
  index = () => this.indexData;
  activePath = () => this.active;
  viewMode = () => this.mode;
  selection = () => this.selected;
  diagnostics = () => this.problems;
  previewUrl = (path: string) => `${this.project.previewOrigin}/${normalize(path).split('/').map(encodeURIComponent).join('/')}`;

  notify(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    toast(message, { kind });
  }

  setDragPayload(payload: InsertPayload | null): void {
    this.canvas.setDragPayload(payload);
    this.el.classList.toggle('is-dragging-in', payload !== null);
  }

  async insert(payload: InsertPayload): Promise<void> {
    const active = this.active;
    if (!active || fileKind(active) !== 'html') return this.notify('Open a page first.', 'error');
    if (this.mode === 'source') {
      const markup = this.canvas.markupFor(payload, active);
      if (markup !== null) this.editor.insertAtCursor(markup);
      return;
    }
    const sel = this.selected;
    if (!sel) return this.notify('Select an element on the canvas to insert after, or drag this onto the page.');
    // An empty container receives the new element; anything else gets it as the next sibling.
    const address = this.canvas.resolve(sel.id);
    const text = address ? this.docs.text(address.path) : null;
    const el = address && text !== null ? parseHtml(text).elements[address.index] : null;
    const emptyContainer = !!el && sel.canHoldChildren && el.children.length === 0 && !text!.slice(el.openEnd, el.closeStart).trim();
    if (sel.tag === 'body' || emptyContainer) await this.canvas.run({ kind: 'insert', ref: sel.id, where: 'inside-end', payload });
    else await this.canvas.run({ kind: 'insert', ref: sel.structId, where: 'after', payload });
  }

  async refreshProject(): Promise<void> {
    this.treeData = await api.getTree();
    this.onTree.emit(this.treeData);
    await this.refreshIndex();
    // Close tabs whose files are gone.
    const known = new Set(this.indexData?.files ?? []);
    for (const path of [...this.tabs]) {
      if (!known.has(path) && !this.docs.isDirty(path)) this.dropTab(path);
    }
  }

  private async refreshIndex(): Promise<void> {
    this.indexData = await api.getIndex(this.docs.dirtyOverlays());
    this.onIndex.emit(this.indexData);
    this.diagnosticsRunner.checkAll();
  }

  async openFile(path: string, options: OpenOptions = {}): Promise<void> {
    path = normalize(path);
    if (isTextFile(path)) await this.docs.open(path);
    if (!this.tabs.includes(path)) this.tabs.push(path);
    if (options.view && fileKind(path) === 'html') this.modes.set(path, options.view);
    else if (options.line && fileKind(path) === 'html' && (this.modes.get(path) ?? this.mode) === 'canvas') this.modes.set(path, 'split');
    this.activate(path);
    if (options.line) this.editor.goTo(options.line, options.col ?? 1, options.length ?? 0);
  }

  async closeFile(path: string): Promise<boolean> {
    let discarded = false;
    if (this.docs.isDirty(path)) {
      const answer = await this.askSave(basename(path));
      if (answer === 'cancel') return false;
      if (answer === 'save') await this.docs.save(path);
      else discarded = true;
    }
    this.dropTab(path);
    // Discarded edits were visible in the preview; bring the canvas back in line with the file on disk.
    if (discarded) window.setTimeout(() => this.canvas.externalChange([path]), 200);
    return true;
  }

  // ----------------------------------------------------------------- build

  private build(inspector: HTMLElement): HTMLElement {
    const siteButton = h('button.top__site', { type: 'button', title: this.project.root, 'aria-haspopup': 'menu' }, weaveMark(22), h('span', null, this.project.manifest.name), icon('chevronDown', 12));
    siteButton.addEventListener('click', () =>
      showMenuBelow(siteButton, [
        { label: 'New site...', run: () => void this.commands.run('file.newSite') },
        { label: 'Open another site...', hint: 'Ctrl+O', run: () => void this.commands.run('file.openSite') },
        { label: 'Close this site', run: () => void this.commands.run('file.closeSite') },
        { separator: true },
        { label: 'Show site folder', run: () => void api.revealPath(this.treeData?.children?.[0]?.path ?? '') },
      ]),
    );

    const top = h('header.top', null,
      siteButton,
      this.tabStrip,
      h('div.top__actions', null,
        h('button.btn', { type: 'button', title: 'Open this page in your default browser (F9)', onclick: () => void this.commands.run('site.previewInBrowser') }, icon('browser'), 'Preview'),
        h('button.btn.btn--primary', { type: 'button', title: 'Publish the site (Ctrl+Shift+U)', onclick: () => void this.commands.run('site.publish') }, icon('publish'), 'Publish'),
      ),
    );

    const rail = h('nav.rail', { 'aria-label': 'Panels' });
    for (const dock of DOCKS) {
      const button = h('button.rail__btn', { type: 'button', title: dock.label, 'aria-label': dock.label, onclick: () => this.showDock(dock.id) }, icon(dock.icon, 20));
      this.railButtons.set(dock.id, button);
      rail.append(button);
    }
    rail.append(h('div.rail__gap'), h('button.rail__btn', { type: 'button', title: 'Switch between light and dark', 'aria-label': 'Switch theme', onclick: () => void this.commands.run('view.theme') }, icon('theme', 20)));

    // Workspace toolbar: how the page is shown.
    const modeGroup = h('div.segment.bar__modes', { role: 'group', 'aria-label': 'View' });
    for (const [mode, label, glyph, key] of [['canvas', 'Canvas', 'canvas', 'Ctrl+1'], ['split', 'Split', 'split', 'Ctrl+2'], ['source', 'Source', 'source', 'Ctrl+3']] as const) {
      const button = h('button.segment__btn', { type: 'button', title: `${label} (${key})`, onclick: () => this.setViewMode(mode) }, icon(glyph, 14), label);
      this.modeButtons.set(mode, button);
      modeGroup.append(button);
    }
    const deviceGroup = h('div.segment.bar__devices', { role: 'group', 'aria-label': 'Canvas width' });
    DEVICES.forEach((device, i) => {
      const button = h('button.segment__btn', { type: 'button', title: device.label, 'aria-label': device.label, 'aria-pressed': String(i === 0), class: i === 0 ? 'is-on' : '' }, icon(device.icon, 14));
      button.addEventListener('click', () => {
        this.deviceButtons.forEach((b) => (b.classList.remove('is-on'), b.setAttribute('aria-pressed', 'false')));
        button.classList.add('is-on');
        button.setAttribute('aria-pressed', 'true');
        this.canvas.setWidth(device.width);
      });
      this.deviceButtons.push(button);
      deviceGroup.append(button);
    });
    this.interactButton = h('button.toggle.bar__interact', { type: 'button', title: 'Use the page as a visitor would: follow links, open menus, type in forms (Ctrl+I)', 'aria-pressed': 'false', onclick: () => void this.commands.run('view.toggleInteract') }, icon('pointer', 14), 'Interact');
    this.bar.append(
      modeGroup,
      h('div.bar__canvasonly', null, deviceGroup, this.interactButton, h('button.iconbtn', { type: 'button', title: 'Reload canvas (F5)', 'aria-label': 'Reload canvas', onclick: () => void this.commands.run('view.reloadCanvas') }, icon('reload'))),
      this.barInfo,
    );

    const splitter = h('div.splitter.splitter--row', { role: 'separator', 'aria-label': 'Resize canvas and source' });
    this.area.append(this.canvas.el, splitter, this.sourceHost, this.assetView.el, this.emptyHost);
    dragResize(splitter, () => (this.area.dataset.view === 'asset-split' ? this.assetView.el : this.canvas.el).getBoundingClientRect().height, (start, _dx, dy) => {
      const total = this.area.getBoundingClientRect().height;
      this.area.style.setProperty('--split', `${Math.max(15, Math.min(85, ((start + dy) / total) * 100))}%`);
    }, () => this.editor.layout());

    this.emptyHost.append(
      h('div.empty', null,
        h('p', null, 'No file is open.'),
        h('div.empty__actions', null,
          h('button.btn.btn--primary', { type: 'button', onclick: () => void this.commands.run('file.newPage') }, 'New page'),
          h('button.btn', { type: 'button', onclick: () => void this.commands.run('view.quickOpen') }, 'Go to file'),
        ),
      ),
    );

    const drawerSplit = h('div.splitter.splitter--row', { role: 'separator', 'aria-label': 'Resize problems' });
    dragResize(drawerSplit, () => this.drawer.getBoundingClientRect().height, (start, _dx, dy) => {
      this.drawer.style.height = `${Math.max(90, Math.min(520, start - dy))}px`;
    }, () => this.editor.layout());
    this.drawer.prepend(drawerSplit);

    const work = h('div.work', null, this.bar, this.area, this.drawer);

    const dockSplit = h('div.splitter.splitter--col', { role: 'separator', 'aria-label': 'Resize side panel' });
    const inspSplit = h('div.splitter.splitter--col', { role: 'separator', 'aria-label': 'Resize inspector' });
    const body = h('div.wb__body', null, rail, this.dockHost, dockSplit, work, inspSplit, inspector);
    dragResize(dockSplit, () => this.dockHost.getBoundingClientRect().width, (start, dx) => body.style.setProperty('--dock', `${Math.max(200, Math.min(520, start + dx))}px`), () => this.editor.layout());
    dragResize(inspSplit, () => inspector.getBoundingClientRect().width, (start, dx) => body.style.setProperty('--insp', `${Math.max(260, Math.min(520, start - dx))}px`), () => this.editor.layout());

    const status = h('footer.status', null, this.crumbs, h('div.status__right', null, this.statusSaved, this.statusCursor, this.statusProblems));
    return h('div.wb', null, top, body, status);
  }

  // ------------------------------------------------------------------ wire

  private wire(): void {
    const canvas = this.canvas;

    canvas.onSelection.on(({ info, by }) => {
      this.selected = info;
      this.onSelection.emit(info);
      this.renderCrumbs();
      // Canvas -> Source: mark the element's range if its file is the one in the editor.
      const address = info ? canvas.resolve(info.id) : null;
      if (!info || !address || address.path !== this.active || this.mode === 'canvas') return void this.editor.clearMark();
      const text = this.docs.text(address.path);
      const el = text !== null ? parseHtml(text).elements[address.index] : null;
      if (el) this.editor.markRange(el.start, el.end, by === 'user');
    });

    canvas.onNavigate.on((href) => {
      const target = href.endsWith('/') || href === '' ? `${href}index.html` : href;
      void this.openFile(target).catch(() => this.notify(`${target} is not a page in this site.`, 'error'));
    });

    canvas.onKey.on((key) => {
      const chord = chordOf(key);
      if (chord === 'ctrl+z') return void this.undoCanvas();
      if (chord === 'ctrl+y' || chord === 'ctrl+shift+z') return void this.redoCanvas();
      this.commands.handleKey(key);
    });

    canvas.onMenu.on(({ info, x, y }) => showMenu(x, y, this.elementMenu(info)));
    canvas.onSize.on(({ width, scale }) => {
      this.barInfo.textContent = `${width} px${scale < 1 ? ` at ${Math.round(scale * 100)}%` : ''}`;
    });

    // Source -> Canvas: moving the caret selects the element it is inside.
    const follow = debounce((path: string, offset: number) => canvas.selectAtOffset(path, offset), 140);
    this.editor.onCursor.on((cursor) => {
      this.statusCursor.textContent = `Ln ${cursor.line}, Col ${cursor.col}`;
      if (cursor.byUser && this.mode === 'split' && fileKind(cursor.path) === 'html') follow(cursor.path, cursor.offset);
    });

    this.docs.onDirtyChange.on(() => {
      // A file edited from the canvas without being open (a layout or part) gets a tab, so it is visible and saveable.
      for (const path of this.docs.dirtyPaths()) if (!this.tabs.includes(path)) this.tabs.push(path);
      this.renderTabs();
      const n = this.docs.dirtyPaths().length;
      this.statusSaved.textContent = n ? `${n} unsaved` : 'All saved';
    });
    this.statusSaved.textContent = 'All saved';
    this.docs.onConflict.on((path) =>
      toast(`${path} changed on disk while you have unsaved edits.`, { kind: 'error', timeout: 0, action: { label: 'Load the disk version', run: () => void this.docs.revert(path) } }),
    );
    const reindex = debounce(() => void this.refreshIndex().catch(() => undefined), 1200);
    const redrawSvg = debounce(async (path: string) => {
      await this.docs.flushOverlays();
      if (this.active === path) void this.assetView.show(path, this.lastHtml);
    }, 400);
    this.docs.onChange.on(({ path }) => {
      const kind = fileKind(path);
      if (kind === 'html' || kind === 'css') reindex();
      if (path === this.active && extname(path) === '.svg') redrawSvg(path);
    });
    this.docs.onSaved.on(() => reindex());

    const refresh = debounce(() => void this.refreshProject().catch(() => undefined), 220);
    this.disposers.push(
      onEvent('project:changed', (change: ProjectChange) => {
        refresh();
        void this.docs.reconcile(change.paths, change.self);
        if (!change.self) {
          const notOpen = change.paths.filter((p) => !this.docs.get(p));
          if (notOpen.length) canvas.externalChange(notOpen);
        }
      }),
      onEvent('menu:command', (id) => void this.commands.run(id)),
      onEvent('app:save-and-close', async () => {
        try {
          await this.docs.saveAll();
          await api.closeWindowNow();
        } catch (err) {
          this.notify(`Could not save: ${(err as Error).message}`, 'error');
        }
      }),
    );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Dialogs and pickers own the keyboard while they are open.
      if (document.querySelector('.backdrop')) return;
      if (e.key === 'Escape') closeMenu();
      if (this.commands.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKeyDown, true));
  }

  async start(): Promise<void> {
    await this.refreshProject();
    const pages = this.indexData?.pages ?? [];
    const first = pages.find((p) => p === 'index.html') ?? pages[0];
    if (first) await this.openFile(first);
    else this.activate(null);
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.docs.closeAll();
    this.editor.editor.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------------ tabs

  /** Files with both a rendered view and a source view: pages, and SVG images. */
  private isVisual(path: string | null): boolean {
    return !!path && (fileKind(path) === 'html' || extname(path) === '.svg');
  }

  private activate(path: string | null): void {
    this.active = path;
    const kind = path ? fileKind(path) : null;
    if (kind === 'html') this.lastHtml = path;
    this.mode = this.isVisual(path) ? (this.modes.get(path!) ?? 'split') : 'source';
    const doc = path ? (this.docs.get(path) ?? null) : null;
    this.editor.show(doc);
    this.canvas.show(kind === 'html' ? path : null);
    if (path && (!doc || kind !== 'html')) void this.assetView.show(path, this.lastHtml);
    this.applyView();
    this.renderTabs();
    this.onActive.emit(path);
    if (doc) this.diagnosticsRunner.check(path!);
    if (!path) this.statusCursor.textContent = '';
  }

  private dropTab(path: string): void {
    const at = this.tabs.indexOf(path);
    if (at === -1) return;
    this.tabs.splice(at, 1);
    this.modes.delete(path);
    this.editor.forget(path);
    if (this.active === path) {
      this.activate(this.tabs[Math.min(at, this.tabs.length - 1)] ?? null);
    }
    // Layouts, parts and stylesheets stay loaded while a page that uses them is on the canvas.
    if (!this.canvas.composedFiles.includes(path) || this.active === null) this.docs.close(path);
    this.renderTabs();
  }

  private renderTabs(): void {
    clear(this.tabStrip);
    const { layoutsDir, partsDir } = this.project.manifest;
    for (const path of this.tabs) {
      const dirty = this.docs.isDirty(path);
      const role = path.startsWith(normalize(layoutsDir) + '/') ? 'layout' : path.startsWith(normalize(partsDir) + '/') ? 'part' : '';
      // Two tabs with the same file name show their folder to tell them apart.
      const twin = this.tabs.some((other) => other !== path && basename(other) === basename(path));
      const tab = h('div.tab', {
        role: 'tab',
        tabIndex: 0,
        title: path,
        'aria-selected': String(path === this.active),
        class: [path === this.active ? 'is-active' : '', dirty ? 'is-dirty' : '', role ? `is-${role}` : ''].join(' '),
        onclick: () => this.activate(path),
        onauxclick: (e: MouseEvent) => {
          if (e.button === 1) void this.closeFile(path);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') this.activate(path);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: 'Close', hint: 'Ctrl+W', run: () => void this.closeFile(path) },
            { label: 'Close others', run: async () => { for (const other of [...this.tabs]) if (other !== path) await this.closeFile(other); } },
            { separator: true },
            { label: 'Copy path', run: () => void navigator.clipboard.writeText(path) },
            { label: 'Show in file manager', run: () => void api.revealPath(path) },
          ]);
        },
      },
        fileIcon(fileKind(path)),
        h('span.tab__name', null, basename(path), twin ? h('span.tab__dir', null, ` ${path.slice(0, -basename(path).length - 1) || '/'}`) : null),
        h('button.tab__close', {
          type: 'button',
          title: dirty ? 'Unsaved changes. Close (Ctrl+W)' : 'Close (Ctrl+W)',
          'aria-label': `Close ${basename(path)}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            void this.closeFile(path);
          },
        }, dirty ? h('span.tab__dot') : icon('close', 12)),
      );
      this.tabStrip.append(tab);
    }
    this.tabStrip.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private askSave(name: string): Promise<'save' | 'discard' | 'cancel'> {
    return new Promise((resolve) => {
      let answer: 'save' | 'discard' | 'cancel' = 'cancel';
      const modal = openModal(`Save changes to ${name}?`, { onClose: () => resolve(answer) });
      modal.body.append(h('p.modal__text', null, 'If you close without saving, your changes to this file are lost.'));
      const pick = (value: typeof answer) => () => {
        answer = value;
        modal.close();
      };
      const save = h('button.btn.btn--primary', { type: 'button', onclick: pick('save') }, 'Save');
      modal.footer.append(h('button.btn', { type: 'button', onclick: pick('cancel') }, 'Cancel'), h('button.btn', { type: 'button', onclick: pick('discard') }, 'Close without saving'), save);
      save.focus();
    });
  }

  // ------------------------------------------------------------------ view

  private setViewMode(mode: ViewMode): void {
    if (!this.active || !this.isVisual(this.active)) return;
    this.mode = mode;
    this.modes.set(this.active, mode);
    this.applyView();
    this.onActive.emit(this.active);
  }

  private applyView(): void {
    const kind = this.active ? fileKind(this.active) : null;
    const isText = !!this.active && !!this.docs.get(this.active);
    const visual = this.isVisual(this.active);
    let view: string;
    if (!this.active) view = 'empty';
    else if (!isText) view = 'asset';
    else if (kind === 'html') view = this.mode;
    // An SVG is an image with source: "canvas" shows the picture, "split" shows both.
    else if (visual) view = this.mode === 'canvas' ? 'asset' : this.mode === 'split' ? 'asset-split' : 'source';
    else view = 'source';
    this.area.dataset.view = view;
    this.bar.dataset.kind = kind === 'html' ? 'html' : 'other';
    for (const [mode, button] of this.modeButtons) {
      button.classList.toggle('is-on', visual && mode === this.mode);
      button.setAttribute('aria-pressed', String(visual && mode === this.mode));
      (button as HTMLButtonElement).disabled = !visual;
    }
    this.canvas.setVisible(view === 'canvas' || view === 'split');
    if (view === 'canvas') this.editor.clearMark();
    requestAnimationFrame(() => this.editor.layout());
  }

  private showDock(id: DockId): void {
    this.dock = id;
    for (const el of Array.from(this.dockHost.children) as HTMLElement[]) el.hidden = el.dataset.dock !== id;
    for (const [dockId, button] of this.railButtons) {
      button.classList.toggle('is-on', dockId === id);
      button.setAttribute('aria-pressed', String(dockId === id));
    }
  }

  private applyTheme(): void {
    document.documentElement.dataset.theme = this.theme;
    this.editor.setTheme(this.theme);
  }

  private renderCrumbs(): void {
    clear(this.crumbs);
    const info = this.selected;
    if (!info) {
      this.crumbs.append(h('span.status__hint', null, this.active && fileKind(this.active) === 'html' && this.mode !== 'source' ? 'Nothing selected. Click an element; double-click text to edit it.' : ''));
      return;
    }
    if (info.group.length > 1) {
      this.crumbs.append(h('span.status__hint', null, `${info.group.length} elements selected. Shift+click adds or removes; Esc returns to one.`));
      return;
    }
    info.crumbs.forEach((crumb, i) => {
      if (i) this.crumbs.append(icon('chevron', 10));
      this.crumbs.append(h('button.status__crumb', { type: 'button', class: i === info.crumbs.length - 1 ? 'is-last' : '', onclick: () => this.canvas.selectId(crumb.id) }, crumb.label));
    });
  }

  // --------------------------------------------------------------- canvas

  private async undoCanvas(): Promise<void> {
    if (!(await this.canvas.undo())) this.notify('Nothing to undo on the canvas. Changes typed in Source are undone there.');
  }

  private async redoCanvas(): Promise<void> {
    await this.canvas.redo();
  }

  private elementMenu(info: SelectionInfo): MenuItem[] {
    if (info.group.length > 1) {
      const ids = info.group.map((m) => m.structId);
      return [
        { label: `Group ${ids.length} elements in a box`, hint: 'Ctrl+G', run: () => void this.canvas.run({ kind: 'group', ids }) },
        { label: 'Duplicate all', hint: 'Ctrl+D', run: () => void this.canvas.run({ kind: 'duplicateMany', ids }) },
        { separator: true },
        { label: 'Delete all', hint: 'Del', danger: true, run: () => void this.canvas.run({ kind: 'removeMany', ids }) },
      ];
    }
    const fixed = info.tag === 'body' || info.tag === 'html';
    const parent = info.crumbs[info.crumbs.length - 2];
    return [
      { label: 'Select parent', hint: 'Esc', disabled: !parent, run: () => parent && this.canvas.selectId(parent.id) },
      { label: 'Show in source', run: () => void this.commands.run('canvas.revealSource') },
      { separator: true },
      { label: 'Duplicate', hint: 'Ctrl+D', disabled: fixed, run: () => void this.canvas.run({ kind: 'duplicate', id: info.structId }) },
      { label: 'Wrap in a box', hint: 'Ctrl+G', disabled: fixed, run: () => void this.canvas.run({ kind: 'group', ids: [info.structId] }) },
      { label: 'Save as part...', disabled: fixed, run: () => void actions.saveSelectionAsPart(this, info).catch((e) => this.notify(e.message, 'error')) },
      { separator: true },
      { label: 'Delete', hint: 'Del', danger: true, disabled: fixed, run: () => void this.canvas.run({ kind: 'remove', id: info.structId }) },
    ];
  }

  // -------------------------------------------------------------- commands

  private registerCommands(): void {
    const htmlActive = () => !!this.active && fileKind(this.active) === 'html';
    const guard = (work: () => Promise<unknown>) => async () => {
      await work();
    };

    this.commands.register(
      { id: 'file.newPage', title: 'New Page', key: 'Ctrl+N', run: guard(() => actions.newPage(this)) },
      { id: 'file.newStylesheet', title: 'New Stylesheet', run: guard(() => actions.newStylesheet(this)) },
      { id: 'file.newLayout', title: 'New Layout', run: guard(() => actions.newLayout(this)) },
      { id: 'file.newPart', title: 'New Part', run: guard(() => actions.newPart(this)) },
      { id: 'file.newSite', title: 'New Site', run: () => this.leave() },
      { id: 'file.openSite', title: 'Open Site Folder', key: 'Ctrl+O', run: () => this.leave() },
      { id: 'file.closeSite', title: 'Close Site', run: () => this.leave() },
      {
        id: 'file.save',
        title: 'Save',
        key: 'Ctrl+S',
        run: async () => {
          if (!this.active || !this.docs.get(this.active)) return;
          // Saving a page also saves the layout, parts and styles edited through its canvas.
          const related = this.docs.dirtyPaths().filter((p) => p === this.active || this.canvas.composedFiles.includes(p) || fileKind(p) === 'css');
          for (const path of related) await this.docs.save(path);
        },
      },
      {
        id: 'file.saveAll',
        title: 'Save All',
        key: 'Ctrl+Shift+S',
        run: async () => {
          const n = await this.docs.saveAll();
          if (n) this.notify(`Saved ${n} file${n === 1 ? '' : 's'}.`, 'success');
        },
      },
      { id: 'file.closeTab', title: 'Close Tab', key: 'Ctrl+W', run: async () => void (this.active && (await this.closeFile(this.active))) },

      { id: 'edit.undo', title: 'Undo', hidden: true, run: () => (this.editor.hasFocus() || this.mode === 'source' ? this.editor.trigger('undo') : void this.undoCanvas()) },
      { id: 'edit.redo', title: 'Redo', hidden: true, run: () => (this.editor.hasFocus() || this.mode === 'source' ? this.editor.trigger('redo') : void this.redoCanvas()) },
      {
        id: 'edit.find',
        title: 'Find in File',
        run: () => {
          if (this.mode === 'canvas') this.setViewMode('split');
          this.editor.run('actions.find');
        },
      },
      {
        id: 'edit.replace',
        title: 'Replace in File',
        run: () => {
          if (this.mode === 'canvas') this.setViewMode('split');
          this.editor.run('editor.action.startFindReplaceAction');
        },
      },
      {
        id: 'edit.findInSite',
        title: 'Find in Site',
        key: 'Ctrl+Shift+F',
        run: () => {
          this.showDock('search');
          const selection = this.editor.hasFocus() ? this.editor.editor.getModel()?.getValueInRange(this.editor.editor.getSelection()!) : '';
          this.searchPanel.focus(selection && !selection.includes('\n') ? selection : undefined);
        },
      },
      { id: 'edit.format', title: 'Format Document', key: 'Shift+Alt+F', run: () => this.editor.run('editor.action.formatDocument') },

      { id: 'view.canvas', title: 'View: Canvas', key: 'Ctrl+1', enabled: () => this.isVisual(this.active), run: () => this.setViewMode('canvas') },
      { id: 'view.split', title: 'View: Split', key: 'Ctrl+2', enabled: () => this.isVisual(this.active), run: () => this.setViewMode('split') },
      { id: 'view.source', title: 'View: Source', key: 'Ctrl+3', enabled: () => this.isVisual(this.active), run: () => this.setViewMode('source') },
      {
        id: 'view.toggleInteract',
        title: 'Interact with Page',
        key: 'Ctrl+I',
        enabled: htmlActive,
        run: () => {
          const next = this.canvas.currentMode === 'edit' ? 'interact' : 'edit';
          this.canvas.setMode(next);
          this.interactButton.setAttribute('aria-pressed', String(next === 'interact'));
          this.interactButton.classList.toggle('is-on', next === 'interact');
          if (next === 'interact') this.notify('Interact is on: clicks go to the page. Press Ctrl+I to return to editing.');
        },
      },
      { id: 'view.reloadCanvas', title: 'Reload Canvas', key: 'F5', run: () => void this.canvas.reloadNow() },
      {
        id: 'view.quickOpen',
        title: 'Go to File',
        key: 'Ctrl+P',
        run: async () => {
          const picked = await quickPick('Go to file', (this.indexData?.files ?? []).map((f) => ({ label: basename(f), detail: f, value: f })));
          if (picked) await this.openFile(picked);
        },
      },
      {
        id: 'view.commandPalette',
        title: 'Command Palette',
        key: 'Ctrl+Shift+P',
        hidden: true,
        run: async () => {
          const items = this.commands.all().filter((c) => !c.hidden && (!c.enabled || c.enabled())).map((c) => ({ label: c.title, hint: c.key, value: c.id }));
          const picked = await quickPick('Run a command', items);
          if (picked) await this.commands.run(picked);
        },
      },
      {
        id: 'view.problems',
        title: 'Show or Hide Problems',
        key: 'Ctrl+Shift+M',
        run: () => {
          this.drawer.classList.toggle('is-open');
          requestAnimationFrame(() => this.editor.layout());
        },
      },
      {
        id: 'view.theme',
        title: 'Switch Theme',
        run: async () => {
          this.theme = this.theme === 'linen' ? 'indigo' : 'linen';
          this.applyTheme();
          await api.setTheme(this.theme);
        },
      },
      ...DOCKS.map((dock, i) => ({ id: `view.dock.${dock.id}`, title: `Show ${dock.label}`, key: `Alt+${i + 1}`, run: () => this.showDock(dock.id) })),

      {
        id: 'canvas.revealSource',
        title: 'Show Selected Element in Source',
        enabled: () => !!this.selected,
        run: async () => {
          const address = this.selected ? this.canvas.resolve(this.selected.id) : null;
          if (!address) return;
          const doc = await this.docs.open(address.path);
          const el = parseHtml(doc.model.getValue()).elements[address.index];
          if (!el) return;
          const pos = doc.model.getPositionAt(el.start);
          await this.openFile(address.path, { line: pos.lineNumber, col: pos.column, view: address.path === this.active && this.mode !== 'canvas' ? undefined : 'split' });
        },
      },
      { id: 'canvas.saveAsPart', title: 'Save Selection as Part', enabled: () => !!this.selected, run: guard(() => actions.saveSelectionAsPart(this, this.selected!)) },

      {
        id: 'site.previewInBrowser',
        title: 'Preview in Browser',
        key: 'F9',
        run: async () => {
          const page = htmlActive() ? this.active! : (this.lastHtml ?? this.indexData?.pages[0]);
          if (!page) return this.notify('There is no page to preview yet.', 'error');
          await this.docs.flushOverlays();
          await api.openInBrowser(page);
        },
      },
      {
        id: 'site.checkProblems',
        title: 'Check Site for Problems',
        run: async () => {
          this.problems = await api.lintProject(this.docs.dirtyOverlays());
          this.onDiagnostics.emit(this.problems);
          this.drawer.classList.add('is-open');
          requestAnimationFrame(() => this.editor.layout());
          const count = Object.values(this.problems).reduce((n, list) => n + list.length, 0);
          this.notify(count ? `Found ${count} problem${count === 1 ? '' : 's'} in ${Object.keys(this.problems).length} file${Object.keys(this.problems).length === 1 ? '' : 's'}.` : 'No problems found in the site.', count ? 'info' : 'success');
        },
      },
      {
        id: 'site.build',
        title: 'Build Site',
        key: 'Ctrl+B',
        run: async () => {
          const result = await api.build(this.docs.dirtyOverlays());
          const errors = result.issues.filter((i) => i.severity === 'error');
          if (errors.length) this.notify(`Built with ${errors.length} error${errors.length === 1 ? '' : 's'}. First: ${errors[0].file}: ${errors[0].message}`, 'error');
          else toast(`Built ${result.pages} page${result.pages === 1 ? '' : 's'} and ${result.files.length - result.pages} other files into ${result.outDir}/ in ${result.ms} ms.`, { kind: 'success', action: { label: 'Show folder', run: () => void api.revealPath(result.outDir) } });
        },
      },
      { id: 'site.publish', title: 'Publish', key: 'Ctrl+Shift+U', run: () => openPublishDialog(this) },

      { id: 'help.shortcuts', title: 'Keyboard Shortcuts', run: () => this.showShortcuts() },
      {
        id: 'help.about',
        title: 'About Wovenpage',
        run: () => {
          const modal = openModal('About Wovenpage');
          modal.body.append(
            h('p.modal__text', null, 'Wovenpage is a web authoring tool in which the design view and the code view edit the same source text.'),
            h('p.modal__text', null, 'Built on Electron and the Monaco editor (both MIT licensed). Interface typefaces: Instrument Sans and Commit Mono (SIL Open Font License).'),
          );
          modal.footer.append(h('button.btn.btn--primary', { type: 'button', onclick: () => modal.close() }, 'Close'));
        },
      },
    );
  }

  private showShortcuts(): void {
    const modal = openModal('Keyboard shortcuts', { wide: true });
    const rows: [string, string][] = [
      ...this.commands.all().filter((c) => c.key).map((c) => [c.title, c.key!] as [string, string]),
      ['Find in file', 'Ctrl+F'],
      ['Replace in file', 'Ctrl+H'],
      ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
      ['Canvas: edit text', 'Double-click or Enter'],
      ['Canvas: delete selection', 'Delete'],
      ['Canvas: duplicate selection', 'Ctrl+D'],
      ['Canvas: add to or remove from the selection', 'Shift+click'],
      ['Canvas: group the selection in a box', 'Ctrl+G'],
      ['Canvas: resize without snapping', 'Hold Alt'],
      ['Canvas: select parent', 'Esc or Alt+Up'],
      ['Canvas: select first child', 'Alt+Down'],
      ['Canvas: previous / next sibling', 'Alt+Left / Alt+Right'],
      ['Inspector: nudge a number', 'Up / Down (Shift for 10)'],
    ];
    modal.body.append(h('div.keys', null, rows.map(([title, key]) => h('div.keys__row', null, h('span', null, title), h('kbd', null, key)))));
    modal.footer.append(h('button.btn.btn--primary', { type: 'button', onclick: () => modal.close() }, 'Close'));
  }

  /** Returns to the start screen, giving the user a chance to save first. */
  private async leave(): Promise<void> {
    const dirty = this.docs.dirtyPaths();
    if (dirty.length) {
      const answer = await this.askSave(dirty.length === 1 ? basename(dirty[0]) : `${dirty.length} files`);
      if (answer === 'cancel') return;
      if (answer === 'save') await this.docs.saveAll();
    }
    await api.closeProject();
    this.onExit();
  }
}
