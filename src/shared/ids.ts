/**
 * Source addresses. `data-wp="2:17"` on an element in the canvas means
 * "element 17 of file 2", where file 2 is an index into the list of files the
 * preview server composed the page from. Kept dependency-free so the canvas
 * agent can import it without pulling in the parser.
 */

export const ID_ATTR = 'data-wp';
/** Marks the root elements produced by expanding a part instance; holds the instance's address. */
export const INSTANCE_ATTR = 'data-wp-inst';
/** Marks the placeholder shown for an empty slot; holds the address of the <w-fill> to insert into. */
export const DROP_ATTR = 'data-wp-drop';

export type NodeId = string;

export function makeNodeId(fileIndex: number, elementIndex: number): NodeId {
  return `${fileIndex}:${elementIndex}`;
}

export function parseNodeId(id: NodeId): { file: number; index: number } | null {
  const m = /^(\d+):(\d+)$/.exec(id);
  return m ? { file: Number(m[1]), index: Number(m[2]) } : null;
}
