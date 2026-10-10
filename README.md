# Wovenpage

A desktop web-authoring tool for Windows in which the **design view and the code view edit the same source text**. Drag an element on the canvas and the HTML changes by exactly the characters that needed to change; type in the editor and the canvas follows.

Wovenpage is an original product: its architecture, interface, icons, terminology and file formats were designed from scratch. See [docs/ORIGINALITY.md](docs/ORIGINALITY.md).

## Run it

Requires Node.js 22 or later (developed and tested with 22).

```
npm install
npm start
```

`npm start` builds and launches the app. Choose **A small example site** on the start screen to get a three-page site that uses a layout, parts, a stylesheet and a script.

To open a folder directly: `npx electron . C:\path\to\site`

| Command | What it does |
| --- | --- |
| `npm start` | Build, then launch |
| `npm run watch` | Rebuild on change (restart the app to pick up main-process changes) |
| `npm run typecheck` | Type-check everything |
| `npm test` | Unit and service tests, including real FTP and SFTP round trips against in-process servers |
| `npm run e2e` | Drives the real app through 23 workflows and checks the files on disk (build first) |
| `npm run dist` | Build the Windows installer into `release/` (run on Windows) |
| `npm run dist:portable` | Build a portable Windows zip into `release/` (works from any OS) |

## What it does

- **Canvas** - a real browser rendering of the page. Select one element or several (Shift+click), drag to reorder or re-parent, resize with handles that snap to neighbouring edges and sizes, group elements into a box, double-click to edit text, drop in elements, images and parts.
- **Source** - Monaco with highlighting, folding, auto-indent, multi-cursor, find/replace, and completion that knows *your site*: its classes, ids, files, custom properties, fonts, layouts, slots and part parameters.
- **Split** - both at once, with selection synchronised in each direction.
- **Inspector** - layout (flexbox, grid), size, spacing, text, fill, border, position and effects. A "Write to" control decides whether a change goes to the element's inline style or to a specific rule in a stylesheet.
- **Sass** - `.scss` files are compiled for the preview as you type and written as CSS when you build; partials and `@use` work.
- **Layouts and parts** - master layouts with slots, and reusable parts with parameters, compiled to plain HTML when you build or publish.
- **Site panel** - file tree with drag-to-move; renaming or moving a file repairs every link to it.
- **Assets** - thumbnails for images, players for media, specimens for fonts, and one-step `@font-face` setup.
- **Find in site** - search and replace across every file, including unsaved ones.
- **Problems** - structural HTML errors, broken links, accessibility basics, CSS and JavaScript syntax.
- **Preview** - live in the app, or in your default browser with live reload.
- **Publish** - SFTP, FTP, FTPS or a folder. Shows exactly what will be uploaded, skipped and removed before sending anything, and only sends what changed.

## Where to read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how it works, module by module, and how each requirement is met
- [docs/ORIGINALITY.md](docs/ORIGINALITY.md) - how the product is kept original, and what to check before shipping

## Project layout

```
src/
  shared/      Pure TypeScript core, no Electron or DOM: parser, patchers, CSS model,
               composer, link graph, linter, and the contracts between processes
  main/        Electron main process: project files, preview server, search, build, publish
  canvas/      Scripts injected into previewed pages: the canvas agent and live reload
  renderer/    The workbench UI: documents, code editor, canvas controller, panels
tests/         Unit, service and transport tests; tests/e2e drives the real app
scripts/       Build script (esbuild)
docs/          Architecture and originality notes
```

## Status

Version 0.1. The core is implemented and tested; see "Known limits" in the architecture document for what is not done yet.

The app is developed on Linux and verified on Windows by `.github/workflows/windows.yml`, which runs on every push: type check, all 45 tests, the 23-step end-to-end test against the real app, and the installer build. The installer (`Wovenpage-Setup`) and the end-to-end screenshots are attached to each run under Artifacts.

The installer is not code-signed, so Windows SmartScreen warns before running it. `npm run dist:portable` produces a portable Windows zip from any OS.
