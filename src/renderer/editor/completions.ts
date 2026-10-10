/**
 * Project-aware completion, layered on top of Monaco's built-in HTML/CSS/JS
 * language services. Monaco knows the languages; these providers know *this
 * site*: its class names, ids, files, custom properties, fonts, layouts,
 * slots, parts and part parameters.
 */

import { dirname, fileKind, relative, FileKind } from '../../shared/paths';
import { URL_ATTRS, pageMeta } from '../../shared/compose';
import type { ProjectIndex } from '../../shared/types';
import { monaco, pathOf } from './monacoSetup';

type Suggestion = monaco.languages.CompletionItem;
const Kind = monaco.languages.CompletionItemKind;

/** What the cursor is inside of, worked out from the text before it. */
interface HtmlContext {
  tag: string;
  /** Attribute whose value is being typed, if any. */
  attr: string | null;
  /** Text typed so far in that value. */
  value: string;
  /** Raw text of the open tag up to the cursor. */
  tagText: string;
  /** True when the cursor is where a new attribute name could go. */
  atAttrName: boolean;
  /** True immediately after `<`. */
  atTagName: boolean;
  partial: string;
}

function htmlContext(before: string): HtmlContext | null {
  const lt = before.lastIndexOf('<');
  if (lt === -1 || before.indexOf('>', lt) !== -1) return null;
  const tagText = before.slice(lt);
  const nameMatch = /^<([\w-]*)$/.exec(tagText);
  if (nameMatch) return { tag: '', attr: null, value: '', tagText, atAttrName: false, atTagName: true, partial: nameMatch[1] };
  const tag = (/^<([\w-]+)/.exec(tagText)?.[1] ?? '').toLowerCase();
  if (!tag) return null;
  const inValue = /([\w:-]+)\s*=\s*(["'])([^"']*)$/.exec(tagText);
  if (inValue && (tagText.split(inValue[2]).length - 1) % 2 === 1) {
    return { tag, attr: inValue[1].toLowerCase(), value: inValue[3], tagText, atAttrName: false, atTagName: false, partial: inValue[3] };
  }
  const attrName = /\s([\w:-]*)$/.exec(tagText);
  if (attrName) return { tag, attr: null, value: '', tagText, atAttrName: true, atTagName: false, partial: attrName[1] };
  return null;
}

/** Which kinds of file make sense for a URL attribute on a given tag. */
function wantedKinds(tag: string, attr: string): FileKind[] | null {
  if (tag === 'link') return ['css', 'image', 'font', 'json'];
  if (tag === 'script') return ['js'];
  if (tag === 'img' || attr === 'poster' || attr === 'srcset') return ['image'];
  if (tag === 'video') return ['video'];
  if (tag === 'audio') return ['audio'];
  if (tag === 'source') return ['video', 'audio', 'image'];
  if (tag === 'a') return null;
  return null;
}

export function registerCompletions(getIndex: () => ProjectIndex | null, getText: (path: string) => string | null): monaco.IDisposable[] {
  const html = monaco.languages.registerCompletionItemProvider('html', {
    triggerCharacters: ['"', "'", ' ', '/', '<', '.', '-'],
    provideCompletionItems(model, position) {
      const index = getIndex();
      const path = pathOf(model.uri);
      if (!index || !path) return { suggestions: [] };
      const before = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 30), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const ctx = htmlContext(before);
      if (!ctx) return { suggestions: [] };

      const replace = (length: number) => new monaco.Range(position.lineNumber, position.column - length, position.lineNumber, position.column);
      const suggestions: Suggestion[] = [];

      if (ctx.atTagName) {
        const range = replace(ctx.partial.length);
        const tags: [string, string, string][] = [
          ['w-part', 'w-part src="$1"></w-part>', 'Insert a reusable part'],
          ['w-slot', 'w-slot name="${1:main}"></w-slot>', 'A hole in a layout or part that pages fill'],
          ['w-fill', 'w-fill slot="${1:main}">\n\t$0\n</w-fill>', "Content for one of the layout's slots"],
          ['w-page', 'w-page layout="$1" title="$2">\n\t<w-fill slot="main">\n\t\t$0\n\t</w-fill>\n</w-page>', 'Bind this page to a layout'],
        ];
        for (const [label, insertText, detail] of tags) {
          suggestions.push({ label, kind: Kind.Snippet, insertText, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail, range, sortText: 'zz' + label });
        }
        return { suggestions };
      }

      if (ctx.atAttrName) {
        if (ctx.tag !== 'w-part') return { suggestions: [] };
        const src = /src\s*=\s*["']([^"']*)["']/.exec(ctx.tagText)?.[1];
        const part = index.parts.find((p) => p.path === src);
        const range = replace(ctx.partial.length);
        for (const param of part?.params ?? []) {
          if (new RegExp(`\\s${param}\\s*=`).test(ctx.tagText)) continue;
          suggestions.push({ label: param, kind: Kind.Property, insertText: `${param}="$1"`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: `Parameter of ${part!.path}`, range });
        }
        return { suggestions };
      }

      const attr = ctx.attr!;
      if (attr === 'class') {
        const partial = ctx.value.split(/\s+/).pop() ?? '';
        const range = replace(partial.length);
        for (const name of index.classes) suggestions.push({ label: name, kind: Kind.Class, insertText: name, detail: 'Class in this site', range });
      } else if (attr === 'id' || attr === 'for' || attr === 'aria-labelledby' || attr === 'aria-controls') {
        const range = replace(ctx.value.length);
        for (const name of index.ids) suggestions.push({ label: name, kind: Kind.Reference, insertText: name, detail: 'ID in this site', range });
      } else if (ctx.tag === 'w-part' && attr === 'src') {
        const range = replace(ctx.value.length);
        for (const part of index.parts) suggestions.push({ label: part.path, kind: Kind.Module, insertText: part.path, detail: part.params.length ? `Parameters: ${part.params.join(', ')}` : 'Part', range });
      } else if (ctx.tag === 'w-page' && attr === 'layout') {
        const range = replace(ctx.value.length);
        for (const layout of index.layouts) suggestions.push({ label: layout.path, kind: Kind.Module, insertText: layout.path, detail: `Slots: ${layout.slots.join(', ') || 'none'}`, range });
      } else if (ctx.tag === 'w-fill' && attr === 'slot') {
        const range = replace(ctx.value.length);
        const meta = pageMeta(model.getValue());
        const layout = index.layouts.find((l) => l.path === meta?.layout);
        for (const slot of layout?.slots ?? []) suggestions.push({ label: slot, kind: Kind.Field, insertText: slot, detail: `Slot in ${layout!.path}`, range });
      } else if (URL_ATTRS.has(attr) || attr === 'srcset') {
        const typed = attr === 'srcset' ? (ctx.value.split(',').pop() ?? '').trimStart() : ctx.value;
        const range = replace(typed.length);
        const kinds = wantedKinds(ctx.tag, attr);
        const fromDir = dirname(path);
        for (const file of index.files) {
          if (file === path) continue;
          const kind = fileKind(file);
          if (kinds ? !kinds.includes(kind) : kind !== 'html' && ctx.tag === 'a' && kind !== 'image' && kind !== 'other') continue;
          const url = encodeURI(relative(fromDir, file));
          suggestions.push({ label: url, kind: Kind.File, insertText: url, detail: file, filterText: url + ' ' + file, range, sortText: (kind === 'html' ? '0' : '1') + url });
        }
        if (ctx.tag === 'a') {
          for (const id of index.ids) suggestions.push({ label: `#${id}`, kind: Kind.Reference, insertText: `#${id}`, detail: 'Anchor', range, sortText: '2' + id });
        }
      }
      return { suggestions };
    },
  });

  const css = monaco.languages.registerCompletionItemProvider(['css', 'scss'], {
    triggerCharacters: ['-', '(', '"', "'", '/', '.'],
    provideCompletionItems(model, position) {
      const index = getIndex();
      const path = pathOf(model.uri);
      if (!index || !path) return { suggestions: [] };
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const replace = (length: number) => new monaco.Range(position.lineNumber, position.column - length, position.lineNumber, position.column);
      const suggestions: Suggestion[] = [];

      const inVar = /var\(\s*(--[\w-]*|-?)$/.exec(line);
      if (inVar) {
        const range = replace(inVar[1].length);
        for (const name of index.customProperties) suggestions.push({ label: name, kind: Kind.Variable, insertText: name, detail: 'Custom property in this site', range });
        return { suggestions };
      }

      const inUrl = /url\(\s*["']?([^"')]*)$/.exec(line) ?? /@import\s+["']([^"']*)$/.exec(line);
      if (inUrl) {
        const range = replace(inUrl[1].length);
        const wantCss = /@import/.test(line);
        for (const file of index.files) {
          const kind = fileKind(file);
          if (file === path || (wantCss ? kind !== 'css' : kind !== 'image' && kind !== 'font')) continue;
          const url = encodeURI(relative(dirname(path), file));
          suggestions.push({ label: url, kind: Kind.File, insertText: url, detail: file, range });
        }
        return { suggestions };
      }

      const inFont = /font(?:-family)?\s*:[^;]*?([\w -]*)$/.exec(line);
      if (inFont && index.fontFamilies.length) {
        const typed = inFont[1].trimStart();
        const range = replace(typed.length);
        for (const family of index.fontFamilies) suggestions.push({ label: family, kind: Kind.Value, insertText: /\s/.test(family) ? `"${family}"` : family, detail: 'Font loaded by this site', range, sortText: '0' + family });
        return { suggestions };
      }

      // Selector position: suggest classes and ids that the site's HTML and CSS already use.
      const inSelector = !/[:;{][^}]*$/.test(model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 40), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column }).split('}').pop() ?? '');
      const selectorToken = /([.#])([\w-]*)$/.exec(line);
      if (inSelector && selectorToken) {
        const range = replace(selectorToken[2].length);
        const names = selectorToken[1] === '.' ? index.classes : index.ids;
        for (const name of names) suggestions.push({ label: name, kind: selectorToken[1] === '.' ? Kind.Class : Kind.Reference, insertText: name, range });
      }
      return { suggestions };
    },
  });

  // Hovering a <w-part> shows what it expands to.
  const hover = monaco.languages.registerHoverProvider('html', {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const m = /<w-part\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/.exec(line);
      if (!m) return null;
      const part = getIndex()?.parts.find((p) => p.path === m[1]);
      if (!part) return { contents: [{ value: `**${m[1]}** does not exist.` }] };
      const params = part.params.length ? `Parameters: ${part.params.map((p) => '`' + p + '`').join(', ')}` : 'No parameters.';
      const text = getText(m[1]);
      const contents = [{ value: `**${m[1]}**\n\n${params}${part.hasSlot ? ' Accepts content.' : ''}` }];
      if (text !== null) contents.push({ value: '```html\n' + text.slice(0, 1200) + '\n```' });
      return { contents };
    },
  });

  return [html, css, hover];
}
