/**
 * A very small DOM toolkit. The workbench is plain TypeScript and DOM - no UI
 * framework - so that the whole renderer stays readable end to end.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

/**
 * Creates an element. The tag may carry classes: h('button.btn.primary').
 * Props starting with "on" are event listeners; everything else is an
 * attribute (false/null/undefined are skipped, true becomes an empty attribute).
 */
export function h<T extends HTMLElement = HTMLElement>(spec: string, props?: Props | null, ...children: Child[]): T {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div') as T;
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'draggable' || key === 'tabIndex') (el as unknown as Record<string, unknown>)[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child): void {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) children.forEach((c) => append(parent, c));
  else parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Inline SVG from a path string drawn on a 16x16 grid. */
export function svgIcon(paths: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = paths;
  return svg;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: number | undefined;
  let lastArgs: A | null = null;
  const run = () => {
    timer = undefined;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };
  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  };
  wrapped.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      run();
    }
  };
  return wrapped;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Makes `handle` drag-resize a size, reporting pixel deltas from the drag start. */
export function dragResize(handle: HTMLElement, onStart: () => number, onMove: (start: number, dx: number, dy: number) => void, onEnd?: () => void): void {
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const start = onStart();
    handle.setPointerCapture(down.pointerId);
    document.body.classList.add('is-resizing');
    const move = (e: PointerEvent) => onMove(start, e.clientX - down.clientX, e.clientY - down.clientY);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing');
      onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
