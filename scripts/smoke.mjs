#!/usr/bin/env node
// End-to-end smoke test of the built server over real stdio: lists what it
// offers and runs every local tool against a project folder (a git
// repository). The kit is generated as a dry run, then written, then
// validated, so use a throwaway copy of a project.
//
//   npm run build && node scripts/smoke.mjs /path/to/throwaway/project
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = process.argv[2];
if (!project || !path.isAbsolute(project)) {
  console.error('Usage: node scripts/smoke.mjs <absolute path to a throwaway git project>');
  process.exit(2);
}
const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const client = new Client({ name: 'plesk-deploy-mcp-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'pipe' }),
);

const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ step: name, ok: true, note, ms: Date.now() - started });
  } catch (error) {
    results.push({
      step: name,
      ok: false,
      note: String(error?.message ?? error),
      ms: Date.now() - started,
    });
  }
};
const raw = [];
const callTool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  raw.push(JSON.stringify(r));
  if (r.isError) throw new Error(r.content?.[0]?.text ?? 'error');
  return r;
};

await step(
  'initialize',
  async () => `${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`,
);
await step('tools/list', async () => {
  const { tools } = await client.listTools();
  const bad = tools.filter(
    (t) =>
      !t.annotations?.title ||
      typeof t.annotations.readOnlyHint !== 'boolean' ||
      typeof t.annotations.destructiveHint !== 'boolean',
  );
  if (bad.length) throw new Error(`missing annotations: ${bad.map((t) => t.name)}`);
  return `${tools.length} tools, all annotated`;
});
await step('resources/list + read', async () => {
  const { resources } = await client.listResources();
  const r = await client.readResource({ uri: 'plesk-deploy://workflow' });
  return `${resources.length} resources; workflow is ${r.contents[0].text.length} chars`;
});
await step('prompts/get setup-plesk-deployment', async () => {
  const p = await client.getPrompt({
    name: 'setup-plesk-deployment',
    arguments: { project_dir: project },
  });
  return `${p.messages[0].content.text.length} chars`;
});

let facts;
await step('inspect_project', async () => {
  const r = await callTool('inspect_project', { project_dir: project });
  facts = r.structuredContent;
  const verified = facts.facts.filter((f) => f.status === 'verified').length;
  return `${facts.apps.map((a) => `${a.path}:${a.kind}`).join(', ')}; ${verified}/${facts.facts.length} facts verified; env files present: ${facts.env_files_present.join(', ') || 'none'}`;
});
await step('server_discovery_commands', async () => {
  const r = await callTool('server_discovery_commands', { domain: 'example.com', app: 'shop' });
  return `${r.structuredContent.commands.length} read-only commands`;
});
const kit = {
  project_dir: project,
  app: 'shop',
  stack: 'node',
  process_manager: 'pm2',
  site_url: 'https://example.com/',
  public_health_url: 'https://example.com/health/ready',
  base_dir: '/var/www/shop-app',
  health_checks: [{ url: 'http://127.0.0.1:3001/health/ready', contains: '"status":"ready"' }],
  health_commit_url: 'http://127.0.0.1:3001/health/ready',
  pm2_apps: [{ name: 'shop-api', dir: '.', script: 'dist/server.js' }],
  database: 'postgres',
  migrate_cmd: 'npx --no-install knex migrate:latest',
  runtime_env_names: ['PORT', 'DATABASE_URL', 'SESSION_SECRET'],
};
await step('generate_deploy_kit (dry run)', async () => {
  const r = await callTool('generate_deploy_kit', kit);
  const s = r.structuredContent;
  if (s.written) throw new Error('a dry run wrote files');
  return `${s.files.length} files planned (${[...new Set(s.files.map((f) => f.action))].join(', ')}); ${s.adapt.length} points to adapt; ${s.warnings.length} warnings`;
});
await step('generate_deploy_kit (write)', async () => {
  const r = await callTool('generate_deploy_kit', { ...kit, write: true });
  return `written: ${r.structuredContent.written}`;
});
await step('validate_deploy_kit', async () => {
  const r = await callTool('validate_deploy_kit', { project_dir: project });
  const s = r.structuredContent;
  const failed = s.checks.filter((c) => c.status === 'fail');
  if (failed.length)
    throw new Error(`failed: ${failed.map((c) => `${c.id} (${c.details.join('; ')})`).join(', ')}`);
  return s.checks.map((c) => `${c.id}=${c.status}`).join(', ');
});
await step('SSH tools stay off without PLESK_DEPLOY_SSH_HOSTS', async () => {
  const r = await client.callTool({
    name: 'deploy_status',
    arguments: { host_alias: 'prod', app: 'shop' },
  });
  if (!r.isError || !/server tools are off/.test(r.content[0].text))
    throw new Error('expected a refusal');
  return 'refused, as expected';
});
await step('no canary value anywhere in the results', async () => {
  const all = raw.join('\n');
  if (all.includes('canary-')) throw new Error('a .env value leaked');
  return `none found in ${raw.length} tool responses (${all.length} characters)`;
});

await client.close();
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step} (${r.ms} ms): ${r.note}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
