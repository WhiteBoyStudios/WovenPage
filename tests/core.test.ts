import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEdits, detectIndentUnit, reindent } from '../src/shared/text';
import { relative, join, normalize } from '../src/shared/paths';
import { parseHtml, elementAt, attrValue } from '../src/shared/html/parse';
import { instrument } from '../src/shared/html/instrument';
import {
  setAttribute,
  setInlineStyle,
  setInnerHtml,
  removeElement,
  insertHtml,
  moveElement,
  duplicateElement,
  parseInlineStyle,
  PatchResult,
} from '../src/shared/html/patch';
import { parseCss, setDeclaration, appendRule, locateRule, collectFacts } from '../src/shared/css/model';
import { composePage, bindToLayout, listSlots, listParams, pageMeta } from '../src/shared/compose';
import { scanLinks, resolveLink, retargetLinks } from '../src/shared/links';
import { lintHtml, lintCss } from '../src/shared/lint';

const apply = (text: string, r: PatchResult) => applyEdits(text, r.edits);
const find = (text: string, name: string, nth = 0) => parseHtml(text).elements.filter((e) => e.name === name)[nth].index;

// ------------------------------------------------------------------ paths

test('relative paths', () => {
  assert.equal(relative('', 'css/site.css'), 'css/site.css');
  assert.equal(relative('blog', 'css/site.css'), '../css/site.css');
  assert.equal(relative('blog/2024', 'blog/img/a.png'), '../img/a.png');
  assert.equal(relative('a/b', 'a/b/c.html'), 'c.html');
  assert.equal(join('blog', '../css/x.css'), 'css/x.css');
  assert.equal(normalize('a//b/./c/../d'), 'a/b/d');
});

// ----------------------------------------------------------------- parser

test('parser records exact ranges', () => {
  const src = '<!doctype html>\n<div class="a" id=main>\n  <p>Hi <b>there</b></p>\n  <img src="x.png">\n</div>\n';
  const doc = parseHtml(src);
  assert.deepEqual(doc.elements.map((e) => e.name), ['div', 'p', 'b', 'img']);
  const [div, p, b, img] = doc.elements;
  assert.equal(src.slice(div.start, div.end), src.trim().slice('<!doctype html>\n'.length));
  assert.equal(src.slice(p.start, p.end), '<p>Hi <b>there</b></p>');
  assert.equal(src.slice(b.openEnd, b.closeStart), 'there');
  assert.equal(img.isVoid, true);
  assert.equal(src.slice(img.start, img.end), '<img src="x.png">');
  assert.equal(attrValue(div, 'id'), 'main');
  assert.equal(doc.hasDoctype, true);
  assert.equal(doc.issues.length, 0);
  assert.equal(elementAt(doc, src.indexOf('there'))!.name, 'b');
});

test('parser handles implied end tags, raw text and comments', () => {
  const src = '<ul><li>one<li>two</ul><p>a<div>b</div><script>if (a < b) { x = "</div>"; }</script><!-- <b> -->';
  const doc = parseHtml(src);
  assert.deepEqual(doc.elements.map((e) => e.name), ['ul', 'li', 'li', 'p', 'div', 'script']);
  assert.equal(src.slice(doc.elements[1].start, doc.elements[1].end), '<li>one');
  assert.equal(doc.elements[3].implicitEnd, true);
  assert.equal(doc.issues.filter((i) => i.severity === 'error').length, 0);
});

test('parser reports unclosed and stray tags', () => {
  const doc = parseHtml('<div><span>text</div></section>');
  const codes = doc.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['stray-end-tag', 'unclosed-element']);
});

test('instrumentation stamps every open tag and nothing else', () => {
  const src = '<main>\n  <h1 class="t">Hi</h1>\n  <br>\n  <script>var a = "<p>";</script>\n</main>';
  const out = instrument(src, 3);
  assert.equal(out, '<main data-wp="3:0">\n  <h1 data-wp="3:1" class="t">Hi</h1>\n  <br data-wp="3:2">\n  <script data-wp="3:3">var a = "<p>";</script>\n</main>');
  // Re-parsing the instrumented text yields the same element order.
  assert.deepEqual(parseHtml(out).elements.map((e) => attrValue(e, 'data-wp')), ['3:0', '3:1', '3:2', '3:3']);
});

// ---------------------------------------------------------------- patcher

test('setAttribute adds, replaces and removes without touching the rest', () => {
  const src = '<a class="btn" href="a.html">Go</a>';
  let doc = parseHtml(src);
  assert.equal(apply(src, setAttribute(doc, 0, 'href', 'b.html?x=1&y=2')), '<a class="btn" href="b.html?x=1&amp;y=2">Go</a>');
  assert.equal(apply(src, setAttribute(doc, 0, 'title', 'Say "hi"')), '<a class="btn" href="a.html" title="Say &quot;hi&quot;">Go</a>');
  assert.equal(apply(src, setAttribute(doc, 0, 'class', null)), '<a href="a.html">Go</a>');
  const bare = '<input disabled>';
  doc = parseHtml(bare);
  assert.equal(apply(bare, setAttribute(doc, 0, 'type', 'text')), '<input disabled type="text">');
});

test('setInlineStyle merges declarations', () => {
  const src = '<div style="color: red; background: url(a;b.png)">x</div>';
  const doc = parseHtml(src);
  assert.deepEqual(parseInlineStyle('color: red; background: url(a;b.png)').map((d) => d.prop), ['color', 'background']);
  assert.equal(
    apply(src, setInlineStyle(doc, 0, { color: 'blue', width: '10px' })),
    '<div style="color: blue; background: url(a;b.png); width: 10px;">x</div>',
  );
  assert.equal(apply(src, setInlineStyle(doc, 0, { color: null, background: null })), '<div>x</div>');
  const plain = '<p>x</p>';
  assert.equal(apply(plain, setInlineStyle(parseHtml(plain), 0, { margin: '0' })), '<p style="margin: 0;">x</p>');
});

test('removeElement takes its line with it', () => {
  const src = '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n';
  assert.equal(apply(src, removeElement(parseHtml(src), find(src, 'li', 1))), '<ul>\n  <li>a</li>\n</ul>\n');
  const inline = '<p>a <b>b</b> c</p>';
  assert.equal(apply(inline, removeElement(parseHtml(inline), 1)), '<p>a  c</p>');
});

test('insertHtml follows the surrounding indentation', () => {
  const src = '<main>\n    <section>\n        <h1>A</h1>\n    </section>\n</main>\n';
  const doc = parseHtml(src);
  const h1 = find(src, 'h1');
  const section = find(src, 'section');
  assert.equal(detectIndentUnit(src), '    ');
  assert.equal(apply(src, insertHtml(doc, h1, 'after', '<p>B</p>')), '<main>\n    <section>\n        <h1>A</h1>\n        <p>B</p>\n    </section>\n</main>\n');
  assert.equal(apply(src, insertHtml(doc, h1, 'before', '<p>B</p>')), '<main>\n    <section>\n        <p>B</p>\n        <h1>A</h1>\n    </section>\n</main>\n');
  assert.equal(apply(src, insertHtml(doc, section, 'inside-end', '<p>B</p>')), '<main>\n    <section>\n        <h1>A</h1>\n        <p>B</p>\n    </section>\n</main>\n');
  assert.equal(apply(src, insertHtml(doc, section, 'inside-start', '<p>B</p>')), '<main>\n    <section>\n        <p>B</p>\n        <h1>A</h1>\n    </section>\n</main>\n');

  const multi = insertHtml(doc, h1, 'after', '<div>\n  <p>B</p>\n</div>');
  assert.equal(apply(src, multi), '<main>\n    <section>\n        <h1>A</h1>\n        <div>\n          <p>B</p>\n        </div>\n    </section>\n</main>\n');
  // focus lands on the new element
  const after = apply(src, multi);
  assert.equal(elementAt(parseHtml(after), multi.focus)!.name, 'div');

  const empty = '<body>\n  <div class="box"></div>\n</body>';
  assert.equal(apply(empty, insertHtml(parseHtml(empty), 1, 'inside-end', '<p>x</p>')), '<body>\n  <div class="box">\n    <p>x</p>\n  </div>\n</body>');
});

test('moveElement reorders siblings and reparents', () => {
  const src = '<ul>\n  <li>a</li>\n  <li>b</li>\n  <li>c</li>\n</ul>\n<ol>\n</ol>\n';
  const doc = parseHtml(src);
  const li = (n: number) => find(src, 'li', n);
  let r = moveElement(doc, li(2), li(0), 'before');
  let out = apply(src, r);
  assert.equal(out, '<ul>\n  <li>c</li>\n  <li>a</li>\n  <li>b</li>\n</ul>\n<ol>\n</ol>\n');
  assert.equal(out.slice(r.focus, r.focus + 10), '<li>c</li>');

  r = moveElement(doc, li(0), li(2), 'after');
  out = apply(src, r);
  assert.equal(out, '<ul>\n  <li>b</li>\n  <li>c</li>\n  <li>a</li>\n</ul>\n<ol>\n</ol>\n');
  assert.equal(out.slice(r.focus, r.focus + 10), '<li>a</li>');

  r = moveElement(doc, li(1), find(src, 'ol'), 'inside-end');
  out = apply(src, r);
  assert.equal(out, '<ul>\n  <li>a</li>\n  <li>c</li>\n</ul>\n<ol>\n  <li>b</li>\n</ol>\n');
  assert.equal(out.slice(r.focus, r.focus + 10), '<li>b</li>');

  // moving to where it already is changes nothing
  assert.equal(apply(src, moveElement(doc, li(1), li(0), 'after')), src);
  assert.equal(apply(src, moveElement(doc, li(1), li(2), 'before')), src);
  // last child to the end of its own parent
  assert.equal(apply(src, moveElement(doc, li(2), find(src, 'ul'), 'inside-end')), src);
  assert.throws(() => moveElement(doc, find(src, 'ul'), li(0), 'before'));
});

test('duplicate and setInnerHtml', () => {
  const src = '<div>\n  <p>a</p>\n</div>';
  const doc = parseHtml(src);
  assert.equal(apply(src, duplicateElement(doc, 1)), '<div>\n  <p>a</p>\n  <p>a</p>\n</div>');
  assert.equal(apply(src, setInnerHtml(doc, 1, 'b <em>c</em>')), '<div>\n  <p>b <em>c</em></p>\n</div>');
});

test('reindent strips the fragment\'s own indentation', () => {
  assert.equal(reindent('    <div>\n      <p>x</p>\n    </div>', '\t'), '<div>\n\t  <p>x</p>\n\t</div>');
});

// -------------------------------------------------------------------- css

const CSS = `:root { --brand: #234; }

.card {
  color: red;
  padding: 1rem 2rem;
}

@media (min-width: 40rem) {
  .card { color: blue }
  .card:hover {
    color: green;
    & .title { font-weight: 700; }
  }
}

@font-face {
  font-family: "Body";
  src: url(../fonts/body.woff2);
}

@keyframes spin { from { rotate: 0deg } to { rotate: 1turn } }
`;

test('css parser numbers style rules depth-first', () => {
  const model = parseCss(CSS);
  assert.equal(model.issues.length, 0);
  assert.deepEqual(model.styleRules.map((r) => r.selector), [':root', '.card', '.card', '.card:hover', '& .title']);
  assert.deepEqual(model.styleRules[2].context, ['@media (min-width: 40rem)']);
  assert.deepEqual(model.styleRules[1].decls.map((d) => [d.prop, d.value]), [['color', 'red'], ['padding', '1rem 2rem']]);
  const facts = collectFacts(model);
  assert.deepEqual(facts.classes, ['card', 'title']);
  assert.deepEqual(facts.customProperties, ['--brand']);
  assert.deepEqual(facts.fontFamilies, ['Body']);
});

test('setDeclaration replaces, adds and removes in place', () => {
  const model = parseCss(CSS);
  const card = model.styleRules[1];
  assert.match(applyEdits(CSS, setDeclaration(model, card, 'color', 'var(--brand)')), /\.card \{\n  color: var\(--brand\);\n  padding: 1rem 2rem;\n\}/);
  assert.match(applyEdits(CSS, setDeclaration(model, card, 'gap', '4px')), /\.card \{\n  color: red;\n  padding: 1rem 2rem;\n  gap: 4px;\n\}/);
  assert.match(applyEdits(CSS, setDeclaration(model, card, 'color', null)), /\.card \{\n  padding: 1rem 2rem;\n\}/);
  // single-line rule with an unterminated last declaration
  const oneLine = model.styleRules[2];
  assert.match(applyEdits(CSS, setDeclaration(model, oneLine, 'margin', '0')), /\.card \{ color: blue; margin: 0; \}/);
  // declarations go ahead of nested rules
  const hover = model.styleRules[3];
  assert.match(applyEdits(CSS, setDeclaration(model, hover, 'opacity', '.5')), /color: green;\n    opacity: \.5;\n    & \.title/);
  // every result still parses cleanly
  for (const rule of model.styleRules) {
    const next = applyEdits(CSS, setDeclaration(model, rule, 'outline', '1px solid'));
    assert.equal(parseCss(next).issues.length, 0);
    assert.equal(parseCss(next).styleRules[rule.ordinal].decls.at(-1)!.prop, 'outline');
  }
  const emptyRule = '.a {}';
  assert.equal(applyEdits(emptyRule, setDeclaration(parseCss(emptyRule), parseCss(emptyRule).styleRules[0], 'color', 'red')), '.a { color: red; }');
});

test('locateRule tolerates drift and appendRule appends', () => {
  const model = parseCss(CSS);
  assert.equal(locateRule(model, 3, '.card:hover')!.ordinal, 3);
  assert.equal(locateRule(model, 9, '.card:hover')!.ordinal, 3);
  assert.equal(locateRule(model, 1, '.CARD')!.ordinal, 1);
  assert.equal(locateRule(model, 0, '.nope'), null);
  const next = applyEdits('.a { color: red; }\n', appendRule('.a { color: red; }\n', '.b', { color: 'blue' }));
  assert.equal(next, '.a { color: red; }\n\n.b {\n  color: blue;\n}\n');
});

test('css lint finds structural problems', () => {
  assert.deepEqual(lintCss('.a { color: red; ', { path: 'a.css' }).map((d) => d.code), ['unclosed-block']);
  assert.deepEqual(lintCss('.a { color: red; } }', { path: 'a.css' }).map((d) => d.code), ['stray-brace']);
  assert.deepEqual(lintCss('.a { background: url(x.png) }', { path: 'css/a.css', exists: () => false }).map((d) => d.code), ['broken-link']);
});

// ------------------------------------------------------------ composition

const SITE: Record<string, string> = {
  'layouts/base.html': `<!doctype html>
<html lang="en">
<head>
  <title>{{title | Untitled}}</title>
  <link rel="stylesheet" href="../css/site.css">
</head>
<body>
  <w-part src="parts/header.html" brand="{{title}}"></w-part>
  <main>
    <w-slot name="main"><p>Nothing here yet.</p></w-slot>
  </main>
  <aside><w-slot name="side"><p>Default side</p></w-slot></aside>
</body>
</html>`,
  'parts/header.html': `<header class="top">
  <a href="../index.html"><img src="../assets/logo.svg" alt=""> {{brand}}</a>
</header>`,
  'parts/card.html': `<article class="card">
  <h3>{{heading | Card}}</h3>
  <w-slot><p>Empty card</p></w-slot>
</article>`,
  'blog/post.html': `<w-page layout="layouts/base.html" title="Tom &amp; Co">
  <w-fill slot="main">
    <h1>Post</h1>
    <img src="img/a.png" alt="">
    <w-part src="parts/card.html" heading="One"><p>Body</p></w-part>
    <w-part src="parts/card.html"></w-part>
  </w-fill>
</w-page>`,
  'empty.html': `<w-page layout="layouts/base.html">
  <w-fill slot="main"></w-fill>
</w-page>`,
  'plain.html': `<!doctype html><html><body><w-part src="parts/card.html" heading="Plain"/></body></html>`,
  'loop.html': `<w-part src="parts/loop.html"></w-part>`,
  'parts/loop.html': `<div><w-part src="parts/loop.html"></w-part></div>`,
};
const read = (p: string) => SITE[p] ?? null;

test('composePage fills slots, expands parts and rebases URLs', () => {
  const r = composePage('blog/post.html', { read });
  assert.deepEqual(r.issues, []);
  assert.equal(r.layout, 'layouts/base.html');
  assert.deepEqual(r.files.sort(), ['blog/post.html', 'layouts/base.html', 'parts/card.html', 'parts/header.html']);
  assert.match(r.html, /<title>Tom &amp; Co<\/title>/);
  // layout URL rebased from layouts/ to blog/
  assert.match(r.html, /href="\.\.\/css\/site\.css"/);
  // part URLs rebased from parts/ to blog/
  assert.match(r.html, /<a href="\.\.\/index\.html"><img src="\.\.\/assets\/logo\.svg" alt=""> Tom &amp; Co<\/a>/);
  // page's own URL untouched
  assert.match(r.html, /<img src="img\/a\.png" alt="">/);
  assert.match(r.html, /<h3>One<\/h3>\s*<p>Body<\/p>/);
  assert.match(r.html, /<h3>Card<\/h3>\s*<p>Empty card<\/p>/);
  assert.match(r.html, /<aside><p>Default side<\/p><\/aside>/);
  assert.doesNotMatch(r.html, /<w-|\{\{/);
});

test('composition from the site root keeps layout URLs correct', () => {
  const r = composePage('empty.html', { read });
  assert.match(r.html, /href="css\/site\.css"/);
  assert.match(r.html, /<title>Untitled<\/title>/);
  assert.match(r.html, /<main>\s*<\/main>/);
});

test('canvas composition carries source addresses through', () => {
  const order: string[] = [];
  const canvasRead = (p: string) => {
    const text = read(p);
    if (text === null) return null;
    if (!order.includes(p)) order.push(p);
    return instrument(text, order.indexOf(p));
  };
  const r = composePage('blog/post.html', { read: canvasRead, canvas: true });
  assert.deepEqual(r.issues, []);
  const doc = parseHtml(r.html);
  // every surviving element has an address, and addresses are unique
  const ids = doc.elements.map((e) => attrValue(e, 'data-wp'));
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size - ids.length, -2, 'the card part is used twice, so its two surviving elements repeat');
  // the roots of each part expansion point back at the instance in the host file
  const page = order.indexOf('blog/post.html');
  const cards = doc.elements.filter((e) => attrValue(e, 'class') === 'card');
  assert.equal(cards.length, 2);
  const pageDoc = parseHtml(SITE['blog/post.html']);
  const instances = pageDoc.elements.filter((e) => e.name === 'w-part').map((e) => `${page}:${e.index}`);
  assert.deepEqual(cards.map((c) => attrValue(c, 'data-wp-inst')), instances);
  // an address maps back to the right characters in the right file
  const h1 = doc.elements.find((e) => e.name === 'h1')!;
  const [file, index] = attrValue(h1, 'data-wp')!.split(':').map(Number);
  const srcEl = parseHtml(SITE[order[file]]).elements[index];
  assert.equal(SITE[order[file]].slice(srcEl.start, srcEl.end), '<h1>Post</h1>');

  const empty = composePage('empty.html', { read: canvasRead, canvas: true });
  assert.match(empty.html, /<w-empty data-wp-drop="\d+:1" data-slot="main"><\/w-empty>/);
});

test('composition reports missing files and cycles', () => {
  assert.match(composePage('loop.html', { read }).issues[0].message, /includes itself/);
  const missing = composePage('x.html', { read: (p) => (p === 'x.html' ? '<w-page layout="layouts/nope.html"><w-fill slot="main"><p>hi</p></w-fill></w-page>' : null) });
  assert.match(missing.issues[0].message, /does not exist/);
  assert.match(missing.html, /<p>hi<\/p>/);
  assert.match(composePage('plain.html', { read }).html, /<h3>Plain<\/h3>/);
});

test('layout helpers', () => {
  assert.deepEqual(listSlots(SITE['layouts/base.html']).map((s) => s.name), ['main', 'side']);
  assert.deepEqual(listParams(SITE['parts/card.html']), ['heading']);
  assert.deepEqual(pageMeta(SITE['blog/post.html']), { layout: 'layouts/base.html', vars: { title: 'Tom & Co' }, fills: ['main'] });
  assert.equal(pageMeta('<html></html>'), null);
  const bound = bindToLayout('<!doctype html>\n<html>\n<head><title>Old</title></head>\n<body>\n  <h1>Hi</h1>\n  <p>x</p>\n</body>\n</html>', 'layouts/base.html');
  assert.equal(bound, '<w-page layout="layouts/base.html" title="Old">\n  <w-fill slot="main">\n    <h1>Hi</h1>\n    <p>x</p>\n  </w-fill>\n</w-page>\n');
  assert.match(bindToLayout(SITE['empty.html'], 'layouts/other.html'), /layout="layouts\/other\.html"/);
});

// ------------------------------------------------------------------ links

test('links resolve and retarget', () => {
  const html = '<link href="../css/site.css"><a href="post.html#top">x</a><a href="https://x.y">e</a><img srcset="a.png 1x, big/a.png 2x"><w-part src="parts/card.html"></w-part><a href="/index.html">home</a>';
  const refs = scanLinks('blog/index.html', html);
  assert.deepEqual(refs.map((r) => resolveLink('blog/index.html', r)), ['css/site.css', 'blog/post.html', null, 'blog/a.png', 'blog/big/a.png', 'parts/card.html', 'index.html']);

  // another file was renamed
  const moves = new Map([['css/site.css', 'styles/main.css'], ['parts/card.html', 'parts/tile.html'], ['blog/post.html', 'blog/first post.html']]);
  const out = applyEdits(html, retargetLinks('blog/index.html', html, moves));
  assert.match(out, /href="\.\.\/styles\/main\.css"/);
  assert.match(out, /href="first%20post\.html#top"/);
  assert.match(out, /<w-part src="parts\/tile\.html">/);
  assert.match(out, /https:\/\/x\.y/);

  // the file itself moved to another folder
  const self = applyEdits(html, retargetLinks('blog/index.html', html, new Map(), 'archive/2024/index.html'));
  assert.match(self, /href="\.\.\/\.\.\/css\/site\.css"/);
  assert.match(self, /href="\.\.\/\.\.\/blog\/post\.html#top"/);
  assert.match(self, /<w-part src="parts\/card\.html">/);
  assert.match(self, /href="\/index\.html"/);

  const css = '/* url(no.png) */ .a { background: url("../img/a.png"); } @import "base.css";';
  assert.deepEqual(scanLinks('css/x.css', css).map((r) => resolveLink('css/x.css', r)), ['img/a.png', 'css/base.css']);
});

// ------------------------------------------------------------------- lint

test('html lint', () => {
  const src = '<html><body><img src="a.png"><p id="x"></p><p id="x"></p><center>x</center><a href="missing.html">m</a><a href="#top">t</a></body></html>';
  const codes = lintHtml(src, { path: 'index.html', exists: (p) => p === 'a.png' }).map((d) => d.code);
  assert.deepEqual(codes.sort(), ['broken-link', 'duplicate-id', 'html-lang', 'img-alt', 'missing-doctype', 'obsolete-element']);
  const page = '<w-page layout="layouts/base.html"><w-fill slot="main"><w-part src="parts/card.html"/></w-fill></w-page>';
  assert.deepEqual(lintHtml(page, { path: 'a.html', exists: () => true }), []);
  const d = lintHtml('<div>\n  <w-fil></w-fil>\n</div>', { path: 'a.html' })[0];
  assert.equal(d.code, 'unknown-composition-tag');
  assert.deepEqual([d.line, d.col], [2, 3]);
});

// ------------------------------------------------------ several elements

import { removeElements, duplicateElements, moveElements, wrapElements, topLevel } from '../src/shared/html/patch';

test('group edits: remove, duplicate, move and wrap several elements at once', () => {
  const src = '<ul>\n  <li>a</li>\n  <li>b <b>bold</b></li>\n  <li>c</li>\n  <li>d</li>\n</ul>\n<ol>\n</ol>\n';
  const doc = parseHtml(src);
  const li = (n: number) => find(src, 'li', n);
  const bold = find(src, 'b');

  // nested selections collapse into their ancestor
  assert.deepEqual(topLevel(doc, [bold, li(1), li(3)]).map((e) => e.index), [li(1), li(3)]);

  assert.equal(apply(src, removeElements(doc, [li(0), li(2), bold, li(1)])), '<ul>\n  <li>d</li>\n</ul>\n<ol>\n</ol>\n');
  assert.equal(apply(src, duplicateElements(doc, [li(0), li(3)])), '<ul>\n  <li>a</li>\n  <li>a</li>\n  <li>b <b>bold</b></li>\n  <li>c</li>\n  <li>d</li>\n  <li>d</li>\n</ul>\n<ol>\n</ol>\n');

  // order is kept wherever the group lands
  let r = moveElements(doc, [li(3), li(1)], li(0), 'before');
  let out = apply(src, r);
  assert.equal(out, '<ul>\n  <li>b <b>bold</b></li>\n  <li>d</li>\n  <li>a</li>\n  <li>c</li>\n</ul>\n<ol>\n</ol>\n');
  assert.equal(out.slice(r.focus, r.focus + 6), '<li>b ');

  r = moveElements(doc, [li(0), li(1)], find(src, 'ol'), 'inside-end');
  assert.equal(apply(src, r), '<ul>\n  <li>c</li>\n  <li>d</li>\n</ul>\n<ol>\n  <li>a</li>\n  <li>b <b>bold</b></li>\n</ol>\n');
  assert.equal(apply(src, moveElements(doc, [li(0), li(1)], li(1), 'after')), src, 'dropping a group on one of its own members changes nothing');
  assert.throws(() => moveElements(doc, [find(src, 'ul')], li(0), 'before'), /inside themselves/);

  r = wrapElements(doc, [li(2), li(1)], '<div class="pair">', '</div>');
  out = apply(src, r);
  assert.equal(out, '<ul>\n  <li>a</li>\n  <div class="pair">\n    <li>b <b>bold</b></li>\n    <li>c</li>\n  </div>\n  <li>d</li>\n</ul>\n<ol>\n</ol>\n');
  assert.equal(elementAt(parseHtml(out), r.focus)!.name, 'div');
  assert.throws(() => wrapElements(doc, [li(0), li(2)], '<div>', '</div>'), /next to each other/);
  assert.throws(() => wrapElements(doc, [li(0), find(src, 'ol')], '<div>', '</div>'), /share a parent/);

  const inline = '<p><a>x</a> <a>y</a></p>';
  assert.equal(apply(inline, wrapElements(parseHtml(inline), [1, 2], '<span>', '</span>')), '<p><span><a>x</a> <a>y</a></span></p>');
});
