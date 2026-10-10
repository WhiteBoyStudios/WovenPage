/**
 * Stamps every open tag with its source address.
 *
 * The stamp is added only to the copy of the page that is served into the
 * design canvas - it is never written to disk - and it is what lets a click in
 * a real browser be traced back to an exact range of characters in a source
 * file.
 */

import { TextEdit, applyEdits } from '../text';
import { ID_ATTR, makeNodeId } from '../ids';
import { parseHtml } from './parse';

export { ID_ATTR, INSTANCE_ATTR, DROP_ATTR, makeNodeId, parseNodeId } from '../ids';
export type { NodeId } from '../ids';

export function instrument(text: string, fileIndex: number): string {
  const doc = parseHtml(text);
  const edits: TextEdit[] = doc.elements.map((el) => ({
    start: el.nameEnd,
    end: el.nameEnd,
    text: ` ${ID_ATTR}="${makeNodeId(fileIndex, el.index)}"`,
  }));
  return applyEdits(text, edits);
}
