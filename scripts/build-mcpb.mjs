#!/usr/bin/env node
// Builds the Claude Desktop extension: build/plesk-deploy-mcp-<version>.mcpb.
// It holds the compiled server, the vendored kit, production dependencies
// only, the manifest and the icon. Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'mcpb/manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(
    `mcpb/manifest.json is version ${manifest.version}, package.json is ${pkg.version}.`,
  );
  process.exit(1);
}
if (!existsSync(path.join(root, 'dist/index.js'))) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}

const stage = path.join(root, 'build', 'mcpb');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const [from, to] of [
  ['dist', 'dist'],
  ['kit', 'kit'],
  ['mcpb/manifest.json', 'manifest.json'],
  ['mcpb/icon.png', 'icon.png'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['PRIVACY.md', 'PRIVACY.md'],
]) {
  cpSync(path.join(root, from), path.join(stage, to), { recursive: true });
}

const win = process.platform === 'win32';
const run = (cmd, args) =>
  execFileSync(win ? `${cmd}.cmd` : cmd, args, { cwd: stage, stdio: 'inherit', shell: win });
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);

const mcpb = path.join(root, 'node_modules', '.bin', 'mcpb');
const out = path.join(root, 'build', `${pkg.name}-${pkg.version}.mcpb`);
run(mcpb, ['validate', path.join(stage, 'manifest.json')]);
run(mcpb, ['pack', stage, out]);
console.error(`Built ${path.relative(root, out)}`);
