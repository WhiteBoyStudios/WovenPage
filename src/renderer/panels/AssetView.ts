/**
 * Shown in the workspace when the active tab is not a text file: an image
 * with its dimensions, a media player, or a font specimen - plus the paths
 * needed to reference the file.
 */

import { basename, dirname, extname, fileKind, relative } from '../../shared/paths';
import { api } from '../core/api';
import { clear, formatBytes, h } from '../core/dom';
import type { Shell } from '../workbench/Shell';

export class AssetView {
  readonly el: HTMLElement;
  private serial = 0;

  constructor(private readonly shell: Shell) {
    this.el = h('div.assetview');
  }

  async show(path: string, lastHtmlPath: string | null): Promise<void> {
    const serial = ++this.serial;
    clear(this.el);
    const kind = fileKind(path);
    const url = `${this.shell.previewUrl(path)}?t=${Date.now()}`;
    const stage = h('div.assetview__stage');
    const facts = h('dl.assetview__facts');
    const fact = (term: string, value: string, copy = false) => {
      const dd = h('dd', null, value);
      if (copy) {
        dd.append(
          h('button.linkbtn', {
            type: 'button',
            onclick: () => {
              void navigator.clipboard.writeText(value);
              this.shell.notify('Copied.');
            },
          }, 'Copy'),
        );
      }
      facts.append(h('dt', null, term), dd);
    };

    if (kind === 'image') {
      const img = h<HTMLImageElement>('img', { src: url, alt: basename(path) });
      img.addEventListener('load', () => {
        if (serial !== this.serial) return;
        // An SVG's intrinsic size comes from its viewBox; the browser's "natural" size is only a fallback box.
        const source = extname(path) === '.svg' ? this.shell.docs.text(path) : null;
        const viewBox = source ? /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(source) : null;
        if (viewBox) fact('Dimensions', `${viewBox[1]} x ${viewBox[2]} px (viewBox)`);
        else if (img.naturalWidth) fact('Dimensions', `${img.naturalWidth} x ${img.naturalHeight} px`);
      });
      stage.classList.add('assetview__stage--checker');
      stage.append(img);
    } else if (kind === 'video') {
      stage.append(h('video', { src: url, controls: true }));
    } else if (kind === 'audio') {
      stage.append(h('audio', { src: url, controls: true }));
    } else if (kind === 'font') {
      const family = `preview-${serial}`;
      const sample = h('div.assetview__font', { style: { fontFamily: `"${family}"` } },
        h('p', { style: { fontSize: '44px' } }, 'Hamburgefonstiv 0123'),
        h('p', { style: { fontSize: '20px' } }, 'The quick brown fox jumps over the lazy dog.'),
        h('p', { style: { fontSize: '14px' } }, 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      );
      // Fonts are fetched from the preview server; a failure just leaves the fallback face.
      void new FontFace(family, `url("${url}")`).load().then((face) => document.fonts.add(face)).catch(() => sample.prepend(h('p.assetview__note', null, 'This font file could not be loaded for preview.')));
      stage.append(sample);
    } else {
      stage.append(h('p.assetview__note', null, `${extname(path) || 'This file type'} cannot be previewed here.`));
    }

    fact('Path in site', path, true);
    if (lastHtmlPath) fact(`From ${basename(lastHtmlPath)}`, relative(dirname(lastHtmlPath), path), true);
    try {
      const stat = await api.statFile(path);
      if (serial !== this.serial) return;
      fact('Size', formatBytes(stat.size));
      fact('Modified', new Date(stat.mtime).toLocaleString());
    } catch {
      /* the file may have just been removed */
    }
    this.el.append(stage, h('div.assetview__side', null, h('h2', null, basename(path)), facts));
  }
}
