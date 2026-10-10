/**
 * Messages exchanged between the workbench (host) and the canvas agent that
 * runs inside the previewed page. The two live in different origins, so
 * everything here must survive structured cloning.
 */

import type { NodeId } from './ids';
export type Where = 'before' | 'after' | 'inside-start' | 'inside-end';

export type { NodeId };

export const CANVAS_CHANNEL = 'wovenpage-canvas';

/** What is being dragged in from the workbench. */
export type InsertPayload =
  | { type: 'html'; html: string; label: string }
  | { type: 'asset'; path: string }
  | { type: 'part'; path: string };

/** An edit the user performed on the canvas, addressed by source ids. */
export type CanvasOp =
  | { kind: 'setStyles'; id: NodeId; styles: Record<string, string | null> }
  | { kind: 'setText'; id: NodeId; html: string }
  | { kind: 'move'; id: NodeId; ref: NodeId; where: Where }
  | { kind: 'insert'; ref: NodeId; where: Where; payload: InsertPayload }
  | { kind: 'remove'; id: NodeId }
  | { kind: 'duplicate'; id: NodeId }
  // The same, for a multiple selection. Ids are structural ids.
  | { kind: 'removeMany'; ids: NodeId[] }
  | { kind: 'duplicateMany'; ids: NodeId[] }
  | { kind: 'moveMany'; ids: NodeId[]; ref: NodeId; where: Where }
  /** Wrap adjacent siblings in a new container element. */
  | { kind: 'group'; ids: NodeId[] };

export interface MatchedRule {
  /** Site-root-relative stylesheet path; null for a <style> block or a foreign sheet. */
  href: string | null;
  selector: string;
  /** Depth-first ordinal among the sheet's style rules. */
  ordinal: number;
  /** Enclosing conditions, e.g. ["@media (min-width: 40rem)"]. */
  context: string[];
  decls: Record<string, string>;
}

export interface Crumb {
  id: NodeId;
  label: string;
}

export interface GroupMember {
  id: NodeId;
  structId: NodeId;
  label: string;
}

export interface SelectionInfo {
  /**
   * Every selected element, primary first. Has one entry for an ordinary
   * selection; the rest of this object always describes the primary element.
   */
  group: GroupMember[];
  /** Address of the element's own open tag. */
  id: NodeId;
  /** Address to use for move / remove / duplicate (the part instance, when the element is a part's root). */
  structId: NodeId;
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  inline: Record<string, string>;
  computed: Record<string, string>;
  /** Rules that match the element and currently apply, in stylesheet order. */
  rules: MatchedRule[];
  /** Ancestors from <body> down to the element itself. */
  crumbs: Crumb[];
  rect: { x: number; y: number; w: number; h: number };
  parentDisplay: string;
  /** Stylesheets linked by the page, site-root-relative. */
  sheets: string[];
  canHoldChildren: boolean;
}

export type AgentMessage =
  | { t: 'ready'; epoch: number; files: string[]; title: string; issues: { file: string; message: string }[] }
  /** `by` tells the host whether the user clicked or it is echoing a host request. */
  | { t: 'select'; info: SelectionInfo | null; by: 'user' | 'host' }
  | { t: 'op'; epoch: number; op: CanvasOp }
  | { t: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { t: 'navigate'; href: string }
  | { t: 'menu'; id: NodeId; x: number; y: number }
  | { t: 'notice'; message: string };

export type HostMessage =
  | { t: 'select'; id: NodeId | null; reveal?: boolean }
  | { t: 'preview-style'; id: NodeId; styles: Record<string, string | null> }
  | { t: 'preview-rule'; href: string; ordinal: number; selector: string; prop: string; value: string | null }
  | { t: 'preview-attr'; id: NodeId; name: string; value: string | null }
  | { t: 'refresh-css' }
  | { t: 'mode'; mode: CanvasMode }
  | { t: 'drag-payload'; payload: InsertPayload | null }
  /** Pointer position (canvas coordinates) of a drag in progress over the canvas; null when it leaves. */
  | { t: 'drag-over'; at: { x: number; y: number } | null }
  | { t: 'drag-drop'; at: { x: number; y: number } }
  | { t: 'request-info' };

export type CanvasMode = 'edit' | 'interact';

export interface Envelope<T> {
  channel: typeof CANVAS_CHANNEL;
  body: T;
}

export function wrap<T>(body: T): Envelope<T> {
  return { channel: CANVAS_CHANNEL, body };
}

export function unwrap<T>(data: unknown): T | null {
  if (data && typeof data === 'object' && (data as Envelope<T>).channel === CANVAS_CHANNEL) return (data as Envelope<T>).body;
  return null;
}

/** Query parameter that asks the preview server for the instrumented canvas build of a page. */
export const CANVAS_QUERY = '__wp';
