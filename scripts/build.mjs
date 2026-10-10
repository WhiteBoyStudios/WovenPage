// Builds every target with esbuild:
//   dist/main      main process + preload (Node, CommonJS)
//   dist/renderer  workbench UI + Monaco + its web workers
//   dist/canvas    the canvas agent and live-reload client injected into previewed pages
//
// Usage: node scripts/build.mjs [--watch] [--minify]

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const out = (p) => resolve(root, 'dist', p);
const src = (p) => resolve(root, 'src', p);

const common = {
  bundle: true,
  sourcemap: !minify,
  minify,
  logLevel: 'info',
  legalComments: 'none',
};

const targets = [
  {
    ...common,
    entryPoints: { main: src('main/main.ts'), preload: src('main/preload.ts') },
    outdir: out('main'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // ssh2 ships optional native code, so it is loaded from node_modules at run time.
    // sass is a large pure-JS compiler; like ssh2 it is shipped in node_modules rather than bundled.
    external: ['electron', 'ssh2-sftp-client', 'ssh2', 'cpu-features', 'sass'],
  },
  {
    ...common,
    entryPoints: { app: src('renderer/app.ts') },
    outdir: out('renderer'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome128',
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
  },
  {
    ...common,
    entryPoints: {
      'editor.worker': 'monaco-editor/editor/editor.worker.js',
      'json.worker': 'monaco-editor/language/json/json.worker.js',
      'css.worker': 'monaco-editor/language/css/css.worker.js',
      'html.worker': 'monaco-editor/language/html/html.worker.js',
      'ts.worker': 'monaco-editor/language/typescript/ts.worker.js',
    },
    outdir: out('renderer/workers'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome128',
    sourcemap: false,
    logLevel: 'warning',
  },
  {
    ...common,
    entryPoints: { agent: src('canvas/agent.ts'), live: src('canvas/live.ts') },
    outdir: out('canvas'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome110',
    sourcemap: false,
  },
];

async function copyStatic() {
  await mkdir(out('renderer'), { recursive: true });
  await cp(src('renderer/index.html'), out('renderer/index.html'));
}

if (!watch) await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes. Restart the app to pick up main-process changes.');
} else {
  await Promise.all(targets.map((t) => build(t)));
}
