# Wovenpage - working notes

Read this first when picking the project up. It records what was decided, what has been verified, and the things that cost time to discover. Design detail lives in `docs/ARCHITECTURE.md`; originality rules in `docs/ORIGINALITY.md`.

## What this is

A Windows desktop web-authoring tool (Electron + TypeScript + Monaco) with a design view and a code view that edit the same source text. The owner's requirement is that it be an entirely original product: no copying of any commercial tool's code, layouts, icons, wording or workflows. Follow the rules in `docs/ORIGINALITY.md` for every change.

## Decisions already made by the owner

- **Stack:** Electron. Do not propose a rewrite in C#/WPF.
- **Templating:** the project's own format stays - `<w-page>`, `<w-fill>`, `<w-slot>`, `<w-part>`, `{{name | fallback}}`, compiled to plain HTML on build.
- **Name:** "Wovenpage" stays. No trademark or domain search has been done; that is still open.
- **Direction:** both hardening for Windows and deepening the editor were approved.

## Commands

```
npm install
npm start                 # build and launch
npm run typecheck
npm test                  # 45 unit, service and transport tests
npm run build && npm run e2e   # 23 end-to-end checks against the real app
npm run dist              # Windows installer (must run on Windows: NSIS needs it)
npm run dist:portable     # Windows zip, builds on any OS
```

On Linux the end-to-end test needs a display:

```
SHOTS=/some/dir xvfb-run -a -s "-screen 0 1600x1000x24" node tests/e2e/smoke.mjs
APP_PATH=release/win-unpacked/resources/app.asar ...   # run it against a packaged build
```

## How the code is laid out

- `src/shared` - pure TypeScript core used by all three processes: position-tracking HTML parser, text patchers, CSS model, composer, link graph, lint, and the IPC and canvas protocols. Change behaviour here first, with a unit test in `tests/core.test.ts`.
- `src/main` - Electron main process. Everything in `services/` is free of Electron imports so it can be tested in plain Node.
- `src/canvas/agent.ts` - injected into the previewed page; turns gestures into operations addressed by source id. It never edits source.
- `src/renderer` - the workbench. `DocumentStore` owns one Monaco model per file; `CanvasController` turns operations into patches; panels depend on the `Shell` interface.

The invariant that everything rests on: **element ids are only valid for the exact text they were generated from.** Any edit that can renumber elements must go through `DocumentStore.applyEdits(..., 'canvas-struct')` (bumps the epoch, reloads the canvas). Edits that cannot renumber use `'canvas-stable'`. Several elements must be edited against one parse, never one at a time.

## Things that are easy to get wrong

- **Never `pkill -f electron`** in a shell command - it matches the shell itself. Use `pkill -x electron`.
- The app takes a single-instance lock. A leftover Electron process makes the next launch exit at once, and Playwright then waits forever for a window.
- Closing the app with unsaved files raises a native dialog that blocks exit. Tests save first, then kill the process as a fallback.
- Playwright cannot deliver drag events into the cross-origin canvas iframe, and real browsers are not reliable about it either. Panel drags therefore go through a transparent shield over the iframe (`CanvasController.buildShield`) that relays coordinates. Do not replace it with native drag-and-drop into the iframe.
- The canvas agent's overlay lives in a closed shadow root whose host is reset with `all: initial`; set fonts on the inner elements, not on `:host`.
- Monaco's base themes colour HTML, CSS and XML tokens with language-specific rules, so custom theme rules must name those tokens explicitly (`tokenRules` in `monacoSetup.ts`).
- Monaco 0.57 exports `monaco.typescript` / `monaco.css` at the top level, and worker entry points are `monaco-editor/editor/editor.worker.js` and `monaco-editor/language/<lang>/<lang>.worker.js`.
- `sass` and `ssh2-sftp-client` are external to the main bundle and must stay in `dependencies`; `acorn` and `basic-ftp` are bundled and are dev dependencies.
- The NSIS installer cannot be built off Windows without wine. The portable zip can, with `signAndEditExecutable=false` (so the exe keeps Electron's icon).
- In the end-to-end test, wait for a toast by its text; earlier toasts linger.

## Verified, and not

Verified on Linux under Electron 44: type check, all 45 tests (including real FTP and SFTP round trips against in-process servers), all 23 end-to-end checks on the working tree and on the packaged `app.asar`, and a clean install from the source archive.

Not verified:

- **The app has never been launched on Windows.** `.github/workflows/windows.yml` runs everything on Windows once the repository is on GitHub.
- FTPS, and SFTP with a key file.
- "Preview in browser" (opens the system browser).
- DPAPI password storage, the installer, code signing, auto-update.

## Known limits worth fixing next

See section 10 of `docs/ARCHITECTURE.md` for the full list. The ones most likely to be asked for:

1. A Windows test pass and a signed installer.
2. Inspector writes to rules that come from Sass (needs source maps from the compiler).
3. Restoring a multiple selection after a group move.
4. A per-load secret for the canvas protocol, so a script on the edited page cannot forge operations.
5. `url()` rebasing inside inline styles and `<style>` blocks in layouts and parts.
