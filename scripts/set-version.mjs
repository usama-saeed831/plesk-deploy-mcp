#!/usr/bin/env node
// Sets one version everywhere it is written: package.json and its lockfile,
// server.json (twice) and the .mcpb manifest.
//
//   npm run set-version 0.1.1
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('Usage: npm run set-version <major.minor.patch>');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['version', version, '--no-git-tag-version', '--allow-same-version'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const update = (file, change) => {
  const path = new URL(`../${file}`, import.meta.url);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  change(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};
update('server.json', (s) => {
  s.version = version;
  for (const p of s.packages ?? []) p.version = version;
});
update('mcpb/manifest.json', (m) => {
  m.version = version;
});
execFileSync(process.execPath, [fileURLToPath(new URL('./sync-plugin.mjs', import.meta.url))], {
  stdio: 'inherit',
});
console.error(`Version ${version} set. Next: update CHANGELOG.md, then npm run check:metadata.`);
