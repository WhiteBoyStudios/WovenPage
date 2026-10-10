/**
 * Writes style changes to wherever the user has chosen: the element's inline
 * style attribute, or a rule in one of the site's stylesheets. Both the
 * inspector and canvas gestures (resizing) go through here, so they always
 * agree on the destination.
 */

import { locateRule, parseCss, setDeclaration } from '../../shared/css/model';
import { parseHtml } from '../../shared/html/parse';
import { setInlineStyle } from '../../shared/html/patch';
import type { MatchedRule, SelectionInfo } from '../../shared/protocol';
import { Emitter } from '../core/events';
import type { DocumentStore } from '../documents/DocumentStore';
import type { CanvasController } from './CanvasController';

export type StyleTarget = { type: 'inline' } | { type: 'rule'; href: string; ordinal: number; selector: string; context: string[] };

export function targetKey(target: StyleTarget): string {
  return target.type === 'inline' ? 'inline' : `rule|${target.href}|${target.context.join('&')}|${target.selector}|${target.ordinal}`;
}

export function ruleTarget(rule: MatchedRule): StyleTarget | null {
  return rule.href === null ? null : { type: 'rule', href: rule.href, ordinal: rule.ordinal, selector: rule.selector, context: rule.context };
}

export class StyleWriter {
  readonly onTargetChange = new Emitter<void>();
  /** The user's standing preference; the effective target is resolved per selection. */
  private preferRules = false;
  private chosen: StyleTarget = { type: 'inline' };

  constructor(
    private readonly docs: DocumentStore,
    private readonly canvas: () => CanvasController,
    /** Whether a site-relative path is a real file (a stylesheet compiled from Sass is not). */
    private readonly fileExists: (path: string) => boolean = () => true,
  ) {}

  choose(target: StyleTarget): void {
    this.chosen = target;
    this.preferRules = target.type === 'rule';
    this.onTargetChange.emit();
  }

  /** Rules of the selection that can be written to (those in the site's own stylesheets). */
  writableRules(info: SelectionInfo): StyleTarget[] {
    return info.rules
      .map(ruleTarget)
      .filter((t): t is StyleTarget => t !== null && (t.type !== 'rule' || this.fileExists(t.href)));
  }

  /** Stylesheets with matching rules that cannot be written to because they are compiled output. */
  compiledSheets(info: SelectionInfo): string[] {
    return [...new Set(info.rules.map((r) => r.href).filter((href): href is string => href !== null && !this.fileExists(href)))];
  }

  /**
   * The destination for the current selection. If the user last chose a rule
   * and moves to another element, the most specific class rule of the new
   * element is used; otherwise inline.
   */
  targetFor(info: SelectionInfo): StyleTarget {
    const rules = this.writableRules(info);
    if (this.chosen.type === 'rule') {
      const key = targetKey(this.chosen);
      const same = rules.find((r) => targetKey(r) === key);
      if (same) return same;
    }
    if (this.preferRules) {
      // Prefer a rule that targets one of the element's own classes and nothing else.
      const own = [...rules].reverse().find((r) => r.type === 'rule' && info.classes.some((c) => r.selector.trim() === `.${c}`));
      if (own) return own;
    }
    return { type: 'inline' };
  }

  /** Declared values at the destination, for showing which properties are set there. */
  declared(info: SelectionInfo, target: StyleTarget): Record<string, string> {
    if (target.type === 'inline') return info.inline;
    const key = targetKey(target);
    const rule = info.rules.find((r) => {
      const t = ruleTarget(r);
      return t !== null && targetKey(t) === key;
    });
    return rule?.decls ?? {};
  }

  /**
   * Applies property changes (null removes a property).
   * @param alreadyInDom the canvas already shows the change (e.g. after a resize drag)
   * @returns the files that were edited
   */
  async set(info: SelectionInfo, changes: Record<string, string | null>, alreadyInDom = false): Promise<string[]> {
    const target = this.targetFor(info);
    const canvas = this.canvas();

    if (target.type === 'inline') {
      // With several elements selected, each gets the change. The resize handles only ever act on one.
      const members = alreadyInDom ? [info.id] : info.group.map((m) => m.id);
      const byFile = new Map<string, number[]>();
      for (const id of members) {
        const address = canvas.resolve(id);
        if (!address) throw new Error('That element is no longer on the canvas.');
        byFile.set(address.path, [...(byFile.get(address.path) ?? []), address.index]);
      }
      for (const [path, indices] of byFile) {
        const doc = await this.docs.open(path);
        // Edits to different elements never overlap, so one parse serves the whole file.
        const parsed = parseHtml(doc.model.getValue());
        this.docs.applyEdits(path, indices.flatMap((index) => setInlineStyle(parsed, index, changes).edits), 'canvas-stable');
      }
      if (!alreadyInDom) for (const id of members) canvas.previewStyle(id, changes);
      return [...byFile.keys()];
    }

    const doc = await this.docs.open(target.href);
    for (const [prop, value] of Object.entries(changes)) {
      const model = parseCss(doc.model.getValue());
      const rule = locateRule(model, target.ordinal, target.selector);
      if (!rule) throw new Error(`The rule "${target.selector}" could not be found in ${target.href}. It may have been edited; reload the canvas and try again.`);
      this.docs.applyEdits(target.href, setDeclaration(model, rule, prop, value), 'canvas-stable');
      canvas.previewRule(target.href, target.ordinal, target.selector, prop, value);
    }
    return [target.href];
  }
}
