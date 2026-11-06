#!/usr/bin/env node
// Checks what `npm pack` would publish: everything needed is in, nothing
// private or development-only is, the scripts keep their executable bit, and
// the private project's name appears nowhere. Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The same denylist as test/helpers/private-names.ts: SHA-256 of lowercase words.
const DENIED = new Set(['c620110ec8885bb880996ac34646d337457018fbac08e7915a64483d4feb7635']);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
// npm 11 prints an array, npm 12 an object keyed by package name.
const parsed = JSON.parse(out);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = new Map(pack.files.map((f) => [f.path, f]));
const problems = [];

const walk = (dir) =>
  readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
  'PRIVACY.md',
  'dist/index.js',
  'dist/server.js',
  ...walk('kit'),
];
for (const f of required) if (!files.has(f)) problems.push(`missing from the package: ${f}`);

const forbidden = [
  /^(src|test|docs|scripts|mcpb|build|coverage|\.github)\//,
  /(^|\/)\.env(\.|$)/,
  /\.map$/,
  /^tsconfig/,
  /^eslint/,
  /^vitest/,
  /\.tgz$/,
  /\.mcpb$/,
];
for (const f of files.keys())
  if (forbidden.some((re) => re.test(f))) problems.push(`must not be published: ${f}`);

for (const f of [
  'kit/templates/server/app-deploy',
  'kit/templates/server/db-backup',
  'kit/templates/server/server-setup.sh',
  'kit/templates/build/build-bundle.sh',
  'kit/scripts/test-release-manager.sh',
]) {
  const entry = files.get(f);
  if (entry && (entry.mode & 0o111) === 0) problems.push(`lost its executable bit: ${f}`);
}

const bin = readFileSync(path.join(root, 'dist/index.js'), 'utf8');
if (!bin.startsWith('#!/usr/bin/env node'))
  problems.push('dist/index.js must start with #!/usr/bin/env node');

for (const f of files.keys()) {
  const buffer = readFileSync(path.join(root, f));
  if (buffer.includes(0)) continue;
  const text = buffer
    .toString('utf8')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  for (const word of new Set(text.match(/[a-z0-9]+/g) ?? [])) {
    if (DENIED.has(createHash('sha256').update(word).digest('hex')))
      problems.push(`a private name appears in ${f}`);
  }
}

if (pack.unpackedSize > 3 * 1024 * 1024)
  problems.push(`the package is ${pack.unpackedSize} bytes unpacked; expected under 3 MB`);

if (problems.length) {
  console.error(`npm pack check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.error(
  `npm pack check passed: ${files.size} files, ${(pack.unpackedSize / 1024).toFixed(0)} KB unpacked.`,
);
