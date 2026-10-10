// Emits the end of a log file as a GitHub Actions error annotation.
//
//   node scripts/annotate-tail.mjs "Title" build.log

import { readFileSync } from 'node:fs';

const [, , title = 'Step failed', file] = process.argv;
let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  text = `No log was written to ${file}.`;
}
// Strip ANSI colour codes, keep the last lines, and prefer the part from the first error onwards.
const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter((l) => l.trim());
const firstError = lines.findIndex((l) => /\b(error|⨯|failed|cannot|EPERM|EBUSY|ENOENT)\b/i.test(l));
const from = firstError === -1 ? Math.max(0, lines.length - 40) : Math.max(firstError - 3, lines.length - 60, 0);
const body = lines.slice(from).join('\n').slice(-3500);
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
console.log(`::error title=${escape(title).replace(/,/g, '%2C').replace(/:/g, '%3A')}::${escape(body)}`);
