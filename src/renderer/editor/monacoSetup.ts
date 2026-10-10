/**
 * One-time Monaco configuration: where its web workers live, the two editor
 * themes that match the workbench themes, and language defaults.
 */

import * as monaco from 'monaco-editor';

import { extname } from '../../shared/paths';

export { monaco };

const WORKERS: Record<string, string> = {
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
};

interface Palette {
  comment: string;
  tag: string;
  meta: string;
  name: string;
  value: string;
  keyword: string;
  number: string;
  punctuation: string;
  variable: string;
}

/**
 * Monaco's base themes colour HTML and CSS tokens with language-specific
 * rules, so a custom palette has to name those tokens explicitly to win.
 */
function tokenRules(p: Palette): monaco.editor.ITokenThemeRule[] {
  const rule = (token: string, foreground: string, fontStyle?: string) => ({ token, foreground, fontStyle });
  return [
    rule('comment', p.comment, 'italic'),
    rule('comment.html', p.comment, 'italic'),
    rule('comment.css', p.comment, 'italic'),
    rule('tag', p.tag),
    rule('tag.html', p.tag),
    rule('tag.css', p.tag),
    rule('metatag', p.meta),
    rule('metatag.html', p.meta),
    rule('metatag.content.html', p.meta),
    rule('delimiter.html', p.punctuation),
    rule('tag.xml', p.tag),
    rule('metatag.xml', p.meta),
    rule('delimiter.xml', p.punctuation),
    rule('attribute.name.xml', p.name),
    rule('attribute.value.xml', p.value),
    rule('comment.xml', p.comment, 'italic'),
    rule('attribute.name', p.name),
    rule('attribute.name.html', p.name),
    rule('attribute.name.css', p.name),
    rule('attribute.value', p.value),
    rule('attribute.value.html', p.value),
    rule('attribute.value.css', p.value),
    rule('attribute.value.number.css', p.number),
    rule('attribute.value.unit.css', p.number),
    rule('attribute.value.hex.css', p.number),
    rule('string', p.value),
    rule('string.html', p.value),
    rule('string.css', p.value),
    rule('string.key.json', p.name),
    rule('string.value.json', p.value),
    rule('keyword', p.keyword),
    rule('keyword.css', p.keyword),
    rule('number', p.number),
    rule('variable.css', p.variable),
    rule('variable.predefined.css', p.variable),
  ];
}

let configured = false;

export function setupMonaco(): void {
  if (configured) return;
  configured = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_id, label) {
      return new Worker(`workers/${WORKERS[label] ?? 'editor.worker.js'}`, { name: label });
    },
  };

  monaco.editor.defineTheme('wovenpage-linen', {
    base: 'vs',
    inherit: true,
    rules: tokenRules({ comment: '7a8783', tag: '2a3fb8', meta: '6b7672', name: '8a4a12', value: '1f6f52', keyword: '9a2a62', number: '8a4a12', punctuation: '8b9692', variable: '2a3fb8' }),
    colors: {
      'editor.background': '#fbfcfa',
      'editor.foreground': '#1c2624',
      'editorLineNumber.foreground': '#a3aeaa',
      'editorLineNumber.activeForeground': '#3346c8',
      'editor.lineHighlightBackground': '#eef1ee',
      'editor.selectionBackground': '#cdd4f6',
      'editorCursor.foreground': '#3346c8',
      'editorIndentGuide.background1': '#e4e9e5',
      'editorGutter.background': '#f4f6f3',
      'editorWidget.background': '#f4f6f3',
      'editorWidget.border': '#cdd5cf',
      'editorSuggestWidget.selectedBackground': '#dfe4fa',
      'scrollbarSlider.background': '#b8c2bd66',
    },
  });

  monaco.editor.defineTheme('wovenpage-indigo', {
    base: 'vs-dark',
    inherit: true,
    rules: tokenRules({ comment: '6f7aa3', tag: '9aa8ff', meta: '8e98bd', name: 'f0b775', value: '8fd6b4', keyword: 'ff8fbf', number: 'f0b775', punctuation: '6f7aa3', variable: '9aa8ff' }),
    colors: {
      'editor.background': '#171b30',
      'editor.foreground': '#e8ebf7',
      'editorLineNumber.foreground': '#4d567d',
      'editorLineNumber.activeForeground': '#9aa8ff',
      'editor.lineHighlightBackground': '#1f2440',
      'editor.selectionBackground': '#343d78',
      'editorCursor.foreground': '#9aa8ff',
      'editorIndentGuide.background1': '#262c4a',
      'editorGutter.background': '#1b2038',
      'editorWidget.background': '#1b2038',
      'editorWidget.border': '#323a5e',
      'editorSuggestWidget.selectedBackground': '#2c3466',
    },
  });

  // Syntax errors in JavaScript are worth flagging; type-level guesses about
  // untyped page scripts mostly are not.
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  monaco.typescript.javascriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowJs: true,
    target: monaco.typescript.ScriptTarget.ESNext,
    lib: ['esnext', 'dom', 'dom.iterable'],
  });

  // A freshly created rule is empty by design; do not nag about it.
  monaco.css.cssDefaults.setOptions({ validate: true, lint: { emptyRules: 'ignore' } });
  monaco.css.scssDefaults.setOptions({ validate: true, lint: { emptyRules: 'ignore' } });
}

export function monacoTheme(theme: 'linen' | 'indigo'): string {
  return theme === 'indigo' ? 'wovenpage-indigo' : 'wovenpage-linen';
}

export function languageFor(path: string): string {
  switch (extname(path)) {
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.js':
    case '.mjs':
      return 'javascript';
    case '.json':
    case '.webmanifest':
      return 'json';
    case '.md':
      return 'markdown';
    case '.svg':
    case '.xml':
      return 'xml';
    default:
      return 'plaintext';
  }
}

export function uriFor(path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: 'site', path: '/' + path });
}

export function pathOf(uri: monaco.Uri): string | null {
  return uri.scheme === 'site' ? uri.path.replace(/^\//, '') : null;
}
