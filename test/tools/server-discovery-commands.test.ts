import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoveryCommands } from '../../src/discovery/commands.js';
import { call, connect } from '../helpers/client.js';

let session: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => session.close());

type Out = { block: string; commands: { id: string; command: string; missing: string[] }[] };

describe('server_discovery_commands', () => {
  it('fills in what it knows and leaves placeholders for the rest', async () => {
    const r = await call<Out>(session.client, 'server_discovery_commands', {
      domain: 'example.com',
    });
    expect(r.isError).toBe(false);
    expect(r.structured.block).toContain('plesk bin subscription --info example.com');
    expect(r.structured.block).toContain('ls -la /var/www/vhosts/example.com/httpdocs/ | head -30');
    expect(r.structured.block).toContain('sudo -n -u <domain system user> pm2 ls');
    expect(r.structured.block).toContain('<path to .env>');
    expect(r.text).toMatch(/as root/);
    expect(r.text).toMatch(/remove any secret before pasting/);
    expect(r.text).toMatch(/Who runs the app, on which runtime/); // the discovery reference's notes
  });

  it('has no placeholders once everything is known', async () => {
    const r = await call<Out>(session.client, 'server_discovery_commands', {
      domain: 'example.com',
      app: 'acme',
      system_user: 'acme_sys',
      pm2_processes: ['acme-api', 'acme-web'],
      app_dir: '/var/www/vhosts/example.com/httpdocs/api',
      env_file: '/var/www/vhosts/example.com/httpdocs/api/.env',
    });
    expect(r.structured.block).not.toMatch(
      /<(domain system user|process name|app folder|path to \.env)>/,
    );
    expect(r.structured.commands.every((c) => c.missing.length === 0)).toBe(true);
    expect(r.structured.block).toContain("pm2 info acme-api | grep -E 'exec cwd");
    expect(r.structured.block).toContain('ls -l /usr/local/bin/acme-deploy /etc/acme/deploy.conf');
  });

  it('only contains read-only commands', () => {
    const all = discoveryCommands({
      domain: 'example.com',
      app: 'acme',
      system_user: 'u',
      pm2_processes: ['p'],
      app_dir: '/a',
      env_file: '/a/.env',
    });
    for (const c of all) {
      // Quoted text (sed scripts, grep patterns) is data, not shell syntax.
      const unquoted = c.command.replace(/'[^']*'/g, "''");
      expect(unquoted, c.id).not.toMatch(
        /\b(rm|mv|cp|chmod|chown|kill|restart|reload|start|stop|delete|install|tee)\b(?! --info)|>(?!\/dev\/null|&)/,
      );
    }
  });

  it('rejects values that are not what they claim to be', async () => {
    for (const args of [
      { domain: 'example.com; rm -rf /' },
      { domain: 'example.com', system_user: 'root; id' },
      { domain: 'example.com', app_dir: '/var/www/$(id)' },
      { domain: 'example.com', pm2_processes: ['-x'] },
    ]) {
      const r = await session.client
        .callTool({ name: 'server_discovery_commands', arguments: args })
        .catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
  });
});

describe.skipIf(process.platform === 'win32')('the env-names command', () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'envnames-')));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints NAME=<set> or NAME=<empty> and nothing else, even for multi-line values', () => {
    const env = path.join(dir, 'app.env');
    writeFileSync(
      env,
      [
        '# a comment with a value=inside',
        'DB_PASSWORD=hunter2',
        'export API_TOKEN="abc def"',
        'EMPTY=',
        'SPACES=   ',
        'PRIVATE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAA',
        '-----END OPENSSH PRIVATE KEY-----"',
        '  INDENTED=1',
        '',
      ].join('\n'),
    );
    const command = discoveryCommands({ domain: 'example.com', env_file: env }).find(
      (c) => c.id === 'env-names',
    )!.command;
    const out = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim().split('\n')).toEqual([
      'DB_PASSWORD=<set>',
      'API_TOKEN=<set>',
      'EMPTY=<empty>',
      'SPACES=<empty>',
      'PRIVATE_KEY=<set>',
      'INDENTED=<set>',
    ]);
  });
});
