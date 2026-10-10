// Turns failing tests in a TAP report into GitHub Actions error annotations,
// so a failure can be read from the run's summary page (and through the API)
// without opening the raw log.
//
//   node scripts/annotate-failures.mjs test.tap

import { readFileSync } from 'node:fs';

const file = process.argv[2];
let tap = '';
try {
  tap = readFileSync(file, 'utf8');
} catch {
  console.log(`::error title=Tests::No test report was written to ${file}; the runner failed before any test ran.`);
  process.exit(0);
}

const escape = (text) => text.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const lines = tap.split(/\r?\n/);
let reported = 0;
for (let i = 0; i < lines.length && reported < 10; i++) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  // The YAML block that follows holds the error; keep the informative part of it.
  const block = [];
  for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) block.push(lines[j].slice(m[1].length));
  const text = block.join('\n');
  if (/failureType: 'subtestsFailed'/.test(text)) continue; // the file-level wrapper, not a test
  const detail = text
    .split('\n')
    .filter((l) => !/^\s*(---|duration_ms|type:|location:|failureType:)/.test(l))
    .join('\n')
    .slice(0, 3000);
  console.log(`::error title=${escape(m[2]).slice(0, 200)}::${escape(detail)}`);
  reported++;
}
if (!reported) console.log(`::error title=Tests::The test run failed but no failing test was found in ${file}.`);
