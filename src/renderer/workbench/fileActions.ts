/**
 * File-level commands: creating pages, stylesheets, layouts and parts;
 * renaming with link repair; deleting; attaching stylesheets; converting a
 * selection into a reusable part.
 */

import { appendRule } from '../../shared/css/model';
import { bindToLayout, listSlots, newLayout as layoutTemplate, newLayoutPage, newPlainPage, pageMeta, rebaseUrls } from '../../shared/compose';
import { outerText, parseHtml } from '../../shared/html/parse';
import { insertHtml, replaceElement } from '../../shared/html/patch';
import { basename, compiledCssPath, dirname, extname, fileKind, isSass, isSassPartial, join, normalize, relative } from '../../shared/paths';
import type { SelectionInfo } from '../../shared/protocol';
import { reindent } from '../../shared/text';
import { api } from '../core/api';
import { askForm, confirmAction } from '../core/ui';
import type { Shell } from './Shell';

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9/]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(name: string): string {
  return basename(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** The stylesheet new pages should link to: the first one in the site, if any. */
function defaultStylesheet(shell: Shell): string | null {
  const first = shell.index()?.stylesheets.find((s) => !isSassPartial(s));
  // Pages link the compiled stylesheet, never the Sass source.
  return first ? compiledCssPath(first) : null;
}

export async function newPage(shell: Shell, inDir = ''): Promise<void> {
  const index = shell.index();
  const layouts = index?.layouts ?? [];
  const values = await askForm({
    title: 'New page',
    fields: [
      { name: 'title', label: 'Page title', type: 'text', value: 'Untitled', required: true },
      { name: 'file', label: 'File name', type: 'text', placeholder: 'Leave empty to use the title', hint: inDir ? `Created in ${inDir}/` : 'Created in the site folder. Use a slash to place it in a subfolder.' },
      {
        name: 'layout',
        label: 'Layout',
        type: 'select',
        value: layouts[0]?.path ?? '',
        options: [...layouts.map((l) => ({ value: l.path, label: `${l.name} (${l.path})` })), { value: '', label: 'None - a standalone HTML page' }],
      },
    ],
    submit: 'Create page',
  });
  if (!values) return;
  const name = slug(values.file || values.title) || 'untitled';
  const path = join(inDir, `${name}.html`);
  let content: string;
  if (values.layout) {
    const layoutText = (await api.readFile(values.layout)).text;
    content = newLayoutPage(values.layout, listSlots(layoutText), values.title);
  } else {
    const css = defaultStylesheet(shell);
    content = newPlainPage(values.title, css ? relative(dirname(path), css) : undefined);
  }
  await api.createFile(path, content);
  await shell.refreshProject();
  await shell.openFile(path);
}

export async function newStylesheet(shell: Shell, inDir = 'css'): Promise<void> {
  const active = shell.activePath();
  const canAttach = !!active && fileKind(active) === 'html';
  const values = await askForm({
    title: 'New stylesheet',
    fields: [
      { name: 'file', label: 'File name', type: 'text', value: 'styles', required: true },
      {
        name: 'type',
        label: 'Language',
        type: 'select',
        value: 'css',
        options: [
          { value: 'css', label: 'CSS' },
          { value: 'scss', label: 'Sass (.scss), compiled to CSS for you' },
        ],
      },
      ...(canAttach ? [{ name: 'attach', label: `Link it from ${basename(active!)}`, type: 'checkbox' as const, value: true }] : []),
    ],
    submit: 'Create stylesheet',
  });
  if (!values) return;
  const name = slug(values.file.replace(/\.s?css$/i, '')) || 'styles';
  const path = join(inDir, `${name}.${values.type === 'scss' ? 'scss' : 'css'}`);
  await api.createFile(path, values.type === 'scss' ? `// ${titleCase(name)}\n` : `/* ${titleCase(name)} */\n`);
  await shell.refreshProject();
  if (values.attach && active) await attachStylesheet(shell, active, path);
  await shell.openFile(path);
}

export async function newLayout(shell: Shell): Promise<void> {
  const values = await askForm({
    title: 'New layout',
    intro: 'A layout is a full page with one or more slots. Pages that use it supply the content for each slot.',
    fields: [{ name: 'name', label: 'Layout name', type: 'text', value: 'base', required: true }],
    submit: 'Create layout',
  });
  if (!values) return;
  const dir = shell.project.manifest.layoutsDir;
  const path = join(dir, `${slug(values.name) || 'layout'}.html`);
  const css = defaultStylesheet(shell);
  await api.createFile(path, layoutTemplate(titleCase(values.name), css ? relative(dirname(path), css) : undefined));
  await shell.refreshProject();
  await shell.openFile(path);
}

export async function newPart(shell: Shell): Promise<void> {
  const values = await askForm({
    title: 'New part',
    intro: 'A part is a reusable fragment. Write {{name}} where a value should be supplied by each use.',
    fields: [{ name: 'name', label: 'Part name', type: 'text', value: 'card', required: true }],
    submit: 'Create part',
  });
  if (!values) return;
  const path = join(shell.project.manifest.partsDir, `${slug(values.name) || 'part'}.html`);
  await api.createFile(path, `<section class="${slug(values.name) || 'part'}">\n  <h2>{{heading | ${titleCase(values.name)}}}</h2>\n  <w-slot>\n    <p>Content goes here.</p>\n  </w-slot>\n</section>\n`);
  await shell.refreshProject();
  await shell.openFile(path);
}

export async function newFolder(shell: Shell, inDir = ''): Promise<void> {
  const values = await askForm({
    title: 'New folder',
    fields: [{ name: 'name', label: 'Folder name', type: 'text', required: true, hint: inDir ? `Created in ${inDir}/` : undefined }],
    submit: 'Create folder',
  });
  if (!values) return;
  await api.createFolder(join(inDir, values.name.replace(/[\\:*?"<>|]+/g, '-')));
  await shell.refreshProject();
}

export async function newFile(shell: Shell, inDir = ''): Promise<void> {
  const values = await askForm({
    title: 'New file',
    fields: [{ name: 'name', label: 'File name with extension', type: 'text', placeholder: 'script.js', required: true, hint: inDir ? `Created in ${inDir}/` : undefined }],
    submit: 'Create file',
  });
  if (!values) return;
  const path = join(inDir, values.name.replace(/[\\:*?"<>|]+/g, '-'));
  await api.createFile(path, '');
  await shell.refreshProject();
  await shell.openFile(path);
}

/** Saves everything, so link repair on disk sees current text and cannot clash with unsaved buffers. */
async function saveBeforeMove(shell: Shell): Promise<void> {
  await shell.docs.saveAll();
}

export async function movePath(shell: Shell, from: string, to: string): Promise<void> {
  const src = normalize(from);
  const dest = normalize(to);
  if (!dest || src === dest) return;
  await saveBeforeMove(shell);
  const { changed } = await api.renamePath(src, dest, true);
  // Tabs for moved files follow them.
  const moved = shell.docs.all().map((d) => d.path).filter((p) => p === src || p.startsWith(src + '/'));
  const wasActive = shell.activePath();
  for (const path of moved) {
    await shell.closeFile(path);
  }
  await shell.refreshProject();
  for (const path of moved) {
    const next = dest + path.slice(src.length);
    await shell.openFile(next);
  }
  if (wasActive && !moved.includes(wasActive)) await shell.openFile(wasActive);
  await shell.docs.reconcile(changed, true);
  shell.notify(changed.length ? `Moved, and updated links in ${changed.length} file${changed.length === 1 ? '' : 's'}.` : 'Moved.', 'success');
}

export async function renamePath(shell: Shell, path: string): Promise<void> {
  const values = await askForm({
    title: 'Rename',
    fields: [{ name: 'name', label: 'New name', type: 'text', value: basename(path), required: true, hint: 'Links to this file from other pages and stylesheets are updated.' }],
    submit: 'Rename',
    validate: (v) => (/[\\/:*?"<>|]/.test(v.name) ? 'A name cannot contain \\ / : * ? " < > |' : null),
  });
  if (!values || values.name === basename(path)) return;
  await movePath(shell, path, join(dirname(path), values.name));
}

export async function deletePath(shell: Shell, path: string, isDir: boolean): Promise<void> {
  const ok = await confirmAction(
    `Delete ${basename(path)}?`,
    isDir ? 'The folder and everything in it will be moved to the Recycle Bin.' : 'The file will be moved to the Recycle Bin. Links to it will stop working.',
    'Delete',
    true,
  );
  if (!ok) return;
  for (const doc of shell.docs.all()) {
    if (doc.path === path || doc.path.startsWith(path + '/')) {
      shell.docs.forget(doc.path);
      await shell.closeFile(doc.path);
    }
  }
  await api.deletePath(path);
  await shell.refreshProject();
}

export async function duplicatePath(shell: Shell, path: string): Promise<void> {
  const copy = await api.duplicatePath(path);
  await shell.refreshProject();
  if (extname(copy)) await shell.openFile(copy).catch(() => undefined);
}

export async function importFiles(shell: Shell, destDir: string, kind: 'any' | 'media'): Promise<string[]> {
  const added = await api.importFilesDialog(destDir, kind);
  if (added.length) {
    await shell.refreshProject();
    shell.notify(`Added ${added.length} file${added.length === 1 ? '' : 's'} to ${destDir || 'the site'}.`, 'success');
  }
  return added;
}

/**
 * Links a stylesheet from a page. If the page uses a layout, the link belongs
 * in the layout's <head>, so that is where it goes (and the user is told).
 */
export async function attachStylesheet(shell: Shell, pagePath: string, cssPath: string): Promise<void> {
  let target = pagePath;
  const pageDoc = await shell.docs.open(pagePath);
  const meta = pageMeta(pageDoc.model.getValue());
  if (meta?.layout) target = meta.layout;
  const doc = await shell.docs.open(target);
  const parsed = parseHtml(doc.model.getValue());
  const head = parsed.elements.find((el) => el.name === 'head');
  if (!head) throw new Error(`${target} has no <head> to link a stylesheet from.`);
  // A Sass file is linked by the name of the stylesheet it compiles to.
  const href = relative(dirname(target), compiledCssPath(cssPath));
  const already = parsed.elements.some((el) => el.name === 'link' && el.attrs.some((a) => a.name === 'href' && a.value === href));
  if (already) return shell.notify(`${basename(cssPath)} is already linked from ${target}.`);
  shell.docs.applyEdits(target, insertHtml(parsed, head.index, 'inside-end', `<link rel="stylesheet" href="${href}">`).edits, 'canvas-struct');
  shell.notify(target === pagePath ? `Linked ${basename(cssPath)}.` : `Linked ${basename(cssPath)} from the layout ${target}, so every page using it gets the styles.`, 'success');
}

/** Adds a class to the selection and creates an empty rule for it in a stylesheet. */
export async function newClassRule(shell: Shell, info: SelectionInfo): Promise<{ href: string; selector: string } | null> {
  const files = shell.index()?.files ?? [];
  // Only real CSS files can take a rule written from here; a stylesheet compiled from Sass has no rule to locate.
  const sheets = (info.sheets.length ? info.sheets : (shell.index()?.stylesheets ?? [])).filter((s) => files.includes(s) && !isSass(s));
  if (!sheets.length) {
    shell.notify(info.sheets.length ? 'The stylesheets on this page are written in Sass. Add the class and its rule in Source view, or link a plain CSS file.' : 'This page has no stylesheet yet. Create one from File > New Stylesheet, then try again.', 'error');
    return null;
  }
  const values = await askForm({
    title: 'New class rule',
    intro: `Adds a class to this <${info.tag}> and an empty rule for it. Styles you set afterwards are written to the rule, so other elements can share them.`,
    fields: [
      { name: 'name', label: 'Class name', type: 'text', placeholder: 'feature-card', required: true },
      { name: 'sheet', label: 'Stylesheet', type: 'select', options: sheets.map((s) => ({ value: s, label: s })) },
    ],
    submit: 'Create rule',
    validate: (v) => (/^-?[_a-zA-Z][\w-]*$/.test(v.name) ? null : 'Use letters, digits, hyphens and underscores, starting with a letter.'),
  });
  if (!values) return null;
  const selector = `.${values.name}`;
  const doc = await shell.docs.open(values.sheet);
  shell.docs.applyEdits(values.sheet, appendRule(doc.model.getValue(), selector), 'canvas-struct');
  if (!info.classes.includes(values.name)) {
    await shell.canvas.setAttribute(info, 'class', [...info.classes, values.name].join(' '));
  }
  return { href: values.sheet, selector };
}

/** Moves the selected element into a new part file and leaves a <w-part> in its place. */
export async function saveSelectionAsPart(shell: Shell, info: SelectionInfo): Promise<void> {
  const address = shell.canvas.resolve(info.id);
  if (!address) return;
  const values = await askForm({
    title: 'Save as part',
    intro: 'The selected element moves into its own file and can then be reused on any page.',
    fields: [{ name: 'name', label: 'Part name', type: 'text', value: info.classes[0] ?? info.tag, required: true }],
    submit: 'Save as part',
  });
  if (!values) return;
  const partPath = join(shell.project.manifest.partsDir, `${slug(values.name) || 'part'}.html`);
  const doc = await shell.docs.open(address.path);
  const parsed = parseHtml(doc.model.getValue());
  const el = parsed.elements[address.index];
  if (!el) return;
  // The markup moves to another folder, so its relative URLs must be rewritten to match.
  const html = rebaseUrls(outerText(parsed, el), dirname(address.path), dirname(partPath));
  await api.createFile(partPath, reindent(html, '') + '\n');
  shell.docs.applyEdits(address.path, replaceElement(parsed, address.index, `<w-part src="${partPath}"></w-part>`).edits, 'canvas-struct');
  await shell.refreshProject();
  shell.notify(`Saved as ${partPath}. Drag it from the Add panel to reuse it.`, 'success');
}

/** Binds the active page to a layout, converting a standalone page if necessary. */
export async function applyLayout(shell: Shell, pagePath: string, layoutPath: string): Promise<void> {
  const doc = await shell.docs.open(pagePath);
  const text = doc.model.getValue();
  const next = bindToLayout(text, layoutPath);
  if (next === text) return;
  shell.docs.applyEdits(pagePath, [{ start: 0, end: text.length, text: next }], 'canvas-struct');
  shell.notify(`This page now uses ${layoutPath}.`, 'success');
}
