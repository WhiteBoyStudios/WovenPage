// Check: the packaging step completed and produced a sound installer.
// Confirms the installer and the unpacked app exist, that the installer is a
// plausible size, and that the app bundle contains what it needs and nothing
// it should not.
//
//   node scripts/ci/check-package.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { version, productName } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const release = resolve(root, 'release');
const problems = [];
const out = (key, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

const installerName = `${productName}-Setup-${version}.exe`;
const installer = resolve(release, installerName);
let detail = '';
if (!existsSync(installer)) {
  const found = existsSync(release) ? readdirSync(release).join(', ') : 'no release folder';
  problems.push(`${installerName} was not produced (found: ${found})`);
} else {
  const size = statSync(installer).size;
  const mb = size / 1024 / 1024;
  if (mb < 60 || mb > 400) problems.push(`${installerName} is ${mb.toFixed(0)} MB, outside the expected 60-400 MB`);
  const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
  detail = `${installerName}, ${mb.toFixed(0)} MB`;
  out('installer', installerName);
  out('sha256', sha256);
  console.log(`${installerName}: ${mb.toFixed(1)} MB, sha256 ${sha256}`);
}

const exe = resolve(release, 'win-unpacked', `${productName}.exe`);
const asar = resolve(release, 'win-unpacked', 'resources', 'app.asar');
if (!existsSync(exe)) problems.push(`win-unpacked/${productName}.exe is missing`);
if (!existsSync(asar)) {
  problems.push('win-unpacked/resources/app.asar is missing');
} else {
  // List the bundle with the asar tool that ships with electron-builder.
  const cli = resolve(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const listing = execFileSync(process.execPath, [cli, 'list', asar], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((line) => line.replace(/\\/g, '/'));
  const has = (path) => listing.includes(path);
  for (const needed of [
    '/package.json',
    '/dist/main/main.js',
    '/dist/main/preload.js',
    '/dist/renderer/index.html',
    '/dist/renderer/app.js',
    '/dist/renderer/workers/editor.worker.js',
    '/dist/canvas/agent.js',
    '/node_modules/sass/package.json',
    '/node_modules/ssh2-sftp-client/package.json',
    '/node_modules/ssh2/package.json',
  ]) {
    if (!has(needed)) problems.push(`the app bundle is missing ${needed}`);
  }
  const maps = listing.filter((p) => p.startsWith('/dist/') && p.endsWith('.map'));
  if (maps.length) problems.push(`the app bundle contains ${maps.length} source map(s), e.g. ${maps[0]}`);
  const sources = listing.filter((p) => p.startsWith('/src/') || p.startsWith('/tests/'));
  if (sources.length) problems.push(`the app bundle contains source or test files, e.g. ${sources[0]}`);
  console.log(`app.asar: ${listing.length} entries`);
}

out('detail', problems.length ? problems.join('; ') : detail);
if (problems.length) {
  console.log(`::error title=Packaging incomplete::${problems.join('%0A')}`);
  process.exit(1);
}
