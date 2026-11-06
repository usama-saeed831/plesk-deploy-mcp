import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const json = <T>(file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;

type Option = {
  type: string;
  title: string;
  description: string;
  default?: unknown;
  sensitive?: boolean;
};
type Plugin = {
  name: string;
  version: string;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  userConfig: Record<string, Option>;
};
type Marketplace = { name: string; plugins: { name: string; source: string }[] };

const pkg = json<{ name: string; version: string }>('package.json');
const plugin = json<Plugin>('plugins/plesk-deploy/.claude-plugin/plugin.json');
const marketplace = json<Marketplace>('.claude-plugin/marketplace.json');

describe('the Claude Code plugin', () => {
  it('is in step with kit/ and the package version', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-plugin.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it('runs the published server, pinned to this exact version', () => {
    const server = plugin.mcpServers['plesk-deploy'];
    expect(plugin.version).toBe(pkg.version);
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', `${pkg.name}@${pkg.version}`]);
  });

  it('declares every option it references, each with a default so Cowork loads the server', () => {
    const env = plugin.mcpServers['plesk-deploy']?.env ?? {};
    const referenced = Object.values(env).flatMap((v) =>
      [...v.matchAll(/\$\{user_config\.([A-Za-z_]\w*)\}/g)].map((m) => m[1]),
    );
    expect(referenced.sort()).toEqual(Object.keys(plugin.userConfig).sort());
    for (const [key, option] of Object.entries(plugin.userConfig)) {
      expect(
        Object.keys(option).every((k) =>
          ['type', 'title', 'description', 'default', 'sensitive', 'required'].includes(k),
        ),
        key,
      ).toBe(true);
      expect(option.default, key).toBe('');
    }
    expect(plugin.userConfig.github_token?.sensitive).toBe(true);
  });

  it('is listed in the marketplace at its folder', () => {
    expect(marketplace.name).toBe('plesk-deploy-mcp');
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    expect(entry?.source).toBe('./plugins/plesk-deploy');
    expect(existsSync(path.join(ROOT, entry!.source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('has the README and LICENSE a directory listing needs', () => {
    const readme = readFileSync(path.join(ROOT, 'plugins/plesk-deploy/README.md'), 'utf8');
    expect(readme.split(/\s+/).length).toBeGreaterThan(40);
    expect(existsSync(path.join(ROOT, 'plugins/plesk-deploy/LICENSE'))).toBe(true);
  });
});
