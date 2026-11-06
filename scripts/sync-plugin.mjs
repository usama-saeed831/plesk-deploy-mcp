#!/usr/bin/env node
// Keeps the Claude Code plugin in plugins/plesk-deploy/ in step with the
// package:
//   - skills/plesk-deploy/ is a copy of kit/ (a skill must contain the
//     references and templates its SKILL.md points to), with a note in
//     SKILL.md about the MCP tools the plugin brings;
//   - LICENSE is a copy of the repository's;
//   - plugin.json's version and its `npx plesk-deploy-mcp@<version>` pin equal
//     package.json's version.
//
//   node scripts/sync-plugin.mjs           write the plugin
//   node scripts/sync-plugin.mjs --check   change nothing; exit 1 if it is out of date
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = path.join(root, 'plugins', 'plesk-deploy');
const skill = path.join(plugin, 'skills', 'plesk-deploy');
const check = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const NOTE = `> **This plugin also installs the plesk-deploy MCP server.** Use its tools for the
> work below:
> - \`inspect_project\`: phase 1's reading.
> - \`server_discovery_commands\`: phase 2's command block. \`server_discover\` runs
>   the same commands over SSH, if the user allowed the host.
> - \`generate_deploy_kit\`: renders phase 5's files as a diff, and writes them only
>   with \`write: true\` after the user agrees.
> - \`validate_deploy_kit\`: runs the checks and \`scripts/test-release-manager.sh\`.
> - \`deploy_status\`, \`deploy_logs\`, \`rollback\` and \`github_deploy_runs\`: phase 7.
>
> Every rule below still applies to everything they do.

`;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** Every file the plugin should contain, by path, with its content and mode. */
const expected = new Map();
for (const file of walk(path.join(root, 'kit'))) {
  const rel = path.relative(path.join(root, 'kit'), file);
  let content = readFileSync(file);
  if (rel === 'SKILL.md') {
    const text = content.toString('utf8');
    const end = text.indexOf('\n---\n', 4) + 5;
    content = Buffer.from(`${text.slice(0, end)}\n${NOTE}${text.slice(end).replace(/^\n+/, '')}`);
  }
  expected.set(path.join(skill, rel), { content, mode: statSync(file).mode & 0o777 });
}
expected.set(path.join(plugin, 'LICENSE'), {
  content: readFileSync(path.join(root, 'LICENSE')),
  mode: 0o644,
});
const manifestPath = path.join(plugin, '.claude-plugin', 'plugin.json');
const manifest = readFileSync(manifestPath, 'utf8')
  .replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
  .replace(/plesk-deploy-mcp@[^"]*/, `plesk-deploy-mcp@${version}`);
expected.set(manifestPath, { content: Buffer.from(manifest), mode: 0o644 });

if (check) {
  const problems = [];
  for (const [file, { content }] of expected) {
    let actual;
    try {
      actual = readFileSync(file);
    } catch {
      problems.push(`missing: ${path.relative(root, file)}`);
      continue;
    }
    if (!actual.equals(content)) problems.push(`out of date: ${path.relative(root, file)}`);
  }
  for (const file of walk(skill))
    if (!expected.has(file)) problems.push(`not in kit/: ${path.relative(root, file)}`);
  if (problems.length) {
    console.error(
      `The plugin is out of step with the package. Run: npm run sync:plugin\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.error(`The plugin is in step with kit/ and version ${version}.`);
} else {
  rmSync(skill, { recursive: true, force: true });
  for (const [file, { content, mode }] of expected) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  console.error(`Synced plugins/plesk-deploy (version ${version}).`);
}
