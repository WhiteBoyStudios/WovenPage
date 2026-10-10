// Check: the build produced every file the app loads at run time.
//
//   node scripts/ci/check-build.mjs

import { appendFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// [path, minimum size in bytes]
const expected = [
  ['dist/main/main.js', 50_000],
  ['dist/main/preload.js', 300],
  ['dist/renderer/index.html', 300],
  ['dist/renderer/app.js', 1_000_000],
  ['dist/renderer/app.css', 50_000],
  ['dist/renderer/workers/editor.worker.js', 10_000],
  ['dist/renderer/workers/html.worker.js', 10_000],
  ['dist/renderer/workers/css.worker.js', 10_000],
  ['dist/renderer/workers/json.worker.js', 10_000],
  ['dist/renderer/workers/ts.worker.js', 10_000],
  ['dist/canvas/agent.js', 5_000],
  ['dist/canvas/live.js', 200],
];

const problems = [];
let total = 0;
for (const [file, min] of expected) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    problems.push(`${file} is missing`);
    continue;
  }
  const size = statSync(path).size;
  total += size;
  if (size < min) problems.push(`${file} is only ${size} bytes (expected at least ${min})`);
}

const detail = problems.length ? problems.join('; ') : `${expected.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `detail=${detail}\n`);
console.log(detail);
if (problems.length) {
  console.log(`::error title=Build output incomplete::${problems.join('%0A')}`);
  process.exit(1);
}
