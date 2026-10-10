// End-to-end smoke test: drives the real application through its main
// workflows and checks the resulting source files on disk.
//
//   npm run build && npm run e2e
//
// On Linux CI, run under a virtual display:  xvfb-run -a npm run e2e
// Set SHOTS=<folder> to keep screenshots of each step.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const site = join(mkdtempSync(join(tmpdir(), 'wovenpage-e2e-')), 'site');
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
execFileSync(process.execPath, ['--import', 'tsx', join(root, 'tests/e2e/make-site.ts'), site], { cwd: root });

const read = (p) => readFileSync(join(site, p), 'utf8');
const errors = [];
let step = 0;

// APP_PATH points the test at a packaged build (for example release/win-unpacked/resources/app.asar)
// instead of the working tree.
const app = await electron.launch({
  args: [process.env.APP_PATH ? resolve(process.env.APP_PATH) : root, '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, WOVENPAGE_OPEN: site, WOVENPAGE_USER_DATA: join(site, '..', 'user-data') },
});
const win = await app.firstWindow();
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const shot = async (name) => {
  if (shots) await win.screenshot({ path: join(shots, `${String(++step).padStart(2, '0')}-${name}.png`) });
};
const canvas = win.frameLocator('iframe.canvas__iframe');
const saveAll = async () => {
  await win.keyboard.press('Control+Shift+S');
  await win.waitForFunction(() => document.querySelector('.status__right')?.textContent?.includes('All saved'));
};
/** Waits until the canvas has reloaded and re-selected, i.e. source and canvas agree again. */
const settle = () => win.waitForTimeout(700);
/**
 * Drags with real mouse events from one element to a point inside another
 * (given as fractions of the target's box).
 */
const dragTo = async (from, to, y = 0.5, opts = {}) => {
  const a = await (opts.grab ?? from).boundingBox();
  const b = await to.boundingBox();
  const start = opts.grab ? { x: a.x + 12, y: a.y + 12 } : { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width * (opts.x ?? 0.3), y: b.y + b.height * y };
  await win.mouse.move(start.x, start.y);
  await win.mouse.down();
  await win.mouse.move(start.x + 12, start.y + 10, { steps: 3 });
  await win.mouse.move(end.x, end.y, { steps: 12 });
  await win.waitForTimeout(150);
  await win.mouse.move(end.x + 1, end.y + 1);
  await win.waitForTimeout(150);
  await win.mouse.up();
};
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    // On GitHub Actions, surface the failure on the run's summary page as well.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${`e2e: ${name}`.replace(/%/g, '%25').replace(/,/g, '%2C').replace(/:/g, '%3A').slice(0, 200)}::${String(err.message).slice(0, 2500).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
    errors.push(`${name}: ${err.message}`);
    await shot(`FAIL-${name.replace(/\W+/g, '-')}`);
  }
};

try {
  await win.waitForSelector('.wb', { timeout: 30000 });
  // The checks below assume a desktop-sized window (the starter site switches to its phone layout when narrow).
  const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  console.log(`window ${viewport.width} x ${viewport.height}`);
  if (viewport.width < 1300 || viewport.height < 800) {
    const message = `The app window is ${viewport.width} x ${viewport.height}; this test needs at least 1300 x 800. Raise the display resolution.`;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=e2e%3A window too small::${message}`);
    throw new Error(message);
  }
  await canvas.locator('h1').waitFor({ timeout: 20000 });
  await settle();
  await shot('opened');

  await check('the page is composed from its layout and parts', async () => {
    assert.equal(await canvas.locator('header.site-header .brand span').innerText(), 'Fernhill Pottery');
    assert.equal(await canvas.locator('footer.site-footer').count(), 1);
    assert.equal(await canvas.locator('w-page, w-fill, w-part, w-slot').count(), 0);
    assert.match(await canvas.locator('h1').getAttribute('data-wp'), /^\d+:\d+$/);
  });

  await check('clicking an element selects it and fills the inspector', async () => {
    await canvas.locator('h1').click();
    await win.waitForSelector('.insp__element');
    assert.equal(await win.locator('.insp__element').innerText(), 'h1');
    assert.match(await win.locator('.status__crumbs').innerText(), /section\.hero[\s\S]*h1/);
    assert.match(await win.locator('.insp__origin').innerText(), /In index\.html/);
  });
  await shot('selected');

  await check('an inline style set in the inspector is written to the source', async () => {
    const color = win.locator('.ctl:has(> .ctl__label:text-is("Colour")) input.field');
    await color.fill('#8c4a32');
    await color.press('Enter');
    await settle();
    await saveAll();
    assert.match(read('index.html'), /<h1 style="color: #8c4a32;">Pots made slowly, to be used every day\.<\/h1>/);
    assert.equal(await canvas.locator('h1').evaluate((el) => getComputedStyle(el).color), 'rgb(140, 74, 50)');
  });

  await check('double-click edits text in place', async () => {
    await canvas.locator('.hero__text p').dblclick();
    await win.keyboard.press('Control+A');
    await win.keyboard.type('Thrown, glazed and fired at Fernhill.');
    await win.keyboard.press('Enter');
    await settle();
    await saveAll();
    assert.match(read('index.html'), /<p>Thrown, glazed and fired at Fernhill\.<\/p>/);
  });

  await check('a style written to a stylesheet rule edits the CSS file', async () => {
    await canvas.locator('section.hero').click({ position: { x: 6, y: 6 } });
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'section.hero');
    const target = win.locator('.insp__target select');
    const value = await target.locator('option', { hasText: /^\.hero\s/ }).first().getAttribute('value');
    await target.selectOption(value);
    const gap = win.locator('.ctl:has(> .ctl__label:text-is("Row gap")) input.field');
    await gap.fill('40');
    await gap.press('Enter');
    await settle();
    await saveAll();
    assert.match(read('css/site.css'), /\.hero \{[^}]*\n  row-gap: 40px;\n\}/);
    assert.doesNotMatch(read('index.html'), /row-gap/);
    assert.equal(await canvas.locator('section.hero').evaluate((el) => getComputedStyle(el).rowGap), '40px');
  });
  await shot('rule-target');

  await check('dragging an element from the Add panel inserts it', async () => {
    await win.locator('.rail__btn[aria-label="Add elements and parts"]').click();
    await canvas.locator('.band h2').scrollIntoViewIfNeeded();
    await dragTo(win.locator('.add__item', { hasText: 'Quote' }), canvas.locator('.band h2'), 0.9);
    await canvas.locator('blockquote').waitFor({ timeout: 8000 });
    await settle();
    await saveAll();
    // Dropped on the lower half of the heading, so it lands right after it, indented to match.
    assert.match(read('index.html'), /<h2>From the last firing<\/h2>\n      <blockquote>\n        <p>A sentence worth setting apart\.<\/p>\n      <\/blockquote>\n      <div class="grid">/);
  });

  await check('dragging on the canvas reorders elements in the source', async () => {
    const order = () => [...read('index.html').matchAll(/alt="([^"]+)" width="220"/g)].map((m) => m[1]);
    assert.deepEqual(order(), ['Tall celadon vase', 'Wide tenmoku bowl', 'Small ash-glazed jar']);
    const tiles = canvas.locator('figure.tile');
    await tiles.nth(2).scrollIntoViewIfNeeded();
    await dragTo(tiles.nth(2).locator('figcaption'), tiles.nth(0), 0.5, { x: 0.02, grab: tiles.nth(2) });
    await settle();
    await saveAll();
    assert.deepEqual(order(), ['Small ash-glazed jar', 'Tall celadon vase', 'Wide tenmoku bowl']);
    assert.equal(await win.locator('.insp__element').innerText(), 'figure.tile');
  });
  await shot('inserted');

  await check('Shift+click selects several elements; styles, grouping and undo act on all of them', async () => {
    const tiles = canvas.locator('figure.tile');
    await tiles.nth(0).click({ position: { x: 5, y: 5 } });
    await tiles.nth(1).click({ position: { x: 5, y: 5 }, modifiers: ['Shift'] });
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === '2 elements selected');
    await win.locator('.insp__target select').selectOption('inline');
    await shot('multi-select');
    const opacity = win.locator('.ctl:has(> .ctl__label:text-is("Opacity")) input.field');
    await opacity.fill('0.8');
    await opacity.press('Enter');
    await settle();
    await saveAll();
    assert.equal((read('index.html').match(/<figure class="tile" style="opacity: 0\.8;">/g) ?? []).length, 2);
    assert.equal((read('index.html').match(/<figure class="tile">/g) ?? []).length, 1);
    assert.deepEqual(await tiles.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity)), ['0.8', '0.8', '1']);

    // Ctrl+G wraps the two neighbours in one new box, indented to match.
    await tiles.nth(0).click({ position: { x: 5, y: 5 } });
    await tiles.nth(1).click({ position: { x: 5, y: 5 }, modifiers: ['Shift'] });
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === '2 elements selected');
    await win.keyboard.press('Control+G');
    await canvas.locator('.grid > div > figure.tile').first().waitFor({ timeout: 8000 });
    await settle();
    await saveAll();
    assert.match(read('index.html'), /<div class="grid">\n        <div>\n          <figure class="tile" style="opacity: 0\.8;">[\s\S]*?<\/figure>\n          <figure class="tile" style="opacity: 0\.8;">[\s\S]*?<\/figure>\n        <\/div>\n        <figure class="tile">/);
    assert.equal(await win.locator('.insp__element').innerText(), 'div');

    await win.keyboard.press('Control+Z');
    await canvas.locator('.grid > figure.tile').nth(2).waitFor({ timeout: 8000 });
    await settle();
    await saveAll();
    assert.doesNotMatch(read('index.html'), /<div class="grid">\n        <div>/);
    assert.equal(await canvas.locator('.grid > figure.tile').count(), 3);
  });

  await check('Delete removes the selection; undo on the canvas brings it back', async () => {
    // The paragraph fills the quote exactly, so a click lands on it; Escape steps out to the parent.
    await canvas.locator('blockquote p').click();
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'p');
    await win.keyboard.press('Escape');
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'blockquote');
    await win.keyboard.press('Delete');
    await canvas.locator('blockquote').waitFor({ state: 'detached', timeout: 8000 });
    await settle();
    await saveAll();
    assert.doesNotMatch(read('index.html'), /blockquote/);
    await canvas.locator('h1').click();
    await win.keyboard.press('Control+Z');
    await canvas.locator('blockquote').waitFor({ timeout: 8000 });
    await settle();
    await saveAll();
    assert.match(read('index.html'), /<blockquote>/);
  });

  await check('editing a part from the page canvas edits the part file', async () => {
    await canvas.locator('header.site-header .brand span').dblclick();
    await win.keyboard.press('Control+A');
    await win.keyboard.type('Fernhill Studio');
    await win.keyboard.press('Enter');
    await settle();
    await saveAll();
    assert.match(read('parts/site-header.html'), /<span>Fernhill Studio<\/span>/);
    assert.equal(await win.locator('.tab', { hasText: 'site-header.html' }).count(), 1);
  });

  await check('typing in the source view updates the canvas', async () => {
    await win.locator('.tab', { hasText: 'index.html' }).click();
    await win.locator('.monaco-editor .view-lines').first().click();
    await win.keyboard.press('Control+End');
    await win.keyboard.press('Control+Home');
    await win.keyboard.press('Control+F');
    await win.keyboard.type('From the last firing');
    await win.keyboard.press('Escape');
    await win.keyboard.type('Fresh from the kiln');
    await canvas.locator('h2', { hasText: 'Fresh from the kiln' }).waitFor({ timeout: 8000 });
    await saveAll();
  });
  await shot('typed');

  await check('find in site reports matches across files', async () => {
    await win.keyboard.press('Control+Shift+F');
    await win.locator('.search__form input').first().fill('class-card');
    await win.waitForSelector('.search__match');
    assert.match(await win.locator('.search__summary').innerText(), /\d+ matches in \d+ files/);
    assert.ok((await win.locator('.search__file').count()) >= 3);
  });
  await shot('search');

  await check('the site check finds a broken link', async () => {
    await win.locator('.tab', { hasText: 'index.html' }).click();
    await win.locator('.monaco-editor .view-lines').first().click();
    await win.keyboard.press('Control+End');
    await win.keyboard.type('\n<a href="nowhere.html">broken</a>');
    await win.waitForFunction(() => /error/.test(document.querySelector('.status__item.is-error')?.textContent ?? ''), null, { timeout: 8000 });
    await win.keyboard.press('Control+Shift+M');
    assert.match(await win.locator('.problems__list').innerText(), /nowhere\.html/);
    await win.keyboard.press('Control+Z');
    await win.keyboard.press('Control+Z');
    await win.keyboard.press('Control+Shift+M');
  });

  await check('build writes plain HTML with no composition tags', async () => {
    await saveAll();
    await win.keyboard.press('Control+B');
    await win.locator('.toast--success', { hasText: 'Built 3 pages' }).waitFor({ timeout: 10000 });
    const built = readFileSync(join(site, '_site/classes.html'), 'utf8');
    assert.doesNotMatch(built, /<w-|\{\{|data-wp/);
    assert.match(built, /<h3>First pots<\/h3>/);
    assert.ok(!existsSync(join(site, '_site/layouts')) && !existsSync(join(site, '_site/parts')));
    assert.deepEqual(readdirSync(join(site, '_site')).sort(), ['assets', 'classes.html', 'css', 'index.html', 'js', 'visit.html']);
  });
  await shot('built');

  await check('a part instance exposes its parameters; editing one changes only that use', async () => {
    await win.keyboard.press('Control+P');
    await win.keyboard.type('classes');
    await win.keyboard.press('Enter');
    await canvas.locator('article.class-card').first().waitFor({ timeout: 10000 });
    await settle();
    await canvas.locator('article.class-card').first().click({ position: { x: 4, y: 4 } });
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'article.class-card');
    assert.match(await win.locator('.insp__origin').innerText(), /Lives in parts\/class-card\.html/);
    await win.locator('.insp__tab', { hasText: 'Element' }).click();
    assert.match(await win.locator('.insp__section--instance').innerText(), /Instance of class-card\.html/);
    const heading = win.locator('.insp__section--instance input[aria-label="heading"]');
    assert.equal(await heading.inputValue(), 'First pots');
    await heading.fill('Beginners wheel');
    await heading.press('Tab');
    await canvas.locator('h3', { hasText: 'Beginners wheel' }).waitFor({ timeout: 8000 });
    await settle();
    await saveAll();
    assert.match(read('classes.html'), /<w-part src="parts\/class-card\.html" heading="Beginners wheel" when="Tuesdays, 6\.30pm, six weeks">/);
    assert.doesNotMatch(read('parts/class-card.html'), /Beginners wheel/);
    assert.equal(await canvas.locator('h3', { hasText: 'Glaze weekend' }).count(), 1);
    // The card is still selected after the canvas reloaded.
    assert.equal(await win.locator('.insp__element').innerText(), 'article.class-card');
  });
  await shot('instance');

  await check('dragging a resize handle writes the new size', async () => {
    await win.locator('.tab', { hasText: 'index.html' }).click();
    await canvas.locator('img.hero__image').waitFor({ timeout: 10000 });
    await settle();
    await win.locator('.insp__tab', { hasText: 'Style' }).click();
    await canvas.locator('img.hero__image').click();
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'img.hero__image');
    await win.locator('.insp__target select').selectOption('inline');
    const box = await canvas.locator('img.hero__image').boundingBox();
    // The east handle sits on the middle of the right edge of the selection box.
    await win.mouse.move(box.x + box.width, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width - 60, box.y + box.height / 2, { steps: 6 });
    await win.mouse.up();
    await settle();
    await saveAll();
    const width = Math.round(box.width - 60);
    assert.match(read('index.html'), new RegExp(`<img class="hero__image"[^>]* style="width: ${width}px;">`));
  });

  await check('resizing snaps to nearby edges, and Alt turns snapping off', async () => {
    const img = canvas.locator('img.hero__image');
    // The inside right edge of the parent, in window coordinates: the line the image should snap to.
    const edge = await img.evaluate((el) => {
      const parent = el.parentElement;
      const cs = getComputedStyle(parent);
      return parent.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth) - el.getBoundingClientRect().left;
    });
    const drag = async (toOffset, alt) => {
      const box = await img.boundingBox();
      await win.mouse.move(box.x + box.width, box.y + box.height / 2);
      await win.mouse.down();
      if (alt) await win.keyboard.down('Alt');
      await win.mouse.move(box.x + toOffset, box.y + box.height / 2, { steps: 6 });
      await win.mouse.up();
      if (alt) await win.keyboard.up('Alt');
      await settle();
      await saveAll();
      return Number(/<img class="hero__image"[^>]* style="width: (\d+)px;/.exec(read('index.html'))[1]);
    };
    // Released 4 px short of the edge: the width lands exactly on it.
    assert.equal(await drag(edge - 4, false), Math.round(edge));
    // The same gesture with Alt held keeps the pointer's own position.
    await drag(edge - 40, true);
    assert.equal(await drag(edge - 4, true), Math.round(edge - 4));
  });

  await check('device widths scale the canvas; interact mode follows links to other pages', async () => {
    await win.keyboard.press('Control+1');
    await win.locator('.bar__devices button[aria-label="Phone, 390 px"]').click();
    await win.waitForFunction(() => document.querySelector('.bar__info')?.textContent?.startsWith('390 px'));
    assert.equal(await canvas.locator('.nav-toggle').evaluate((el) => getComputedStyle(el).display), 'block');
    await shot('phone');
    await win.locator('.bar__devices button[aria-label="Fill the space"]').click();
    await win.keyboard.press('Control+I');
    try {
      await canvas.locator('.site-nav a', { hasText: 'Visit' }).click({ timeout: 10000 });
      await win.waitForFunction(() => document.querySelector('.tab.is-active')?.textContent?.includes('visit.html'), null, { timeout: 8000 });
      await canvas.locator('form.form').waitFor({ timeout: 8000 });
    } finally {
      // Leave Interact mode whatever happened, so a failure here cannot cascade into later checks.
      if ((await win.locator('.bar__interact').getAttribute('aria-pressed')) === 'true') await win.keyboard.press('Control+I');
      await win.keyboard.press('Control+2');
    }
  });

  await check('a new page is created from the layout and opens ready to edit', async () => {
    await win.keyboard.press('Control+N');
    await win.locator('.modal input#f-title').fill('Our kilns');
    await win.locator('.modal .btn--primary').click();
    await canvas.locator('h1', { hasText: 'Our kilns' }).waitFor({ timeout: 10000 });
    assert.equal(read('our-kilns.html'), '<w-page layout="layouts/base.html" title="Our kilns">\n  <w-fill slot="main">\n    <h1>Our kilns</h1>\n    <p>Start writing here.</p>\n  </w-fill>\n</w-page>\n');
    assert.equal(await canvas.locator('header.site-header').count(), 1);
  });

  await check('assets are listed with thumbnails and open in a preview', async () => {
    await win.locator('.rail__btn[aria-label="Assets"]').click();
    assert.equal(await win.locator('.assets__thumb').count(), 5);
    await win.waitForFunction(() => [...document.querySelectorAll('.assets__thumb img')].every((i) => i.complete && i.naturalWidth > 0));
    await win.locator('.assets__thumb', { hasText: 'shelf.svg' }).click();
    // An SVG is both an image and source: the preview sits above its code.
    await win.waitForSelector('.assetview__stage img');
    await win.waitForFunction(() => /480 x 360 px/.test(document.querySelector('.assetview__facts')?.textContent ?? ''));
    assert.ok(await win.locator('.work__source .monaco-editor').isVisible());
  });
  await shot('asset');

  await check('publishing to a folder uploads the build, then reports nothing left to do', async () => {
    const dest = join(site, '..', 'published');
    await win.keyboard.press('Control+Shift+U');
    await win.locator('.pub__side .btn', { hasText: 'Add destination' }).click();
    await win.locator('.pub__form select').first().selectOption('folder');
    await win.locator('.pub__form input[placeholder*="wwwroot"]').fill(dest);
    await win.locator('.pub__form input').first().fill('Local copy');
    await win.locator('.btn', { hasText: 'Review changes' }).click();
    await win.waitForSelector('.pub__summary');
    assert.match(await win.locator('.pub__summary').innerText(), /11 to upload .*0 to remove, 0 unchanged\. This destination has not been published to before\./);
    await shot('publish-plan');
    await win.locator('.btn--primary', { hasText: /Publish 11 changes/ }).click();
    await win.locator('.toast--success', { hasText: 'Published 11 files' }).waitFor({ timeout: 15000 });
    assert.ok(existsSync(join(dest, 'our-kilns.html')) && existsSync(join(dest, 'assets/shelf.svg')));
    await win.locator('.btn', { hasText: 'Review changes' }).click();
    await win.waitForSelector('.pub__summary');
    assert.match(await win.locator('.pub__summary').innerText(), /Everything is up to date\. 11 files match/);
    assert.match(read('wovenpage.json'), /"name": "Local copy"/);
    await win.locator('.modal__footer .btn', { hasText: 'Done' }).click();
  });

  await check('Sass written outside the app is compiled, applied live, and built to CSS', async () => {
    await win.locator('.tab', { hasText: 'index.html' }).click();
    await canvas.locator('h1').waitFor({ timeout: 8000 });
    // Another program adds a Sass file with a partial, and links the compiled stylesheet from the layout.
    mkdirSync(join(site, 'css'), { recursive: true });
    writeFileSync(join(site, 'css/_vars.scss'), '$track: 3px;\n');
    writeFileSync(join(site, 'css/theme.scss'), '@use "vars";\n.hero {\n  h1 { letter-spacing: vars.$track; }\n}\n');
    writeFileSync(join(site, 'layouts/base.html'), read('layouts/base.html').replace('</head>', '  <link rel="stylesheet" href="../css/theme.css">\n</head>'));
    await win.waitForFunction(() => true);
    await canvas.locator('link[href="css/theme.css"]').waitFor({ state: 'attached', timeout: 10000 });
    await win.waitForTimeout(600);
    assert.equal(await canvas.locator('h1').evaluate((el) => getComputedStyle(el).letterSpacing), '3px');

    // Editing the partial is picked up without a reload of the page.
    writeFileSync(join(site, 'css/_vars.scss'), '$track: 5px;\n');
    await win.waitForFunction(() => true);
    await canvas.locator('h1').evaluate((el) => new Promise((resolve) => {
      const tick = () => (getComputedStyle(el).letterSpacing === '5px' ? resolve(true) : setTimeout(tick, 100));
      tick();
    }));

    // The inspector says where the rule lives instead of offering a destination it cannot write to.
    await canvas.locator('h1').click();
    await win.waitForFunction(() => document.querySelector('.insp__element')?.textContent === 'h1');
    assert.match(await win.locator('.insp__note--boxed').innerText(), /come from Sass \(theme\.scss\)/);
    assert.equal(await win.locator('.insp__target select option', { hasText: 'theme' }).count(), 0);

    await win.keyboard.press('Control+B');
    await win.locator('.toast--success', { hasText: /Built 4 pages/ }).waitFor({ timeout: 10000 });
    assert.equal(readFileSync(join(site, '_site/css/theme.css'), 'utf8'), '.hero h1 {\n  letter-spacing: 5px;\n}\n');
    assert.ok(!existsSync(join(site, '_site/css/theme.scss')) && !existsSync(join(site, '_site/css/_vars.scss')));
    assert.equal(await win.locator('.status__item.is-error').count(), 0, 'the link to the compiled stylesheet is not reported as broken');
  });
  await shot('sass');

  await check('the dark theme applies everywhere', async () => {
    await win.locator('.tab', { hasText: 'index.html' }).click();
    await canvas.locator('h1').waitFor({ timeout: 8000 });
    await win.locator('.rail__btn[aria-label="Site files"]').click();
    await canvas.locator('h1').click();
    await win.locator('.rail__btn[aria-label="Switch theme"]').click();
    assert.equal(await win.evaluate(() => document.documentElement.dataset.theme), 'indigo');
    await settle();
    await shot('dark');
    await win.locator('.rail__btn[aria-label="Switch theme"]').click();
  });
} finally {
  // Unsaved changes would raise a native "save?" prompt and block the exit.
  await saveAll().catch(() => undefined);
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  try {
    app.process().kill();
  } catch {
    /* already gone */
  }
}

if (errors.length) {
  console.log(`\n${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
