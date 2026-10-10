import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectService } from '../src/main/services/ProjectService';
import { PreviewServer } from '../src/main/services/PreviewServer';
import { SearchService, globFilter } from '../src/main/services/SearchService';
import { BuildService } from '../src/main/services/BuildService';
import { LintService, lintJs } from '../src/main/services/LintService';
import { DeployService, SecretStore } from '../src/main/services/DeployService';
import { remoteJoin } from '../src/main/transports/Transport';
import type { DeployProgress, DeployTarget } from '../src/shared/types';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wovenpage-test-'));

async function starter(): Promise<ProjectService> {
  return ProjectService.create(path.join(temp(), 'site'), 'Test site', 'starter');
}

class MemorySecrets implements SecretStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string | null) {
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
  }
}

// ---------------------------------------------------------------- project

test('project: create, tree, index', async () => {
  const project = await starter();
  const files = await project.listFiles();
  assert.ok(files.includes('index.html') && files.includes('layouts/base.html') && files.includes('wovenpage.json'));
  const index = await project.index();
  assert.deepEqual(index.pages, ['classes.html', 'index.html', 'visit.html']);
  assert.deepEqual(index.layouts.map((l) => [l.path, l.slots]), [['layouts/base.html', ['main']]]);
  assert.deepEqual(index.parts.find((p) => p.path === 'parts/class-card.html')!.params.sort(), ['heading', 'when']);
  assert.ok(index.classes.includes('hero') && index.customProperties.includes('--clay'));
  assert.ok(index.ids.includes('site-nav'));
});

test('project: paths cannot escape the site folder', async () => {
  const project = await starter();
  assert.throws(() => project.abs('../outside.txt'), /outside the site folder/);
  assert.throws(() => project.abs('/etc/passwd'), /outside the site folder/);
  assert.throws(() => project.abs('css/../../x'), /outside the site folder/);
  await assert.rejects(project.write('../../evil.txt', 'x'), /outside the site folder/);
});

test('project: renaming a file repairs every link to it', async () => {
  const project = await starter();
  const { changed } = await project.rename('css/site.css', 'styles/main.css', true);
  assert.deepEqual(changed, ['layouts/base.html']);
  assert.match(project.readSync('layouts/base.html')!, /href="\.\.\/styles\/main\.css"/);

  // A part is referenced by root-relative path from pages.
  const second = await project.rename('parts/class-card.html', 'parts/course.html', true);
  assert.deepEqual(second.changed, ['classes.html']);
  assert.equal((project.readSync('classes.html')!.match(/src="parts\/course\.html"/g) ?? []).length, 3);

  // Moving a page into a folder rewrites its own relative links and links pointing at it.
  await project.rename('visit.html', 'info/visit.html', true);
  assert.match(project.readSync('parts/site-header.html')!, /href="\.\.\/info\/visit\.html"/);
  assert.match(project.readSync('parts/course.html')!, /href="\.\.\/info\/visit\.html"/);

  // Nothing is broken afterwards.
  const problems = await new LintService(project).lintProject();
  assert.deepEqual(Object.values(problems).flat().filter((d) => d.code === 'broken-link'), []);
});

test('project: renaming a folder moves everything inside and repairs links', async () => {
  const project = await starter();
  await project.rename('assets', 'media/img', true);
  assert.match(project.readSync('index.html')!, /src="media\/img\/shelf\.svg"/);
  assert.match(project.readSync('parts/site-header.html')!, /src="\.\.\/media\/img\/mark\.svg"/);
  const problems = await new LintService(project).lintProject();
  assert.deepEqual(Object.values(problems).flat().filter((d) => d.code === 'broken-link'), []);
});

// ---------------------------------------------------------------- preview

async function withPreview<T>(fn: (project: ProjectService, preview: PreviewServer, get: (p: string, headers?: Record<string, string>) => Promise<Response>) => Promise<T>): Promise<T> {
  const project = await starter();
  const preview = new PreviewServer(project, { agent: () => '/*agent*/', live: () => '/*live*/' });
  const origin = await preview.start();
  try {
    return await fn(project, preview, (p, headers) => fetch(origin + p, { headers }));
  } finally {
    await preview.stop();
  }
}

test('preview: serves composed pages with live reload, and instrumented pages for the canvas', async () => {
  await withPreview(async (_project, _preview, get) => {
    const plain = await (await get('/classes.html')).text();
    assert.match(plain, /<script src="\/__wp\/live\.js" async><\/script>/);
    assert.match(plain, /<h3>First pots<\/h3>/);
    assert.doesNotMatch(plain, /data-wp|<w-/);

    const canvas = await (await get('/classes.html?__wp=canvas&e=7')).text();
    assert.match(canvas, /window\.__WOVENPAGE__=\{"epoch":7,"files":\["classes\.html","layouts\/base\.html","parts\/class-card\.html","parts\/site-header\.html","parts\/site-footer\.html"\]/);
    assert.match(canvas, /<script src="\/__wp\/agent\.js"><\/script>/);
    assert.match(canvas, /<h1 data-wp="0:\d+">Classes<\/h1>/);
    // roots of part expansions carry the instance address in the page file
    assert.equal((canvas.match(/<article data-wp-inst="0:\d+" data-wp="2:0" class="class-card">/g) ?? []).length, 3);

    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Pots made slowly/);
    assert.equal((await get('/css/site.css')).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await get('/nope.html')).status, 404);
    assert.equal((await get('/..%2f..%2fetc/passwd')).status, 404);
    assert.equal((await get('/wovenpage.json')).status, 200);
  });
});

test('preview: unsaved buffers override disk, and parts preview inside a layout', async () => {
  await withPreview(async (project, preview, get) => {
    preview.setOverlay('css/site.css', 'body { color: rebeccapurple; }');
    assert.equal(await (await get('/css/site.css')).text(), 'body { color: rebeccapurple; }');
    preview.setOverlay('index.html', project.readSync('index.html')!.replace('Pots made slowly', 'Unsaved heading'));
    assert.match(await (await get('/index.html')).text(), /Unsaved heading/);
    preview.clearOverlay('index.html');
    assert.match(await (await get('/index.html')).text(), /Pots made slowly/);

    // A part on its own is a fragment; the preview wraps it in the site's layout so it is styled.
    const part = await (await get('/parts/class-card.html?__wp=canvas')).text();
    assert.match(part, /<link[^>]+href="\.\.\/css\/site\.css"/);
    assert.match(part, /<article data-wp="2:0" class="class-card">/);
    assert.match(part, /<h3 data-wp="2:2">Untitled class<\/h3>/);
    assert.match(part, /"files":\["parts\/__part-preview__\.html",/);
    assert.doesNotMatch(part, /data-wp(-inst)?="0:/, 'nothing may address the virtual wrapper page');
    assert.match(part, /"path":"parts\/class-card\.html"/);
  });
});

test('preview: refuses other hosts and answers range requests', async () => {
  await withPreview(async (project, preview, get) => {
    const port = new URL(preview.origin).port;
    const res = await new Promise<number>((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (r: { statusCode: number; resume(): void }) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res, 403);

    await project.write('assets/data.bin', 'abcdefghij');
    const ranged = await get('/assets/data.bin', { range: 'bytes=2-5' });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'cdef');
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  });
});

test('preview: notifies connected browsers of changes', async () => {
  await withPreview(async (_project, preview) => {
    const res = await fetch(preview.origin + '/__wp/events');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"
    preview.setOverlay('css/site.css', 'a{}');
    const css = decoder.decode((await reader.read()).value);
    assert.match(css, /"kind":"css","paths":\["css\/site\.css"\]/);
    preview.setOverlay('index.html', '<p>x</p>');
    assert.match(decoder.decode((await reader.read()).value), /"kind":"reload"/);
    await reader.cancel();
  });
});

// ----------------------------------------------------------------- search

test('search: finds, filters and replaces across the site', async () => {
  const project = await starter();
  const search = new SearchService(project);
  const base = { regex: false, caseSensitive: false, wholeWord: false, include: '' };

  const all = await search.search({ ...base, text: 'fernhill' });
  assert.ok(all.total >= 6, `expected at least 6 matches, got ${all.total}`);
  assert.ok(all.files.some((f) => f.path === 'parts/site-header.html'));
  const first = all.files.find((f) => f.path === 'parts/site-footer.html')!.matches[0];
  assert.equal(first.line, 2);
  assert.equal(first.preview.slice(first.previewStart, first.previewStart + first.previewLength), 'Fernhill');

  assert.equal((await search.search({ ...base, text: 'fernhill', caseSensitive: true })).files.some((f) => f.path === 'parts/site-header.html'), false);
  const onlyCss = await search.search({ ...base, text: 'var\\(--(\\w+)\\)', regex: true, include: '*.css' });
  assert.deepEqual(onlyCss.files.map((f) => f.path), ['css/site.css']);
  assert.equal((await search.search({ ...base, text: 'card', wholeWord: true })).total, 0, '"card" only appears inside class-card');
  assert.match((await search.search({ ...base, text: '(', regex: true })).error!, /not a valid regular expression/);

  // unsaved buffers are searched instead of the file on disk
  const overlay = await search.search({ ...base, text: 'zebra' }, { 'index.html': '<p>zebra</p>' });
  assert.deepEqual(overlay.files.map((f) => f.path), ['index.html']);

  const done = await search.replaceInFiles({ ...base, text: 'var\\(--clay\\)', regex: true }, 'var(--terracotta)', ['css/site.css']);
  assert.deepEqual(done, [{ path: 'css/site.css', count: 3 }]);
  assert.equal(project.readSync('css/site.css')!.includes('var(--clay)'), false);

  const groups = await search.replaceInFiles({ ...base, text: '<h3>(.*?)</h3>', regex: true }, '<h4>$1</h4>', ['parts/class-card.html']);
  assert.equal(groups[0].count, 1);
  assert.match(project.readSync('parts/class-card.html')!, /<h4>\{\{heading \| Untitled class\}\}<\/h4>/);
});

test('search: globs', () => {
  assert.equal(globFilter('*.html')('blog/post.html'), true);
  assert.equal(globFilter('*.html')('css/site.css'), false);
  assert.equal(globFilter('css/**')('css/a/b.css'), true);
  assert.equal(globFilter('css/*')('css/a/b.css'), false);
  assert.equal(globFilter('*.css, parts/**')('parts/x.html'), true);
  assert.equal(globFilter('')('anything'), true);
});

// ------------------------------------------------------------- build, lint

test('build: composes pages and leaves authoring files out', async () => {
  const project = await starter();
  const result = await new BuildService(project).build();
  assert.equal(result.pages, 3);
  assert.deepEqual(result.issues, []);
  assert.ok(!result.files.some((f) => f.startsWith('layouts/') || f.startsWith('parts/') || f === 'wovenpage.json'));
  const out = (p: string) => fs.readFileSync(path.join(project.root, '_site', p), 'utf8');
  assert.match(out('index.html'), /^<!doctype html>/);
  assert.match(out('index.html'), /<title>Studio - Fernhill Pottery<\/title>/);
  assert.match(out('index.html'), /<link rel="stylesheet" href="css\/site\.css">/);
  assert.doesNotMatch(out('classes.html'), /<w-|\{\{|__wp|data-wp/);
  assert.equal(out('css/site.css'), project.readSync('css/site.css'));
  // The build folder is not part of the site: it is not listed, searched or rebuilt into itself.
  assert.ok(!(await project.listFiles()).some((f) => f.startsWith('_site/')));
  const again = await new BuildService(project).build();
  assert.deepEqual(again.files, result.files);
});

test('lint: whole-site check reports broken links and syntax errors', async () => {
  const project = await starter();
  assert.deepEqual(await new LintService(project).lintProject(), {});
  await project.write('broken.html', '<!doctype html><html lang="en"><body><img src="assets/missing.png" alt=""><div></body></html>');
  await project.write('js/bad.js', 'const x = ;');
  await project.write('css/bad.css', '.a { color: red;');
  const problems = await new LintService(project).lintProject();
  assert.deepEqual(problems['broken.html'].map((d) => d.code).sort(), ['broken-link', 'unclosed-element']);
  assert.equal(problems['js/bad.js'][0].code, 'js-syntax');
  assert.deepEqual([problems['js/bad.js'][0].line, problems['js/bad.js'][0].col], [1, 11]);
  assert.equal(problems['css/bad.css'][0].code, 'unclosed-block');
  assert.deepEqual(lintJs('import a from "./a.js"; export const b = await a();'), []);
  assert.deepEqual(lintJs('with (obj) { run(); }'), []);
});

// ---------------------------------------------------------------- publish

test('publish: plans from the ledger, uploads only changes, prunes only its own files', async () => {
  const project = await starter();
  const dest = path.join(temp(), 'www');
  const target: DeployTarget = { id: 't1', name: 'Local', protocol: 'folder', host: '', port: 0, user: '', remoteRoot: dest, auth: 'password', prune: true };
  await project.saveManifest({ ...project.manifest, targets: [target] });
  const deploy = new DeployService(project, new BuildService(project), new MemorySecrets());
  const progress: DeployProgress[] = [];

  assert.deepEqual(await deploy.test(target), { ok: true, message: 'The folder is writable.' });

  let plan = await deploy.plan('t1', false);
  assert.equal(plan.lastPublished, null);
  assert.ok(plan.items.every((i) => i.action === 'upload' && i.reason === 'new'));
  const total = plan.items.length;

  let result = await deploy.publish('t1', false, (p) => progress.push(p));
  assert.equal(result.ok, true);
  assert.equal(result.uploaded, total);
  assert.equal(progress.at(-1)!.phase, 'done');
  assert.ok(fs.existsSync(path.join(dest, 'css/site.css')));
  assert.match(fs.readFileSync(path.join(dest, 'visit.html'), 'utf8'), /Visit the studio/);

  // Nothing changed: nothing to do.
  plan = await deploy.plan('t1', false);
  assert.ok(plan.items.every((i) => i.action === 'skip'));
  assert.ok(plan.lastPublished);

  // Someone else's file on the server must survive a prune.
  fs.writeFileSync(path.join(dest, 'uploaded-by-someone-else.txt'), 'keep me');

  // Change a part (affects one page), delete a page, add a file.
  await project.write('parts/class-card.html', project.readSync('parts/class-card.html')!.replace('Ask about a place', 'Book a place'));
  await project.remove('visit.html');
  await project.write('robots.txt', 'User-agent: *\n');
  plan = await deploy.plan('t1', false);
  const by = (action: string) => plan.items.filter((i) => i.action === action).map((i) => i.path).sort();
  assert.deepEqual(by('upload'), ['classes.html', 'robots.txt']);
  assert.deepEqual(by('delete'), ['visit.html']);

  result = await deploy.publish('t1', false, () => undefined);
  assert.deepEqual([result.ok, result.uploaded, result.deleted], [true, 2, 1]);
  assert.ok(!fs.existsSync(path.join(dest, 'visit.html')));
  assert.ok(fs.existsSync(path.join(dest, 'uploaded-by-someone-else.txt')));
  assert.match(fs.readFileSync(path.join(dest, 'classes.html'), 'utf8'), /Book a place/);

  // "Upload everything" ignores the ledger.
  plan = await deploy.plan('t1', true);
  assert.ok(plan.items.filter((i) => i.action !== 'delete').every((i) => i.reason === 'forced'));

  // The ledger lives in the per-machine state folder, which is never built or published.
  assert.ok(fs.existsSync(path.join(project.root, '.wovenpage/publish-t1.json')));
  assert.ok(!fs.existsSync(path.join(dest, '.wovenpage')));
});

test('publish: build errors block publishing; missing credentials are explained', async () => {
  const project = await starter();
  const dest = path.join(temp(), 'www');
  const folder: DeployTarget = { id: 'f', name: 'Folder', protocol: 'folder', host: '', port: 0, user: '', remoteRoot: dest, auth: 'password', prune: false };
  const sftp: DeployTarget = { id: 's', name: 'Server', protocol: 'sftp', host: 'example.invalid', port: 22, user: 'me', remoteRoot: 'public_html', auth: 'password', prune: false };
  await project.saveManifest({ ...project.manifest, targets: [folder, sftp] });
  const deploy = new DeployService(project, new BuildService(project), new MemorySecrets());

  await project.write('index.html', '<w-page layout="layouts/missing.html"><w-fill slot="main"><p>x</p></w-fill></w-page>');
  const blocked = await deploy.publish('f', false, () => undefined);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message!, /build error/);
  assert.ok(!fs.existsSync(dest));

  assert.deepEqual(await deploy.test(sftp), { ok: false, message: 'Enter the password for this destination.' });
  assert.equal(await deploy.hasPassword('s'), false);
  await deploy.setPassword('s', 'secret');
  assert.equal(await deploy.hasPassword('s'), true);
});

test('publish: remote paths', () => {
  assert.equal(remoteJoin('public_html', 'css/site.css'), './public_html/css/site.css');
  assert.equal(remoteJoin('/var/www/site/', 'index.html'), '/var/www/site/index.html');
  assert.equal(remoteJoin('', 'index.html'), './index.html');
  assert.equal(remoteJoin('/', 'index.html'), '/index.html');
});

test('preview: only the app origin may read files cross-origin', async () => {
  await withPreview(async (_project, _preview, get) => {
    assert.equal((await get('/assets/mark.svg', { origin: 'wp://app' })).headers.get('access-control-allow-origin'), 'wp://app');
    assert.equal((await get('/assets/mark.svg', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
    assert.equal((await get('/assets/mark.svg')).headers.get('access-control-allow-origin'), null);
  });
});

// ------------------------------------------------------------------- Sass

import { compileSass } from '../src/main/services/SassCompiler';

const SCSS = `@use "tokens" as t;
// a comment with a brace { and a quote '
.promo {
  padding: t.$gap;
  color: t.$brand;
  &__title { font-weight: 700; }
  @media (min-width: 40rem) { padding: t.$gap * 2; }
}
`;
const TOKENS = `$gap: 8px;\n$brand: #8c4a32;\n:root { --promo-gap: #{$gap}; }\n`;

test('sass: compiles with partials, reports errors with a position', () => {
  const files: Record<string, string> = { 'css/promo.scss': SCSS, 'css/_tokens.scss': TOKENS };
  const ok = compileSass('css/promo.scss', (p) => files[p] ?? null);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.files, ['css/promo.scss', 'css/_tokens.scss']);
  assert.match(ok.css, /\.promo \{\n  padding: 8px;\n  color: #8c4a32;\n\}/);
  assert.match(ok.css, /\.promo__title \{\n  font-weight: 700;\n\}/);
  assert.match(ok.css, /@media \(min-width: 40rem\) \{\n  \.promo \{\n    padding: 16px;/);
  assert.match(ok.css, /--promo-gap: 8px;/);

  const bad = compileSass('css/promo.scss', (p) => (p === 'css/promo.scss' ? '.a {\n  color: $missing;\n}\n' : null));
  assert.equal(bad.css, '');
  assert.deepEqual([bad.error!.file, bad.error!.line], ['css/promo.scss', 2]);
  assert.match(bad.error!.message, /Undefined variable/);

  const inPartial = compileSass('css/promo.scss', (p) => ({ 'css/promo.scss': '@use "tokens";', 'css/_tokens.scss': '.x { color: }' })[p] ?? null);
  assert.equal(inPartial.error!.file, 'css/_tokens.scss');
  assert.match(compileSass('nope.scss', () => null).error!.message, /does not exist/);
});

test('sass: previewed on request, built to CSS, linted, and followed by link repair', async () => {
  const project = await starter();
  await project.write('css/promo.scss', SCSS);
  await project.write('css/_tokens.scss', TOKENS);
  await project.write('layouts/base.html', project.readSync('layouts/base.html')!.replace('</head>', '  <link rel="stylesheet" href="../css/promo.css">\n</head>'));

  // preview: promo.css does not exist on disk, but is served compiled; unsaved partial edits count
  const preview = new PreviewServer(project, { agent: () => '', live: () => '' });
  const origin = await preview.start();
  try {
    const css = await fetch(origin + '/css/promo.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.match(await css.text(), /\.promo \{\n  padding: 8px;/);
    preview.setOverlay('css/_tokens.scss', TOKENS.replace('8px', '10px'));
    assert.match(await (await fetch(origin + '/css/promo.css')).text(), /padding: 10px;/);
    preview.clearOverlay('css/_tokens.scss');
    // a compile error is shown on the page rather than leaving it silently unstyled
    preview.setOverlay('css/promo.scss', '.a { color: $nope; }');
    assert.match(await (await fetch(origin + '/css/promo.css')).text(), /body::before \{\n  content: "Sass error in css\/promo\.scss, line 1: Undefined variable\./);
    preview.clearOverlay('css/promo.scss');
    assert.equal((await fetch(origin + '/css/_tokens.css')).status, 404, 'partials are not stylesheets');
    assert.equal((await fetch(origin + '/css/missing.css')).status, 404);
  } finally {
    await preview.stop();
  }

  // the link to the compiled stylesheet is not "broken", and the site is clean
  assert.deepEqual(await new LintService(project).lintProject(), {});
  const index = await project.index();
  assert.ok(index.stylesheets.includes('css/promo.scss') && index.classes.includes('promo') && index.customProperties.includes('--promo-gap'));

  // build: compiled CSS is written; Sass sources and partials are not published
  const built = await new BuildService(project).build();
  assert.deepEqual(built.issues, []);
  assert.ok(built.files.includes('css/promo.css'));
  assert.ok(!built.files.some((f) => f.endsWith('.scss')));
  assert.match(fs.readFileSync(path.join(project.root, '_site/css/promo.css'), 'utf8'), /\.promo__title/);
  assert.ok(!fs.existsSync(path.join(project.root, '_site/css/_tokens.scss')));

  // errors: reported by lint (in the file that has them) and block the build
  await project.write('css/_tokens.scss', '$gap: ;');
  const problems = await new LintService(project).lintProject();
  assert.deepEqual(Object.keys(problems), ['css/_tokens.scss']);
  assert.equal(problems['css/_tokens.scss'][0].code, 'sass-error');
  const failed = await new BuildService(project).build();
  assert.equal(failed.issues[0].severity, 'error');
  assert.match(failed.issues[0].message, /^Sass, line 1:/);
  await project.write('css/_tokens.scss', TOKENS);

  // renaming the Sass file updates the link to the stylesheet it compiles to
  const { changed } = await project.rename('css/promo.scss', 'styles/campaign.scss', true);
  assert.deepEqual(changed, ['layouts/base.html']);
  assert.match(project.readSync('layouts/base.html')!, /href="\.\.\/styles\/campaign\.css"/);
});
