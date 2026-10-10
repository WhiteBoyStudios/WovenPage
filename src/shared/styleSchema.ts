/**
 * The style inspector, as data.
 *
 * Every control the inspector shows is declared here: which CSS property it
 * edits, what kind of input it is, and when it is relevant. The inspector
 * renders this schema generically, and the canvas agent uses the same list to
 * know which computed values to report - so adding a property is a one-line
 * change in this file.
 */

export type ControlKind = 'text' | 'length' | 'number' | 'color' | 'select' | 'segment' | 'font' | 'sides';

export interface StyleControl {
  /** CSS property, or a label key for a `sides` group. */
  prop: string;
  label: string;
  kind: ControlKind;
  options?: string[];
  /** For `sides`: the four properties, in top / right / bottom / left order. */
  props?: [string, string, string, string];
  placeholder?: string;
  /** Show only when the element's own property has one of these computed values. */
  when?: { prop: string; in: string[] };
  /** Show only when the parent's display has one of these values. */
  whenParent?: string[];
  /** Spans the full width of the panel. */
  wide?: boolean;
  /** Step used by the arrow keys for unitless numbers. */
  step?: number;
}

export interface StyleSection {
  id: string;
  title: string;
  controls: StyleControl[];
  /** Collapsed until the user opens it. */
  collapsed?: boolean;
}

const FLEX = ['flex', 'inline-flex'];
const GRID = ['grid', 'inline-grid'];
const ALIGNMENT = ['normal', 'start', 'center', 'end', 'stretch', 'baseline', 'flex-start', 'flex-end'];
const DISTRIBUTION = ['normal', 'start', 'center', 'end', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end', 'stretch'];

export const STYLE_SECTIONS: StyleSection[] = [
  {
    id: 'layout',
    title: 'Layout',
    controls: [
      { prop: 'display', label: 'Display', kind: 'select', options: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'flow-root', 'contents', 'none'], wide: true },
      { prop: 'flex-direction', label: 'Direction', kind: 'segment', options: ['row', 'column', 'row-reverse', 'column-reverse'], when: { prop: 'display', in: FLEX }, wide: true },
      { prop: 'flex-wrap', label: 'Wrap', kind: 'segment', options: ['nowrap', 'wrap', 'wrap-reverse'], when: { prop: 'display', in: FLEX }, wide: true },
      { prop: 'grid-template-columns', label: 'Columns', kind: 'text', placeholder: 'repeat(3, 1fr)', when: { prop: 'display', in: GRID }, wide: true },
      { prop: 'grid-template-rows', label: 'Rows', kind: 'text', placeholder: 'auto', when: { prop: 'display', in: GRID }, wide: true },
      { prop: 'grid-auto-flow', label: 'Auto flow', kind: 'select', options: ['row', 'column', 'dense', 'row dense', 'column dense'], when: { prop: 'display', in: GRID } },
      { prop: 'justify-content', label: 'Justify', kind: 'select', options: DISTRIBUTION, when: { prop: 'display', in: [...FLEX, ...GRID] } },
      { prop: 'align-items', label: 'Align', kind: 'select', options: ALIGNMENT, when: { prop: 'display', in: [...FLEX, ...GRID] } },
      { prop: 'justify-items', label: 'Justify items', kind: 'select', options: ALIGNMENT, when: { prop: 'display', in: GRID } },
      { prop: 'align-content', label: 'Align rows', kind: 'select', options: DISTRIBUTION, when: { prop: 'display', in: [...FLEX, ...GRID] } },
      { prop: 'row-gap', label: 'Row gap', kind: 'length', when: { prop: 'display', in: [...FLEX, ...GRID] } },
      { prop: 'column-gap', label: 'Column gap', kind: 'length', when: { prop: 'display', in: [...FLEX, ...GRID] } },
    ],
  },
  {
    id: 'placement',
    title: 'Placement in parent',
    controls: [
      { prop: 'flex-grow', label: 'Grow', kind: 'number', step: 1, whenParent: FLEX },
      { prop: 'flex-shrink', label: 'Shrink', kind: 'number', step: 1, whenParent: FLEX },
      { prop: 'flex-basis', label: 'Basis', kind: 'length', whenParent: FLEX },
      { prop: 'order', label: 'Order', kind: 'number', step: 1, whenParent: [...FLEX, ...GRID] },
      { prop: 'align-self', label: 'Align self', kind: 'select', options: ['auto', ...ALIGNMENT], whenParent: [...FLEX, ...GRID] },
      { prop: 'justify-self', label: 'Justify self', kind: 'select', options: ['auto', ...ALIGNMENT], whenParent: GRID },
      { prop: 'grid-column', label: 'Column', kind: 'text', placeholder: 'span 2', whenParent: GRID },
      { prop: 'grid-row', label: 'Row', kind: 'text', placeholder: 'auto', whenParent: GRID },
    ],
  },
  {
    id: 'size',
    title: 'Size',
    controls: [
      { prop: 'width', label: 'Width', kind: 'length' },
      { prop: 'height', label: 'Height', kind: 'length' },
      { prop: 'min-width', label: 'Min width', kind: 'length' },
      { prop: 'max-width', label: 'Max width', kind: 'length' },
      { prop: 'min-height', label: 'Min height', kind: 'length' },
      { prop: 'max-height', label: 'Max height', kind: 'length' },
      { prop: 'aspect-ratio', label: 'Aspect ratio', kind: 'text', placeholder: '16 / 9' },
      { prop: 'overflow', label: 'Overflow', kind: 'select', options: ['visible', 'hidden', 'clip', 'auto', 'scroll'] },
      { prop: 'box-sizing', label: 'Box sizing', kind: 'select', options: ['content-box', 'border-box'] },
      { prop: 'object-fit', label: 'Object fit', kind: 'select', options: ['fill', 'contain', 'cover', 'none', 'scale-down'] },
    ],
  },
  {
    id: 'spacing',
    title: 'Spacing',
    controls: [
      { prop: 'margin', label: 'Margin', kind: 'sides', props: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], wide: true },
      { prop: 'padding', label: 'Padding', kind: 'sides', props: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'], wide: true },
    ],
  },
  {
    id: 'type',
    title: 'Text',
    controls: [
      { prop: 'font-family', label: 'Font', kind: 'font', wide: true },
      { prop: 'font-size', label: 'Size', kind: 'length' },
      { prop: 'font-weight', label: 'Weight', kind: 'select', options: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
      { prop: 'line-height', label: 'Line height', kind: 'length', step: 0.05 },
      { prop: 'letter-spacing', label: 'Letter spacing', kind: 'length' },
      { prop: 'color', label: 'Colour', kind: 'color', wide: true },
      { prop: 'text-align', label: 'Align', kind: 'segment', options: ['start', 'center', 'end', 'justify'], wide: true },
      { prop: 'font-style', label: 'Style', kind: 'segment', options: ['normal', 'italic'] },
      { prop: 'text-transform', label: 'Case', kind: 'select', options: ['none', 'uppercase', 'lowercase', 'capitalize'] },
      { prop: 'text-decoration-line', label: 'Decoration', kind: 'select', options: ['none', 'underline', 'overline', 'line-through'] },
      { prop: 'white-space', label: 'White space', kind: 'select', options: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'] },
      { prop: 'text-wrap', label: 'Wrapping', kind: 'select', options: ['wrap', 'nowrap', 'balance', 'pretty', 'stable'] },
    ],
  },
  {
    id: 'surface',
    title: 'Fill and border',
    controls: [
      { prop: 'background-color', label: 'Background', kind: 'color', wide: true },
      { prop: 'background-image', label: 'Image', kind: 'text', placeholder: 'url(...) or linear-gradient(...)', wide: true },
      { prop: 'background-size', label: 'Image size', kind: 'text', placeholder: 'cover' },
      { prop: 'background-position', label: 'Image position', kind: 'text', placeholder: 'center' },
      { prop: 'background-repeat', label: 'Repeat', kind: 'select', options: ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'] },
      { prop: 'border-style', label: 'Border', kind: 'select', options: ['none', 'solid', 'dashed', 'dotted', 'double'] },
      { prop: 'border-width', label: 'Border width', kind: 'length' },
      { prop: 'border-color', label: 'Border colour', kind: 'color', wide: true },
      { prop: 'border-radius', label: 'Corner radius', kind: 'length' },
      { prop: 'opacity', label: 'Opacity', kind: 'number', step: 0.05 },
      { prop: 'box-shadow', label: 'Shadow', kind: 'text', placeholder: '0 2px 8px rgb(0 0 0 / 0.2)', wide: true },
    ],
  },
  {
    id: 'position',
    title: 'Position',
    collapsed: true,
    controls: [
      { prop: 'position', label: 'Position', kind: 'select', options: ['static', 'relative', 'absolute', 'fixed', 'sticky'], wide: true },
      { prop: 'inset', label: 'Offsets', kind: 'sides', props: ['top', 'right', 'bottom', 'left'], when: { prop: 'position', in: ['relative', 'absolute', 'fixed', 'sticky'] }, wide: true },
      { prop: 'z-index', label: 'Stack order', kind: 'number', step: 1 },
    ],
  },
  {
    id: 'effects',
    title: 'Effects',
    collapsed: true,
    controls: [
      { prop: 'transform', label: 'Transform', kind: 'text', placeholder: 'rotate(3deg)', wide: true },
      { prop: 'transition', label: 'Transition', kind: 'text', placeholder: 'all 0.2s ease', wide: true },
      { prop: 'filter', label: 'Filter', kind: 'text', placeholder: 'blur(4px)', wide: true },
      { prop: 'backdrop-filter', label: 'Backdrop', kind: 'text', placeholder: 'blur(8px)', wide: true },
      { prop: 'mix-blend-mode', label: 'Blend', kind: 'select', options: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'] },
      { prop: 'cursor', label: 'Cursor', kind: 'select', options: ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'not-allowed'] },
      { prop: 'container-type', label: 'Container', kind: 'select', options: ['normal', 'inline-size', 'size'] },
    ],
  },
];

/** Every CSS property the inspector reads, flattened. */
export const INSPECTOR_PROPS: string[] = [
  ...new Set(STYLE_SECTIONS.flatMap((s) => s.controls.flatMap((c) => (c.kind === 'sides' ? c.props! : [c.prop])))),
];

/** Attributes worth editing for a given tag, shown on the inspector's Element tab. */
export function attributesFor(tag: string): { name: string; label: string; kind: 'text' | 'path' | 'bool' | 'select'; options?: string[] }[] {
  const common = [
    { name: 'id', label: 'ID', kind: 'text' as const },
    { name: 'class', label: 'Classes', kind: 'text' as const },
    { name: 'title', label: 'Tooltip', kind: 'text' as const },
  ];
  const byTag: Record<string, ReturnType<typeof attributesFor>> = {
    a: [
      { name: 'href', label: 'Link to', kind: 'path' },
      { name: 'target', label: 'Open in', kind: 'select', options: ['', '_blank', '_self'] },
      { name: 'rel', label: 'Relationship', kind: 'text' },
    ],
    img: [
      { name: 'src', label: 'Image', kind: 'path' },
      { name: 'alt', label: 'Description', kind: 'text' },
      { name: 'width', label: 'Width', kind: 'text' },
      { name: 'height', label: 'Height', kind: 'text' },
      { name: 'loading', label: 'Loading', kind: 'select', options: ['', 'lazy', 'eager'] },
    ],
    video: [
      { name: 'src', label: 'Video', kind: 'path' },
      { name: 'poster', label: 'Poster image', kind: 'path' },
      { name: 'controls', label: 'Show controls', kind: 'bool' },
      { name: 'autoplay', label: 'Autoplay', kind: 'bool' },
      { name: 'muted', label: 'Muted', kind: 'bool' },
      { name: 'loop', label: 'Loop', kind: 'bool' },
    ],
    audio: [
      { name: 'src', label: 'Audio', kind: 'path' },
      { name: 'controls', label: 'Show controls', kind: 'bool' },
    ],
    source: [
      { name: 'src', label: 'File', kind: 'path' },
      { name: 'type', label: 'Type', kind: 'text' },
    ],
    iframe: [
      { name: 'src', label: 'Address', kind: 'text' },
      { name: 'title', label: 'Title', kind: 'text' },
    ],
    input: [
      { name: 'type', label: 'Type', kind: 'select', options: ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'checkbox', 'radio', 'file', 'hidden', 'submit'] },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'placeholder', label: 'Placeholder', kind: 'text' },
      { name: 'value', label: 'Value', kind: 'text' },
      { name: 'required', label: 'Required', kind: 'bool' },
    ],
    textarea: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'rows', label: 'Rows', kind: 'text' },
      { name: 'placeholder', label: 'Placeholder', kind: 'text' },
      { name: 'required', label: 'Required', kind: 'bool' },
    ],
    select: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'required', label: 'Required', kind: 'bool' },
    ],
    button: [{ name: 'type', label: 'Type', kind: 'select', options: ['button', 'submit', 'reset'] }],
    form: [
      { name: 'action', label: 'Send to', kind: 'text' },
      { name: 'method', label: 'Method', kind: 'select', options: ['get', 'post'] },
    ],
    label: [{ name: 'for', label: 'For control', kind: 'text' }],
    link: [
      { name: 'rel', label: 'Relationship', kind: 'text' },
      { name: 'href', label: 'File', kind: 'path' },
    ],
    script: [{ name: 'src', label: 'File', kind: 'path' }],
    html: [{ name: 'lang', label: 'Language', kind: 'text' }],
    'w-slot': [{ name: 'name', label: 'Slot name', kind: 'text' }],
  };
  const specific = byTag[tag] ?? [];
  const seen = new Set(specific.map((a) => a.name));
  return [...specific, ...common.filter((a) => !seen.has(a.name))];
}
