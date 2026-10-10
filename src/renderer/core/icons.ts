/**
 * The icon set. Every glyph is drawn here from scratch as stroke paths on a
 * 16-unit grid; nothing is taken from another product or icon library.
 */

import { svgIcon } from './dom';
import type { FileKind } from '../../shared/paths';

const PATHS = {
  // rail
  site: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
  add: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M8 5.5v5M5.5 8h5"/>',
  assets: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="M2.5 11.5 6.5 8l2.5 2 2-1.5 2.5 2.5"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
  outline: '<path d="M3 3.5h4M6 8h5M6 12.5h5M3.5 3.5v9h2.5M3.5 8H6"/>',
  // view modes
  canvas: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h6M5 9.5h3.5"/>',
  split: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 8h12"/>',
  source: '<path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5 7 12.5"/>',
  // actions
  browser: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 1.8 2 9.2 0 11M8 2.5c-2 1.8-2 9.2 0 11"/>',
  publish: '<path d="M8 10.5v-8M4.8 5.5 8 2.500l3.2 3M3 10.500v3h10v-3"/>',
  pointer: '<path d="M4 2.500v9l2.5-2.2 1.8 4 1.6-.7-1.8-4 3.4-.3z"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.6-3.700M13 2.500v2.500h-2.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  chevronDown: '<path d="m4 6 4 4 4-4"/>',
  plus: '<path d="M8 3.500v9M3.5 8h9"/>',
  more: '<circle cx="3.5" cy="8" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="12.5" cy="8" r=".8" fill="currentColor"/>',
  link: '<path d="M6.8 9.200a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.500l-.8.8M9.2 6.800a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.500l.8-.8"/>',
  unlink: '<path d="M6 3.500v2M3.5 6h2M10 12.500v-2M12.5 10h-2M5 11l6-6"/>',
  warning: '<path d="M8 2.5 14 13H2zM8 6.500v3M8 11.300v.2"/>',
  error: '<circle cx="8" cy="8" r="5.5"/><path d="m6 6 4 4M10 6l-4 4"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.500v3.500M8 5v.2"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  trash: '<path d="M3 4.500h10M6.5 4.500V3h3v1.500M4.5 4.500l.5 8.500h6l.5-8.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.500V3.500a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  phone: '<rect x="4.5" y="2" width="7" height="12" rx="1.5"/><path d="M7.2 11.800h1.6"/>',
  tablet: '<rect x="3" y="2.5" width="10" height="11" rx="1.5"/><path d="M7.2 11.300h1.6"/>',
  laptop: '<rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.500h13"/>',
  fluid: '<path d="M2 8h12M4.5 5.5 2 8l2.5 2.500M11.5 5.5 14 8l-2.5 2.5"/>',
  theme: '<path d="M13 9.500A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.500z"/>',
  layout: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M6 6v7.5"/>',
  part: '<path d="M8 2 13.5 5v6L8 14 2.5 11V5zM2.5 5 8 8l5.5-3M8 8v6"/>',
  // files
  folder: '<path d="M2 4.500h4l1.5 1.500H14v6.500H2z"/>',
  folderOpen: '<path d="M2 12.500v-8h4l1.5 1.500H13v2M2 12.500l2-4.500h10.500l-2 4.500z"/>',
  file: '<path d="M4 2h5.500L12 4.500V14H4zM9.5 2v2.500H12"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m3 11.5 3.5-3 2.5 2 1.5-1.2 2.5 2.2"/>',
  media: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="m7 6.2 3 1.8-3 1.800z"/>',
  font: '<path d="M4 12.5 8 3.500l4 9M5.5 9.500h5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  return svgIcon(PATHS[name], size);
}

export function fileIcon(kind: FileKind | 'folder', open = false): SVGSVGElement {
  const name: IconName =
    kind === 'folder' ? (open ? 'folderOpen' : 'folder') : kind === 'image' ? 'image' : kind === 'video' || kind === 'audio' ? 'media' : kind === 'font' ? 'font' : 'file';
  const el = icon(name);
  el.classList.add(`kind-${kind}`);
  return el;
}
