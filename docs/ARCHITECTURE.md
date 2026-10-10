# Wovenpage architecture

## 1. Technology choice

**Electron + TypeScript, with Monaco as the code editor and no UI framework.**

| Option | Why not / why |
| --- | --- |
| C# / WPF or WinUI | The two hardest parts of this product are a standards-compliant browser engine (for the design view and preview) and a serious code editor. Neither exists natively: both would be embedded web components (WebView2, Monaco), and every design-view gesture would cross a C#-to-JavaScript bridge. The native shell would be the thin part. |
| Tauri | Uses the system WebView2, which is fine on Windows, but the app needs a local HTTP server, file watching, FTP and SSH. In Tauri those are Rust; in Electron they are the same language as the rest of the code base, and one shared module can run in all three processes. |
| **Electron** | Chromium *is* the design surface, so what the user designs is rendered by the same engine most visitors use. Monaco gives highlighting, folding, completion and find/replace with no editor work. Node gives the file system, HTTP, FTP and SSH. One language end to end, which is what makes the shared core (below) possible. |

Costs accepted: a large install (about 90 MB) and higher memory use than a native app. For a tool whose job is to host a browser, that is the price of fidelity.

No UI framework is used in the renderer. The workbench is a few thousand lines of DOM code with a small `h()` helper; the complex state (documents, selection) lives in two classes, not in a component tree, and the code is readable top to bottom.

## 2. The central idea: source-mapped visual editing

Visual HTML editors usually treat the browser's DOM as the document and serialise it back to HTML. That reformats hand-written code, loses comments and attribute order, and cannot cope with templates. Wovenpage never serialises the DOM. **The source text is the only document**; the canvas is a view of it.

```
 source text ──parse──▶ every element gets an ordinal and exact character ranges
      │
      ▼ instrument (served copy only, never saved)
 <h1 data-wp="0:14">…        "element 14 of file 0"
      │
      ▼ rendered by Chromium in the canvas iframe
 user drags the h1 above the paragraph
      │
      ▼ canvas agent
 { kind: 'move', id: '0:14', ref: '0:9', where: 'before' }
      │
      ▼ workbench resolves ids to (file, ordinal); shared patcher computes edits
 [ { start: 412, end: 437, text: '' }, { start: 301, end: 301, text: '<h1>…</h1>\n    ' } ]
      │
      ▼ applied to the Monaco model as one undoable step
 source text'  ──▶ preview overlay ──▶ canvas reloads, selection restored
```

Consequences:

- Code and design views cannot disagree, because there is one buffer per file.
- A visual edit changes only the characters it must. Formatting, comments and indentation style are preserved, and inserted markup is indented to match its surroundings.
- Visual edits are ordinary text edits, so they sit on the same undo stack as typing.
- Elements can come from several files (a page, its layout, its parts). The id names the file, so editing a header on a page's canvas edits the header's part file - and the interface says so.

### Keeping the two sides honest: epochs

An element id is only meaningful for the exact text it was generated from. The canvas controller keeps an **epoch** that increases whenever an HTML file changes in a way that could renumber elements. The epoch is baked into the canvas URL, echoed by the agent in every operation, and operations from an older epoch are dropped while the canvas reloads. Edits that cannot renumber anything (a style or attribute change) are marked *stable*: the agent has already shown them, so no reload happens and editing stays instant.

## 3. Processes

```
┌──────────────────────────────── main process (Node) ───────────────────────────────┐
│ ProjectService   files, tree, index, watcher, link-aware rename                     │
│ PreviewServer    loopback HTTP: overlay + compose + instrument + live reload        │
│ SearchService    find/replace across the site                                       │
│ BuildService     compose every page into the publishable site                       │
│ LintService      whole-site validation                                              │
│ DeployService    plan / publish with a per-target ledger; FTP, SFTP, folder         │
└───────▲───────────────────────────────────────────────────────────┬────────────────┘
        │ IPC: one typed interface (shared/ipc.ts), allow-listed     │ HTTP on 127.0.0.1
        │ in the preload script                                      │
┌───────┴──────────── renderer (sandboxed) ──────────┐   ┌───────────▼────────────────┐
│ DocumentStore   one Monaco model per file           │   │ canvas iframe              │
│ CodeEditor      Monaco + project-aware completion   │◀─▶│  the user's real page      │
│ CanvasController  ops -> patches, epochs, undo      │   │  + canvas agent            │
│ StyleWriter     inline style or stylesheet rule     │   │ postMessage, typed         │
│ Inspector, Files, Add, Assets, Search, Outline…     │   │ (shared/protocol.ts)       │
└─────────────────────────────────────────────────────┘   └────────────────────────────┘
```

`src/shared` is pure TypeScript with no Electron, Node or DOM dependency. The same parser runs in main (to instrument and compose), in the renderer (to patch), and its constants in the agent. That is why ids agree across processes without any coordination.

## 4. The composition format

Three tags give a static site shared structure without a runtime. The format is Wovenpage's own.

```html
<!-- layouts/base.html : a whole document with holes -->
<title>{{title | Untitled}}</title>
<w-part src="parts/site-header.html"></w-part>
<main><w-slot name="main">fallback content</w-slot></main>

<!-- about.html : names a layout and fills its holes -->
<w-page layout="layouts/base.html" title="About">
  <w-fill slot="main"> … </w-fill>
</w-page>

<!-- parts/card.html : a fragment with parameters and an optional content slot -->
<article class="card"><h3>{{heading | Card}}</h3><w-slot></w-slot></article>
<!-- used as -->
<w-part src="parts/card.html" heading="Hello"><p>Body</p></w-part>
```

- Composition is text splicing over the position-tracking parser (`shared/compose.ts`), so it behaves identically on instrumented text (canvas) and raw text (browser preview, build).
- Relative URLs inside a layout or part are **rebased** to the page that includes them, so `../css/site.css` written in `layouts/` works from a page in any folder.
- `layout` and `src` are relative to the site root, so they survive moving pages around.
- The root elements a part expands to carry the address of the `<w-part>` instance. Moving or deleting such an element on the canvas moves or deletes the instance; styling it edits the part. The inspector shows instance parameters separately.
- Plain HTML sites need none of this. A folder of ordinary `.html` files opens and edits as is.

## 5. Requirements, mapped to code

| Requirement | Where | Notes |
| --- | --- | --- |
| **1. Visual view**: drag and drop, resize, style visually | `canvas/agent.ts`, `renderer/canvas/CanvasController.ts`, `shared/html/patch.ts` | Select one or several elements, drag to reorder or re-parent with insertion indicators, resize handles that snap to sibling and parent edges and to sibling sizes, group into a box, inline text editing, context menu, keyboard navigation of the tree |
| **1. Code view**: highlighting, line numbers, folding, auto-indent, completion | `renderer/editor/*` | Monaco; plus project-aware completion in `completions.ts` (classes, ids, paths filtered by tag, custom properties, fonts, layouts, slots, part parameters) |
| **2. Live preview**, embedded and system browser | `main/services/PreviewServer.ts`, `canvas/live.ts` | Unsaved buffers are overlaid on disk; CSS hot-swaps without reload; device widths; Interact mode |
| **3. Site management**: multi-page, file tree, linking | `main/services/ProjectService.ts`, `renderer/panels/FilesPanel.ts`, `shared/links.ts` | Rename/move rewrites links in every file; drag a file onto the canvas to link or embed it; path completion |
| **4. Assets**: images, video, fonts, preview, paths | `renderer/panels/AssetsPanel.ts`, `AssetView.ts` | Thumbnails, dimensions, copy relative path, `@font-face` generation |
| **5. CSS tools**: inspector, stylesheets, modern CSS | `shared/styleSchema.ts`, `renderer/panels/Inspector.ts`, `renderer/canvas/StyleWriter.ts`, `shared/css/model.ts` | Flexbox, grid, gap, aspect-ratio, container queries, text-wrap; nesting-aware CSS model; create, link and edit external stylesheets; "new class rule"; Sass compiled for preview and build (`main/services/SassCompiler.ts`) |
| **6. Templates and components** | `shared/compose.ts`, `renderer/panels/AddPanel.ts`, `palette.ts`, `workbench/fileActions.ts` | Layouts with slots; parts with parameters; built-in element library; "Save as part"; "Apply layout" converts a standalone page |
| **7. Productivity**: find/replace, multi-file search, validation, shortcuts | `main/services/SearchService.ts`, `renderer/panels/SearchPanel.ts`, `shared/lint.ts`, `main/services/LintService.ts`, `renderer/core/commands.ts` | Regex, case, whole word, globs; live markers plus whole-site check; one command registry behind menu, keys and palette |
| **8. Publishing**: FTP/SFTP, sync awareness | `main/services/DeployService.ts`, `main/transports/*`, `renderer/panels/PublishDialog.ts` | Content-hash ledger per destination; dry-run plan; resumable; prune limited to files the app uploaded; passwords in the OS vault |
| **9. Structure** | this document | Separate modules for editor, preview engine, project manager, inspector, publisher |

## 6. Modules and responsibilities

### `src/shared` - the core (pure, unit-tested)

| File | Responsibility |
| --- | --- |
| `text.ts` | `TextEdit`, `applyEdits`, offset mapping, indentation detection and re-indenting. Every change in the app is a list of `TextEdit`s. |
| `paths.ts` | Site-relative path arithmetic, file kinds, MIME types. The only path code outside main. |
| `ids.ts` | The `data-wp="file:ordinal"` address format. |
| `html/parse.ts` | Position-tracking HTML parser. Elements numbered in open-tag order with exact ranges for the tag, attributes, content and close tag. Handles implied end tags, raw-text elements, comments; reports structural issues. |
| `html/instrument.ts` | Stamps addresses onto open tags for the canvas build. |
| `html/patch.ts` | `setAttribute`, `setInlineStyle`, `setInnerHtml`, `insertHtml`, `moveElement`, `removeElement`, `duplicateElement`, `replaceElement`, and their multiple-selection forms (`moveElements`, `removeElements`, `duplicateElements`, `wrapElements`). Each returns edits plus where the affected element ends up. |
| `css/model.ts` | Range-preserving CSS model with depth-first rule ordinals (matching the browser's CSSOM walk), `setDeclaration`, `appendRule`, `locateRule`, and fact harvesting for completion. |
| `compose.ts` | Layouts, fills, slots, parts, parameters, URL rebasing, and authoring helpers (`newLayoutPage`, `bindToLayout`). |
| `links.ts` | Finds references in HTML and CSS, resolves them, and rewrites them when files move. |
| `lint.ts` | HTML and CSS rules that need no browser. |
| `styleSchema.ts` | The inspector as data: every control, its property, and when it applies. |
| `protocol.ts` | Messages between workbench and canvas agent. |
| `ipc.ts` | The typed interface between renderer and main, and its allow-list. |
| `types.ts` | Data shapes shared across processes. |

### `src/main` - services (no Electron imports in `services/`, so they are testable in plain Node)

| File | Responsibility |
| --- | --- |
| `main.ts` | Window, private `wp://` scheme for the renderer, navigation and permission lock-down, unsaved-changes prompt. |
| `ipc.ts` | Implements `Api` over the services; verifies every call comes from the workbench frame. |
| `preload.ts` | Exposes exactly the allow-listed methods and events. |
| `menu.ts` | Native menu; items only send command ids. |
| `settings.ts` | Theme, recents, and the encrypted password store. |
| `starter.ts` | The example site. |
| `services/ProjectService.ts` | Single gate from site-relative paths to the file system; tree, index, CRUD, watcher with own-write detection, link-aware rename. |
| `services/PreviewServer.ts` | Overlay, compose, instrument, inject; static files with Range; server-sent events; part preview inside a layout; host and origin checks. |
| `services/SearchService.ts` | Pattern building, glob filters, match previews, replace. |
| `services/BuildService.ts` | Composes pages, compiles Sass and copies assets into the output folder; excludes authoring-only files. |
| `services/SassCompiler.ts` | Compiles `.scss` through a reader that sees unsaved buffers, resolves `@use` of partials, and reports errors with file and line. |
| `services/LintService.ts` | Whole-site HTML, CSS, JavaScript (acorn) and link checks. |
| `services/DeployService.ts` | Ledger, plan, publish, credentials, error explanations. |
| `transports/*` | `Transport` interface; `SftpTransport`, `FtpTransport` (FTP and FTPS), `FolderTransport`. |

### `src/canvas` - injected into previewed pages

| File | Responsibility |
| --- | --- |
| `agent.ts` | Selection chrome in a shadow root, single and multiple selection, hit-testing to addressed elements, drop-target geometry, drag and resize gestures with snapping guides, inline text editing, CSSOM walk that numbers rules like `css/model.ts`, optimistic previews of style changes. Emits operations; never edits source. |
| `live.ts` | Live reload for pages opened in an ordinary browser. |

### `src/renderer` - the workbench

| File | Responsibility |
| --- | --- |
| `documents/DocumentStore.ts` | One Monaco model per file; dirty tracking; `applyEdits` with a change *source* (user, canvas-stable, canvas-struct, external); preview overlays; reconciliation with disk. |
| `editor/CodeEditor.ts` | The Monaco instance, per-file view state, source-range marking. |
| `editor/completions.ts` | Project-aware completion and hover. |
| `editor/diagnostics.ts` | Publishes `lint.ts` results as Monaco markers. |
| `canvas/CanvasController.ts` | Owns the iframe; epochs; resolves ids; turns operations into patches; canvas undo; drag shield; device scaling. |
| `canvas/StyleWriter.ts` | Decides and performs where a style change is written. |
| `panels/*` | Inspector, Files, Add, Assets, Search, Outline, Problems, Publish, Launcher, AssetView. Each depends on the `Shell` interface, not on the workbench class. |
| `workbench/Workbench.ts` | Layout, tabs, view modes, command registration, wiring. |
| `workbench/fileActions.ts` | New page/stylesheet/layout/part, rename, delete, attach stylesheet, new class rule, save as part, apply layout. |
| `core/*` | `h()` DOM helper, emitter, command registry and keybindings, toasts, menus, modals, quick-pick, icons, typed IPC proxy. |

## 7. Walkthroughs

**Changing a colour with a rule as the destination.** The inspector calls `StyleWriter.set`. The destination is a rule the agent reported as matching (stylesheet path, ordinal, selector). `css/model.ts` parses the stylesheet buffer, `locateRule` finds the rule by ordinal and verifies the selector (falling back to the nearest same-selector rule if the browser dropped an invalid rule and numbering drifted), and `setDeclaration` returns the edit. The edit is applied as *canvas-stable* and the agent applies the same change to the live CSSOM, so there is no reload. The stylesheet gets a tab so the unsaved change is visible.

**Typing in the source view.** The model changes with source *user*. The store debounces an overlay push to the preview server. The canvas controller bumps the epoch for HTML and schedules a reload (a stylesheet change hot-swaps instead). On `ready` the controller re-selects the previously selected element if the element at that ordinal still has the same tag.

**Dragging from a panel.** Native drag events do not reliably cross into a cross-origin iframe, so while a panel drag is in progress the controller lays a transparent shield over the iframe, receives `dragover`/`drop` itself, and relays canvas coordinates. The agent computes the drop target and emits an `insert` operation. Asset paths are made relative to the file that will receive the markup.

**Sass.** A page links `css/site.css`; the site contains `css/site.scss`. When the preview server is asked for a stylesheet that does not exist and a Sass file of the same name does, it compiles and serves it, reading imports through the same overlay as everything else - so an unsaved edit to a partial restyles the canvas. A compile error is served as a stylesheet that prints the error at the top of the page. The build writes the compiled `.css` and leaves `.scss` files out; link checking and link repair treat the two names as one file. Rules that come from Sass are not offered as inspector destinations, because the compiled rule has no single place in the source; the inspector says so and offers to open the file.

**Selecting several elements.** The agent keeps a primary element and a list of extras. Structural gestures send one operation naming every element (`removeMany`, `duplicateMany`, `moveMany`, `group`), and the patcher computes all the edits against a single parse - doing them one at a time would renumber elements between steps. Nested selections collapse to their outermost element first.

**Publishing.** `DeployService.plan` builds the site, hashes the output and diffs it against the destination's ledger (`.wovenpage/publish-<id>.json`). The dialog shows the plan. `publish` connects, uploads and deletes, updating the ledger per file so an interrupted run resumes. Build errors block publishing.

## 8. Security model

- The renderer is sandboxed with context isolation and no Node integration. It reaches main only through an allow-listed, typed interface, and main verifies each call came from the workbench's own frame.
- The renderer is served from a private scheme with a strict Content Security Policy: only bundled script runs.
- The window cannot navigate away or open windows. The canvas iframe is sandboxed and confined to the loopback preview server; anything else opens in the user's browser.
- The preview server binds to 127.0.0.1, rejects requests with a foreign `Host` (DNS rebinding), blocks path traversal, and grants cross-origin read access only to the app's own origin.
- `ProjectService.abs()` is the single conversion from site-relative to absolute paths and refuses anything outside the site.
- Passwords are encrypted with the operating system's credential protection (DPAPI on Windows) and never written to the project. If encryption is unavailable they are kept in memory only.
- Deleting a file moves it to the Recycle Bin (falling back to permanent deletion only if the system refuses). Publishing can remove only files this app uploaded.

**A boundary to know about.** The page being edited runs its own scripts in the canvas iframe, alongside the agent. A script on that page could post forged canvas operations. The blast radius is limited to structured edits of the HTML files that make up that page - there is no file path or shell in the protocol - but it is a real trust assumption: you are editing your own site. Hardening would be a per-load secret delivered to the agent before page scripts run.

## 9. Tests

| Suite | Covers |
| --- | --- |
| `tests/core.test.ts` | Parser ranges, implied end tags, instrumentation; every patch function including indentation, no-op moves and the multiple-selection forms; CSS model and edits; composition, URL rebasing, canvas addressing, cycles; links and retargeting; lint rules |
| `tests/services.test.ts` | Project CRUD and path jail; link repair on rename and folder move; preview composition, overlays, part preview, Range, host and origin checks, events; search and replace; build; whole-site lint; publish planning, pruning and ledger; Sass compile, preview, build, lint and link repair |
| `tests/transports.test.ts` | Real FTP and SFTP round trips against in-process servers; wrong password; refused connection |
| `tests/e2e/smoke.mjs` | Launches the app and checks 23 workflows end to end against the files on disk: selection, inline and rule styles, text editing, insert by drag, reorder by drag, multiple selection with styling, grouping and undo, delete and undo, editing a part from a page, source-to-canvas, search, problems, build, part instance parameters, resize handles and snapping, device widths, Interact navigation, new page, assets, publish to a folder, Sass written by another program, theme |

## 10. Known limits

Stated plainly, so nobody discovers them the hard way:

- **Windows coverage is automated, not hands-on.** `.github/workflows/windows.yml` runs the type check, every test, the end-to-end test and the installer build on Windows Server for each push, and all of it passes. Nobody has yet installed the result on a desktop Windows machine and used it by hand, and DPAPI password storage is not exercised by the tests (publishing to a folder needs no password).
- **FTPS and SFTP key authentication are untested.** Plain FTP and SFTP with a password are tested over the wire.
- **The parser is not a full HTML5 tree builder.** It handles implied end tags for the common cases; in badly malformed markup, its idea of where an element ends can differ from the browser's. Addresses stay correct (they are tied to open tags); a move or delete in such markup may take more or less than expected, and is undoable.
- **URL rebasing covers attributes only.** `url()` inside an inline `style` or a `<style>` block in a layout or part is not rebased. Put such rules in a stylesheet.
- **Elements created by page scripts are not editable**, since they have no source. Clicks on them select the nearest authored ancestor.
- **Guides appear when resizing only.** Elements are moved by reordering them in the document flow, so there is no free positioning to align. After a multiple-selection move, only the first moved element stays selected, and attributes are edited one element at a time.
- **Rules that come from Sass cannot be written by the inspector**; they are edited in Source. Inline styles and plain CSS files work as usual on the same page.
- **Clearing a longhand that came from a shorthand** (for example `padding-top` when the rule says `padding: 1rem`) changes the canvas until the next reload but not the source.
- **Canvas undo is per operation and is cleared by typing in Source**, where the editor's own undo takes over. Both act on the same history, so nothing is lost.
- **If a page script navigates the canvas itself** in Interact mode, the agent is not on the new page; press F5.
- **JavaScript diagnostics are syntax only.** No bundling or TypeScript compilation. Sass supports the `.scss` syntax, not the indented `.sass` syntax.
- **No code signing or auto-update** yet, so Windows will warn about an unknown publisher. The app icon is in `build/` and is applied when the installer is built on Windows; a build made on another OS keeps Electron's default icon on the executable.
- **Scale.** The tree and index are recomputed on change, which is fine for hundreds or a few thousand files and would need incremental updates beyond that.

## 11. Extending it

- **A style control**: add one entry to `STYLE_SECTIONS` in `shared/styleSchema.ts`. The inspector renders it and the agent starts reporting its computed value.
- **A publishing protocol**: implement `Transport` (four methods) and add a case to `defaultTransportFactory`.
- **A palette element**: add an entry to `renderer/panels/palette.ts`.
- **A validation rule**: add it to `shared/lint.ts`; it appears in the editor and in the whole-site check.
- **A command**: register it in `Workbench.registerCommands`; add a menu line in `main/menu.ts` if it deserves one.
- **A canvas gesture**: emit a new `CanvasOp` from the agent, add the patch function to `shared/html/patch.ts` with a unit test, and handle it in `CanvasController.apply`.
