/**
 * Assets panel: every image, video, audio file and font in the site, with
 * thumbnails. Drag one onto the canvas to insert it with a correct relative
 * path; fonts get an @font-face rule written into a stylesheet of your choice.
 */

import { appendRule } from '../../shared/css/model';
import { basename, dirname, extname, relative } from '../../shared/paths';
import type { TreeNode } from '../../shared/types';
import { api } from '../core/api';
import { clear, formatBytes, h } from '../core/dom';
import { fileIcon, icon } from '../core/icons';
import { askForm, emptyState, showMenu } from '../core/ui';
import type { Shell } from '../workbench/Shell';
import * as actions from '../workbench/fileActions';
import { PALETTE_DRAG_TYPE } from './AddPanel';

const FONT_FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

export class AssetsPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;

  constructor(private readonly shell: Shell) {
    this.body = h('div.assets');
    this.el = h('section.panel', null,
      h('header.panel__head', null,
        h('h2', null, 'Assets'),
        h('div.panel__tools', null, h('button.iconbtn', { type: 'button', title: 'Add images, video, audio or fonts', 'aria-label': 'Add media files', onclick: () => void this.import() }, icon('plus'))),
      ),
      this.body,
    );
    shell.onTree.on(() => this.render());
  }

  private async import(): Promise<void> {
    try {
      await actions.importFiles(this.shell, this.shell.project.manifest.assetsDir, 'media');
    } catch (err) {
      this.shell.notify((err as Error).message, 'error');
    }
  }

  private collect(): TreeNode[] {
    const out: TreeNode[] = [];
    const visit = (node: TreeNode) => {
      if (!node.dir && (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio' || node.kind === 'font')) out.push(node);
      node.children?.forEach(visit);
    };
    const tree = this.shell.tree();
    if (tree) visit(tree);
    return out;
  }

  private render(): void {
    clear(this.body);
    const all = this.collect();
    if (!all.length) {
      this.body.append(emptyState('No media in this site yet.', h('button.btn.btn--primary', { type: 'button', onclick: () => void this.import() }, 'Add files')));
      return;
    }
    const groups: [string, TreeNode[]][] = [
      ['Images', all.filter((n) => n.kind === 'image')],
      ['Video and audio', all.filter((n) => n.kind === 'video' || n.kind === 'audio')],
      ['Fonts', all.filter((n) => n.kind === 'font')],
    ];
    for (const [title, nodes] of groups) {
      if (!nodes.length) continue;
      const grid = h('div', { class: title === 'Images' ? 'assets__grid' : 'assets__list' });
      for (const node of nodes) grid.append(title === 'Images' ? this.thumb(node) : this.row(node));
      this.body.append(h('div.add__group', null, h('div.add__title', null, h('h3', null, title), h('span.add__count', null, String(nodes.length))), grid));
    }
  }

  private wire(el: HTMLElement, node: TreeNode): HTMLElement {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData(PALETTE_DRAG_TYPE, '1');
      e.dataTransfer!.setData('text/plain', node.path);
      e.dataTransfer!.effectAllowed = 'copy';
      this.shell.setDragPayload({ type: 'asset', path: node.path });
    });
    el.addEventListener('dragend', () => this.shell.setDragPayload(null));
    el.addEventListener('click', () => void this.shell.openFile(node.path));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const active = this.shell.activePath();
      showMenu(e.clientX, e.clientY, [
        node.kind === 'font'
          ? { label: 'Use this font...', run: () => void this.useFont(node.path) }
          : { label: 'Insert into page', run: () => void this.shell.insert({ type: 'asset', path: node.path }) },
        { label: 'Open preview', run: () => void this.shell.openFile(node.path) },
        { separator: true },
        { label: 'Copy path from site root', run: () => void navigator.clipboard.writeText(node.path) },
        { label: active ? `Copy path relative to ${basename(active)}` : 'Copy relative path', disabled: !active, run: () => void navigator.clipboard.writeText(relative(dirname(active!), node.path)) },
        { label: 'Show in file manager', run: () => void api.revealPath(node.path) },
        { separator: true },
        { label: 'Rename...', run: () => void actions.renamePath(this.shell, node.path).catch((err) => this.shell.notify(err.message, 'error')) },
        { label: 'Delete', danger: true, run: () => void actions.deletePath(this.shell, node.path, false).catch((err) => this.shell.notify(err.message, 'error')) },
      ]);
    });
    return el;
  }

  private thumb(node: TreeNode): HTMLElement {
    const img = h<HTMLImageElement>('img', { src: `${this.shell.previewUrl(node.path)}?t=${Math.round(node.mtime)}`, alt: '', loading: 'lazy', draggable: false });
    return this.wire(
      h('div.assets__thumb', { title: `${node.path}\n${formatBytes(node.size)}`, tabIndex: 0 }, h('div.assets__image', null, img), h('span.assets__name', null, node.name)),
      node,
    );
  }

  private row(node: TreeNode): HTMLElement {
    return this.wire(
      h('div.assets__row', { title: node.path, tabIndex: 0 }, fileIcon(node.kind), h('span.assets__name', null, node.name), h('span.assets__size', null, formatBytes(node.size))),
      node,
    );
  }

  /** Writes an @font-face rule for a font file into a stylesheet. */
  async useFont(fontPath: string): Promise<void> {
    const sheets = this.shell.index()?.stylesheets ?? [];
    if (!sheets.length) return this.shell.notify('Create a stylesheet first; the font is declared there.', 'error');
    const guess = basename(fontPath).replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|italic|variable|\d{3}).*$/i, '').replace(/[-_]+/g, ' ');
    const values = await askForm({
      title: 'Use this font',
      intro: 'Adds an @font-face rule. The family then appears in the inspector\'s font list and in code completion.',
      fields: [
        { name: 'family', label: 'Family name', type: 'text', value: guess, required: true },
        { name: 'weight', label: 'Weight', type: 'text', value: '400', hint: 'A single weight (700) or a range for variable fonts (100 900).' },
        { name: 'sheet', label: 'Stylesheet', type: 'select', options: sheets.map((s) => ({ value: s, label: s })) },
      ],
      submit: 'Add font',
    });
    if (!values) return;
    const doc = await this.shell.docs.open(values.sheet);
    const format = FONT_FORMATS[extname(fontPath)];
    const src = `url("${encodeURI(relative(dirname(values.sheet), fontPath))}")${format ? ` format("${format}")` : ''}`;
    const edits = appendRule(doc.model.getValue(), '@font-face', {
      'font-family': `"${values.family.replace(/"/g, '')}"`,
      src,
      'font-weight': values.weight || '400',
      'font-display': 'swap',
    });
    this.shell.docs.applyEdits(values.sheet, edits, 'canvas-struct');
    await this.shell.refreshProject();
    this.shell.notify(`"${values.family}" is ready to use. Pick it in the inspector under Text > Font.`, 'success');
  }
}
