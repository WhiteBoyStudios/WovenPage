/**
 * Files written into a new site. The starter is a small three-page site that
 * exercises a layout, parts with parameters, an external stylesheet with
 * custom properties, and a script - so every panel has something to show.
 */

import type { ProjectManifest, StarterKind } from '../shared/types';

export function defaultManifest(name: string): ProjectManifest {
  return {
    name,
    formatVersion: 1,
    outDir: '_site',
    layoutsDir: 'layouts',
    partsDir: 'parts',
    assetsDir: 'assets',
    targets: [],
  };
}

const BASE_LAYOUT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title | Fernhill Pottery}} - Fernhill Pottery</title>
  <meta name="description" content="{{description | Wheel-thrown stoneware and weekly classes in a converted dairy.}}">
  <link rel="stylesheet" href="../css/site.css">
  <script src="../js/site.js" defer></script>
</head>
<body>
  <w-part src="parts/site-header.html"></w-part>
  <main>
    <w-slot name="main">
      <p>This page has no content yet.</p>
    </w-slot>
  </main>
  <w-part src="parts/site-footer.html"></w-part>
</body>
</html>
`;

const HEADER_PART = `<header class="site-header">
  <a class="brand" href="../index.html">
    <img src="../assets/mark.svg" alt="" width="36" height="36">
    <span>Fernhill Pottery</span>
  </a>
  <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
  <nav id="site-nav" class="site-nav">
    <a href="../index.html">Studio</a>
    <a href="../classes.html">Classes</a>
    <a href="../visit.html">Visit</a>
  </nav>
</header>
`;

const FOOTER_PART = `<footer class="site-footer">
  <p>Fernhill Pottery, 14 Dairy Lane. Open Thursday to Sunday, 10 to 5.</p>
  <p><a href="mailto:hello@fernhill.example">hello@fernhill.example</a></p>
</footer>
`;

const CLASS_CARD_PART = `<article class="class-card">
  <p class="class-card__when">{{when | Dates to be announced}}</p>
  <h3>{{heading | Untitled class}}</h3>
  <w-slot>
    <p>Describe what people will make.</p>
  </w-slot>
  <a class="button button--quiet" href="../visit.html">Ask about a place</a>
</article>
`;

const INDEX_PAGE = `<w-page layout="layouts/base.html" title="Studio">
  <w-fill slot="main">
    <section class="hero">
      <div class="hero__text">
        <h1>Pots made slowly, to be used every day.</h1>
        <p>We throw, glaze and fire everything in the old dairy at Fernhill. Come and see the kilns, or learn to throw your own.</p>
        <a class="button" href="classes.html">See this season's classes</a>
      </div>
      <img class="hero__image" src="assets/shelf.svg" alt="Three glazed pots on a shelf" width="480" height="360">
    </section>

    <section class="band">
      <h2>From the last firing</h2>
      <div class="grid">
        <figure class="tile">
          <img src="assets/pot-a.svg" alt="Tall celadon vase" width="220" height="220">
          <figcaption>Tall vase, celadon</figcaption>
        </figure>
        <figure class="tile">
          <img src="assets/pot-b.svg" alt="Wide tenmoku bowl" width="220" height="220">
          <figcaption>Serving bowl, tenmoku</figcaption>
        </figure>
        <figure class="tile">
          <img src="assets/pot-c.svg" alt="Small ash-glazed jar" width="220" height="220">
          <figcaption>Lidded jar, ash glaze</figcaption>
        </figure>
      </div>
    </section>
  </w-fill>
</w-page>
`;

const CLASSES_PAGE = `<w-page layout="layouts/base.html" title="Classes" description="Evening and weekend pottery classes for beginners.">
  <w-fill slot="main">
    <section class="band">
      <h1>Classes</h1>
      <p class="lede">Six people to a class, one wheel each. Clay, glazes and firing are included.</p>
      <div class="grid">
        <w-part src="parts/class-card.html" heading="First pots" when="Tuesdays, 6.30pm, six weeks">
          <p>Centre, open and pull a cylinder. You will take home four finished pieces.</p>
        </w-part>
        <w-part src="parts/class-card.html" heading="Glaze weekend" when="Second weekend of each month">
          <p>Mix, test and layer the studio glazes on your own bisque ware.</p>
        </w-part>
        <w-part src="parts/class-card.html" heading="Open wheel" when="Sundays, 2pm"></w-part>
      </div>
    </section>
  </w-fill>
</w-page>
`;

const VISIT_PAGE = `<w-page layout="layouts/base.html" title="Visit">
  <w-fill slot="main">
    <section class="band band--narrow">
      <h1>Visit the studio</h1>
      <p class="lede">The shop is in the front room. The kilns are out the back, and you are welcome to look.</p>
      <form class="form" action="#" method="post">
        <label for="name">Your name</label>
        <input id="name" name="name" type="text" autocomplete="name">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email">
        <label for="message">What would you like to know?</label>
        <textarea id="message" name="message" rows="5"></textarea>
        <button class="button" type="submit">Send message</button>
      </form>
    </section>
  </w-fill>
</w-page>
`;

const SITE_CSS = `:root {
  --clay: #8c4a32;
  --slip: #f3efe6;
  --glaze: #2f5d62;
  --glaze-deep: #1f3f43;
  --ink: #23201c;
  --ash: #d9d2c3;
  --measure: 62rem;
  --step: 1.5rem;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.0625rem;
  line-height: 1.6;
  color: var(--ink);
  background: var(--slip);
}

img {
  max-width: 100%;
  height: auto;
}

h1,
h2,
h3 {
  font-family: "Trebuchet MS", "Segoe UI", sans-serif;
  line-height: 1.15;
  margin: 0 0 0.6em;
}

h1 {
  font-size: clamp(2rem, 5vw, 3.25rem);
  letter-spacing: -0.02em;
}

a {
  color: var(--glaze);
}

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--step);
  max-width: var(--measure);
  margin: 0 auto;
  padding: 1rem var(--step);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-family: "Trebuchet MS", "Segoe UI", sans-serif;
  font-weight: 700;
  color: var(--ink);
  text-decoration: none;
}

.site-nav {
  display: flex;
  gap: 1.5rem;
}

.site-nav a {
  color: var(--ink);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}

.site-nav a:hover {
  border-bottom-color: var(--clay);
}

.nav-toggle {
  display: none;
}

.hero {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  align-items: center;
  gap: calc(var(--step) * 2);
  max-width: var(--measure);
  margin: 0 auto;
  padding: 3rem var(--step);
}

.hero__image {
  border-radius: 6px;
  background: var(--ash);
}

.band {
  max-width: var(--measure);
  margin: 0 auto;
  padding: 2.5rem var(--step);
}

.band--narrow {
  max-width: 38rem;
}

.lede {
  font-size: 1.25rem;
  max-width: 34rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--step);
}

.tile {
  margin: 0;
  padding: 1rem;
  background: #fff;
  border: 1px solid var(--ash);
  border-radius: 6px;
}

.tile figcaption {
  margin-top: 0.5rem;
  font-size: 0.95rem;
}

.class-card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 1.25rem;
  background: #fff;
  border-top: 4px solid var(--clay);
  border-radius: 0 0 6px 6px;
}

.class-card__when {
  margin: 0;
  font-size: 0.9rem;
  color: var(--clay);
}

.button {
  display: inline-block;
  padding: 0.7rem 1.2rem;
  font: inherit;
  font-family: "Trebuchet MS", "Segoe UI", sans-serif;
  font-weight: 700;
  color: #fff;
  background: var(--glaze);
  border: 0;
  border-radius: 4px;
  text-decoration: none;
  cursor: pointer;
}

.button:hover {
  background: var(--glaze-deep);
}

.button--quiet {
  align-self: flex-start;
  margin-top: auto;
  padding: 0.4rem 0;
  color: var(--glaze);
  background: none;
  text-decoration: underline;
}

.button--quiet:hover {
  color: var(--glaze-deep);
  background: none;
}

.form {
  display: grid;
  gap: 0.4rem;
}

.form input,
.form textarea {
  padding: 0.6rem;
  font: inherit;
  border: 1px solid #b9b1a0;
  border-radius: 4px;
  background: #fff;
}

.form .button {
  justify-self: start;
  margin-top: 0.8rem;
}

.site-footer {
  margin-top: 3rem;
  padding: 2rem var(--step);
  color: var(--slip);
  background: var(--glaze-deep);
  text-align: center;
}

.site-footer a {
  color: inherit;
}

@media (max-width: 44rem) {
  .hero {
    grid-template-columns: 1fr;
    padding-block: 1.5rem;
  }

  .nav-toggle {
    display: block;
    padding: 0.4rem 0.8rem;
    font: inherit;
    background: none;
    border: 1px solid var(--ink);
    border-radius: 4px;
  }

  .site-nav {
    display: none;
  }

  .site-nav.is-open {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .site-header {
    flex-wrap: wrap;
  }
}
`;

const SITE_JS = `// Opens and closes the navigation on narrow screens.
const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#site-nav');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}
`;

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
  <circle cx="18" cy="18" r="18" fill="#8c4a32"/>
  <path d="M11 11h14l-2 6c3 2 4 5 3 8-1 3-4 4-8 4s-7-1-8-4c-1-3 0-6 3-8z" fill="#f3efe6"/>
</svg>
`;

function potSvg(body: string, glaze: string, shape: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220">
  <rect width="220" height="220" fill="#ece6d8"/>
  <ellipse cx="110" cy="190" rx="70" ry="8" fill="#d2c9b6"/>
  <path d="${shape}" fill="${body}"/>
  <path d="${shape}" fill="${glaze}" opacity=".55" transform="translate(110 0) scale(.5 1) translate(-110 0)"/>
</svg>
`;
}

const POT_A = potSvg('#8fb3a6', '#dfeee8', 'M92 30h36v26c0 14 26 34 26 74 0 34-16 60-44 60s-44-26-44-60c0-40 26-60 26-74z');
const POT_B = potSvg('#3b2a22', '#8c4a32', 'M30 100h160c0 50-30 90-80 90s-80-40-80-90z');
const POT_C = potSvg('#b7a98a', '#e8dfc8', 'M80 60h60v10h14c16 20 20 44 20 64 0 36-26 56-64 56s-64-20-64-56c0-20 4-44 20-64h14z');

const SHELF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#e4dccb"/>
  <rect y="270" width="480" height="14" fill="#8c4a32"/>
  <rect y="284" width="480" height="76" fill="#d2c9b6"/>
  <path d="M70 270c-20-30-22-90 0-120h60c22 30 20 90 0 120z" fill="#2f5d62"/>
  <path d="M82 150h36v-22H82z" fill="#1f3f43"/>
  <path d="M190 270c-40-10-44-70-10-80h110c34 10 30 70-10 80z" fill="#8fb3a6"/>
  <path d="M340 270c-14-40-12-110 8-150h44c20 40 22 110 8 150z" fill="#b7a98a"/>
  <ellipse cx="370" cy="120" rx="22" ry="6" fill="#8c7f63"/>
</svg>
`;

const BLANK_INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Home</title>
  <link rel="stylesheet" href="css/site.css">
</head>
<body>
  <main>
    <h1>A new site</h1>
    <p>Drag elements here from the Add panel, or switch to Source and start typing.</p>
  </main>
</body>
</html>
`;

const BLANK_CSS = `body {
  margin: 0;
  padding: 2rem;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
`;

export function starterFiles(kind: StarterKind): Record<string, string> {
  if (kind === 'blank') {
    return {
      'index.html': BLANK_INDEX,
      'css/site.css': BLANK_CSS,
    };
  }
  return {
    'index.html': INDEX_PAGE,
    'classes.html': CLASSES_PAGE,
    'visit.html': VISIT_PAGE,
    'layouts/base.html': BASE_LAYOUT,
    'parts/site-header.html': HEADER_PART,
    'parts/site-footer.html': FOOTER_PART,
    'parts/class-card.html': CLASS_CARD_PART,
    'css/site.css': SITE_CSS,
    'js/site.js': SITE_JS,
    'assets/mark.svg': MARK_SVG,
    'assets/shelf.svg': SHELF_SVG,
    'assets/pot-a.svg': POT_A,
    'assets/pot-b.svg': POT_B,
    'assets/pot-c.svg': POT_C,
  };
}
