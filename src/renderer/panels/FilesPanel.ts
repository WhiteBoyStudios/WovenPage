/**
 * Site panel: the file and folder tree. Files open on click, can be dragged
 * between folders (links are repaired), and can be dragged onto the canvas to
 * insert them - an image becomes <img>, a page becomes a link, a part becomes
 * a <w-part>.
 */

import { dirname, join, normalize } from '../../shared/paths';
import type { InsertPayload } from '../../shared/protocol';
import type { TreeNode } from '../../shared/types';
import { api } from '../core/api';
import { clear, h } from '../core/dom';
import { fileIcon, icon } from '../core/icons';
import { MenuItem, emptyState, showMenu } from '../core/ui';
import type { Shell } from '../workbench/Shell';
import * as actions from '../workbench/fileActions';

export const TREE_DRAG_TYPE = 'application/x-wovenpage-path';

export class FilesPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private collapsed = new Set<string>();
  private focusPath: string | null = null;

  constructor(private readonly shell: Shell) {
    this.list = h('div.tree', { role: 'tree', tabIndex: 0, 'aria-label': 'Site files' });
    this.el = h('section.panel', null,
      h('header.panel__head', null,
        h('h2', null, 'Site'),
        h('div.panel__tools', null,
          h('button.iconbtn', { type: 'button', title: 'New page (Ctrl+N)', 'aria-label': 'New page', onclick: () => void this.guard(actions.newPage(shell)) }, icon('plus')),
          h('button.iconbtn', { type: 'button', title: 'More', 'aria-label': 'More site actions', onclick: (e: MouseEvent) => this.rootMenu(e) }, icon('more')),
        ),
      ),
      this.list,
    );

    shell.onTree.on(() => this.render());
    shell.onActive.on(() => this.render());
    shell.docs.onDirtyChange.on(() => this.render());
    shell.onDiagnostics.on(() => this.render());

    this.list.addEventListener('keydown', (e) => this.onKey(e));
    // Dropping on empty space moves a file to the site root.
    this.list.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(TREE_DRAG_TYPE)) e.preventDefault();
    });
    this.list.addEventListener('drop', (e) => {
      const from = e.dataTransfer?.getData(TREE_DRAG_TYPE);
      if (!from || e.defaultPrevented || e.target !== this.list) return;
      e.preventDefault();
      void this.guard(actions.movePath(this.shell, from, join('', from.split('/').pop()!)));
    });
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target === this.list) this.rootMenu(e);
    });
  }

  private async guard(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (err) {
      this.shell.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private role(path: string): 'layout' | 'part' | null {
    const { layoutsDir, partsDir } = this.shell.project.manifest;
    if (path.startsWith(normalize(layoutsDir) + '/')) return 'layout';
    if (path.startsWith(normalize(partsDir) + '/')) return 'part';
    return null;
  }

  private payloadFor(node: TreeNode): InsertPayload | null {
    if (node.dir) return null;
    if (this.role(node.path) === 'part') return { type: 'part', path: node.path };
    if (this.role(node.path) === 'layout' || node.kind === 'css' || node.kind === 'js' || node.kind === 'json') return null;
    return { type: 'asset', path: node.path };
  }

  private render(): void {
    const tree = this.shell.tree();
    clear(this.list);
    if (!tree) return;
    if (!tree.children?.length) {
      this.list.append(emptyState('This site has no files yet.', h('button.btn.btn--primary', { type: 'button', onclick: () => void this.guard(actions.newPage(this.shell)) }, 'Create the first page')));
      return;
    }
    const active = this.shell.activePath();
    const problems = this.shell.diagnostics();
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        const open = node.dir && !this.collapsed.has(node.path);
        const role = this.role(node.path);
        const errors = problems[node.path]?.filter((d) => d.severity === 'error').length ?? 0;
        const row = h('div.tree__row', {
          role: 'treeitem',
          class: [node.path === active ? 'is-active' : '', node.path === this.focusPath ? 'is-focus' : '', role ? `is-${role}` : ''].join(' '),
          style: { paddingLeft: `${8 + depth * 14}px` },
          draggable: true,
          title: node.path,
          dataset: { path: node.path },
          'aria-expanded': node.dir ? String(open) : undefined,
          onclick: () => {
            this.focusPath = node.path;
            if (node.dir) {
              if (open) this.collapsed.add(node.path);
              else this.collapsed.delete(node.path);
              this.render();
            } else {
              void this.guard(this.shell.openFile(node.path));
            }
          },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.focusPath = node.path;
            this.render();
            showMenu(e.clientX, e.clientY, this.menuFor(node));
          },
          ondragstart: (e: DragEvent) => {
            e.dataTransfer!.setData(TREE_DRAG_TYPE, node.path);
            e.dataTransfer!.effectAllowed = 'copyMove';
            const payload = this.payloadFor(node);
            if (payload) this.shell.setDragPayload(payload);
          },
          ondragend: () => this.shell.setDragPayload(null),
          ondragover: (e: DragEvent) => {
            if (!node.dir || !e.dataTransfer?.types.includes(TREE_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('is-drop');
          },
          ondragleave: () => row.classList.remove('is-drop'),
          ondrop: (e: DragEvent) => {
            row.classList.remove('is-drop');
            const from = e.dataTransfer?.getData(TREE_DRAG_TYPE);
            if (!node.dir || !from) return;
            e.preventDefault();
            if (dirname(from) === node.path || from === node.path) return;
            void this.guard(actions.movePath(this.shell, from, join(node.path, from.split('/').pop()!)));
          },
        },
          h('span.tree__twist', null, node.dir ? icon(open ? 'chevronDown' : 'chevron', 12) : null),
          fileIcon(node.kind, open),
          h('span.tree__name', null, node.name),
          role && !node.dir ? h('span.tree__role', null, role) : null,
          errors ? h('span.tree__badge', { title: `${errors} problem${errors === 1 ? '' : 's'}` }, String(errors)) : null,
          !node.dir && this.shell.docs.isDirty(node.path) ? h('span.tree__dirty', { title: 'Unsaved changes' }) : null,
        );
        this.list.append(row);
        if (open && node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree.children, 0);
  }

  private menuFor(node: TreeNode): MenuItem[] {
    const shell = this.shell;
    const dir = node.dir ? node.path : dirname(node.path);
    const payload = this.payloadFor(node);
    const items: MenuItem[] = [];
    if (!node.dir) {
      items.push({ label: 'Open', run: () => void this.guard(shell.openFile(node.path)) });
      if (node.kind === 'html') items.push({ label: 'Preview in browser', run: () => void this.guard(api.openInBrowser(node.path)) });
      if (payload) items.push({ label: payload.type === 'part' ? 'Insert this part' : 'Insert into page', run: () => void this.guard(shell.insert(payload)) });
      items.push({ separator: true });
    }
    items.push(
      { label: 'New page here...', run: () => void this.guard(actions.newPage(shell, dir)) },
      { label: 'New file here...', run: () => void this.guard(actions.newFile(shell, dir)) },
      { label: 'New folder here...', run: () => void this.guard(actions.newFolder(shell, dir)) },
      { label: 'Add existing files...', run: () => void this.guard(actions.importFiles(shell, dir, 'any')) },
      { separator: true },
      { label: 'Rename...', hint: 'F2', run: () => void this.guard(actions.renamePath(shell, node.path)) },
      { label: 'Duplicate', run: () => void this.guard(actions.duplicatePath(shell, node.path)) },
      { label: 'Copy path', run: () => void navigator.clipboard.writeText(node.path) },
      { label: 'Show in file manager', run: () => void this.guard(api.revealPath(node.path)) },
      { separator: true },
      { label: 'Delete', hint: 'Del', danger: true, run: () => void this.guard(actions.deletePath(shell, node.path, node.dir)) },
    );
    return items;
  }

  private rootMenu(e: MouseEvent): void {
    e.preventDefault();
    const shell = this.shell;
    showMenu(e.clientX, e.clientY, [
      { label: 'New page...', hint: 'Ctrl+N', run: () => void this.guard(actions.newPage(shell)) },
      { label: 'New stylesheet...', run: () => void this.guard(actions.newStylesheet(shell)) },
      { label: 'New layout...', run: () => void this.guard(actions.newLayout(shell)) },
      { label: 'New part...', run: () => void this.guard(actions.newPart(shell)) },
      { label: 'New folder...', run: () => void this.guard(actions.newFolder(shell)) },
      { separator: true },
      { label: 'Add existing files...', run: () => void this.guard(actions.importFiles(shell, '', 'any')) },
      { label: 'Refresh', run: () => void this.guard(shell.refreshProject()) },
    ]);
  }

  private findNode(path: string): TreeNode | null {
    const visit = (node: TreeNode): TreeNode | null => {
      if (node.path === path) return node;
      for (const child of node.children ?? []) {
        const hit = visit(child);
        if (hit) return hit;
      }
      return null;
    };
    const tree = this.shell.tree();
    return tree ? visit(tree) : null;
  }

  private onKey(e: KeyboardEvent): void {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.tree__row')];
    const at = rows.findIndex((r) => r.dataset.path === this.focusPath);
    const node = this.focusPath ? this.findNode(this.focusPath) : null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) this.focusPath = next.dataset.path!;
      this.render();
      this.list.querySelector('.is-focus')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && node) {
      rows[at]?.click();
    } else if (e.key === 'ArrowRight' && node?.dir) {
      this.collapsed.delete(node.path);
      this.render();
    } else if (e.key === 'ArrowLeft' && node?.dir) {
      this.collapsed.add(node.path);
      this.render();
    } else if (e.key === 'F2' && node) {
      void this.guard(actions.renamePath(this.shell, node.path));
    } else if (e.key === 'Delete' && node) {
      void this.guard(actions.deletePath(this.shell, node.path, node.dir));
    } else return;
    e.preventDefault();
  }
}
