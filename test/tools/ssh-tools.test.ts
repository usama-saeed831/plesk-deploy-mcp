import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { discoveryCommands } from '../../src/discovery/commands.js';
import { RELEASE_MANAGER_TEMPLATE } from '../../src/kit.js';
import { call, connect, testConfig } from '../helpers/client.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const FAKE_SSH = path.join(FIXTURES, 'bin/ssh');
const HANDLER = path.join(FIXTURES, 'server/handler.sh');

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'ssh-tools-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A sandbox "server" with two releases (c2222222 live) and a config whose ssh is the fake. */
function server(extraEnv: Record<string, string> = {}, allowedHosts = ['prod']) {
  const dir = path.join(scratch, `server-${++n}`);
  const state = path.join(scratch, `ssh-state-${n}`);
  const r = spawnSync(
    'bash',
    [path.join(FIXTURES, 'server/sandbox.sh'), dir, RELEASE_MANAGER_TEMPLATE],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const config: Config = testConfig({
    sshBin: FAKE_SSH,
    allowedHosts,
    childEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FAKE_SSH_STATE: state,
      FAKE_SSH_HANDLER: HANDLER,
      FAKE_SERVER_DIR: dir,
      ...extraEnv,
    },
  });
  const sshCalls = () =>
    existsSync(state)
      ? readFileSync(path.join(state, 'call-1', 'argv'), 'utf8')
          .split('\0')
          .slice(0, -1)
      : [];
  const lastRemote = (k: number) =>
    readFileSync(path.join(state, `call-${k}`, 'argv'), 'utf8')
      .split('\0')
      .slice(0, -1)
      .at(-1);
  return { dir, state, config, sshCalls, lastRemote };
}

describe.skipIf(process.platform === 'win32')('SSH tools against a fake server', () => {
  describe('annotations', () => {
    it('marks reads as read-only and rollback as destructive', async () => {
      const s = await connect();
      const { tools } = await s.client.listTools();
      const a = (name: string) => tools.find((t) => t.name === name)?.annotations;
      for (const name of ['server_discover', 'deploy_status', 'deploy_logs']) {
        expect(a(name), name).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        });
      }
      expect(a('rollback')).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tools.map((t) => t.name).sort()).toEqual([
        'deploy_logs',
        'deploy_status',
        'generate_deploy_kit',
        'github_deploy_runs',
        'inspect_project',
        'rollback',
        'server_discover',
        'server_discovery_commands',
        'validate_deploy_kit',
      ]);
      await s.close();
    });
  });

  describe('a server with two releases', () => {
    const srv = server();
    let session: Awaited<ReturnType<typeof connect>>;
    beforeAll(async () => {
      session = await connect(srv.config);
    });
    afterAll(async () => session.close());

    it('deploy_status lists the releases and which is live', async () => {
      const r = await call<{
        live: { commit: string } | null;
        releases: { commit: string; live: boolean }[];
      }>(session.client, 'deploy_status', { host_alias: 'prod', app: 'acme' });
      expect(r.isError, r.text).toBe(false);
      expect(r.structured.releases.map((x) => [x.commit, x.live])).toEqual([
        ['c2222222', true],
        ['c1111111', false],
      ]);
      expect(r.structured.live?.commit).toBe('c2222222');
      expect(srv.lastRemote(1)).toBe('/usr/local/bin/acme-deploy --status');
      expect(srv.sshCalls()).toContain('StrictHostKeyChecking=yes');
    });

    it('deploy_logs reads the log through the one sudo rule, redacted', async () => {
      appendFileSync(path.join(srv.dir, 'deploy.log'), 'oops DB_PASSWORD=hunter2 leaked\n');
      const r = await call<{ lines: string[] }>(session.client, 'deploy_logs', {
        host_alias: 'prod',
        app: 'acme',
        lines: 5,
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.structured.lines.length).toBeLessThanOrEqual(5);
      expect(r.text).toContain('DB_PASSWORD=[REDACTED:assignment]');
      expect(JSON.stringify(r.raw)).not.toContain('hunter2');
    });

    it('server_discover runs only the allowlisted commands and redacts what comes back', async () => {
      const r = await call<{
        results: { id: string; output: string; exit_code: number | null }[];
        skipped: { id: string; missing: string[] }[];
      }>(session.client, 'server_discover', {
        host_alias: 'prod',
        domain: 'example.com',
        app: 'acme',
        env_file: '/etc/acme/app.env',
        app_dir: '/var/www/vhosts/example.com/httpdocs/api',
      });
      expect(r.isError, r.text).toBe(false);
      const out = (id: string) => r.structured.results.find((x) => x.id === id)?.output ?? '';
      expect(out('env-names')).toBe('DB_PASSWORD=<set>\nAPI_KEY=<empty>');
      expect(out('nginx-directives')).toContain('Authorization "Bearer [REDACTED:authorization]"');
      expect(out('crontab-current')).toContain('DB_PASS=[REDACTED:assignment]');
      expect(out('checkout')).toContain('deploy:[REDACTED:url-password]@github.com');
      expect(JSON.stringify(r.raw)).not.toMatch(/abc\.def\.ghi|s3cr3t|tok3n/);
      // A spoofed frame stays inside the section it was printed in.
      expect(out('sites')).toContain('spoofed');
      expect(r.structured.results.some((x) => x.id === 'fake')).toBe(false);
      // Commands that need a value that wasn't given are skipped, not guessed.
      expect(r.structured.skipped.map((s) => s.id)).toEqual(
        expect.arrayContaining(['pm2-user', 'crontab-user']),
      );

      const script = readFileSync(path.join(srv.dir, 'last-script'), 'utf8');
      const allowed = discoveryCommands({
        domain: 'example.com',
        app: 'acme',
        env_file: '/etc/acme/app.env',
        app_dir: '/var/www/vhosts/example.com/httpdocs/api',
      }).filter((c) => c.missing.length === 0);
      const ran = script.split('\n').filter((l) => l.startsWith('$T sh -c '));
      expect(ran).toHaveLength(allowed.length);
      for (const line of ran) expect(line).toMatch(/ <\/dev\/null 2>&1$/);
    });

    it('server_discover with sudo runs the script through sudo -n', async () => {
      const r = await call(session.client, 'server_discover', {
        host_alias: 'prod',
        domain: 'example.com',
        sudo: true,
        sections: ['plesk'],
      });
      expect(r.isError, r.text).toBe(false);
      const calls = readFileSync(
        path.join(srv.state, 'call-' + String(readDirCount(srv.state)), 'argv'),
        'utf8',
      ).split('\0');
      expect(calls).toContain('sudo -n sh -s');
    });

    it('rollback refuses without the exact confirmation, and runs nothing', async () => {
      const before = readDirCount(srv.state);
      for (const confirm of ['yes', 'acme@other', 'ACME@prod', 'acme@prod ']) {
        const r = await call(session.client, 'rollback', {
          host_alias: 'prod',
          app: 'acme',
          confirm,
        });
        expect(r.isError, confirm).toBe(true);
        expect(r.text).toMatch(/confirm must be exactly "acme@prod"/);
      }
      expect(readDirCount(srv.state)).toBe(before);
    });

    it('rollback makes the previous release live and says what is still to verify', async () => {
      const r = await call<{
        before: { commit: string } | null;
        after: { commit: string } | null;
        exit_code: number;
      }>(session.client, 'rollback', { host_alias: 'prod', app: 'acme', confirm: 'acme@prod' });
      expect(r.isError, r.text).toBe(false);
      expect(r.structured.exit_code).toBe(0);
      expect(r.structured.before?.commit).toBe('c2222222');
      expect(r.structured.after?.commit).toBe('c1111111');
      expect(r.text).toMatch(/Migrations were not undone/);
      expect(r.text).toMatch(/Verify from outside/);
    });

    it('rollback reports a failure from the release manager', async () => {
      const r = await call<{ exit_code: number }>(session.client, 'rollback', {
        host_alias: 'prod',
        app: 'acme',
        confirm: 'acme@prod',
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.structured.exit_code).not.toBe(0);
      expect(r.text).toMatch(/failed/);
      expect(r.text).toMatch(/no earlier release/);
    });
  });

  it('a cancelled rollback is left to finish on the server, never killed halfway', async () => {
    const srv = server({ FAKE_ROLLBACK_SLEEP: '2' });
    const session = await connect(srv.config);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    await expect(
      session.client.callTool(
        { name: 'rollback', arguments: { host_alias: 'prod', app: 'acme', confirm: 'acme@prod' } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await call<{ live: { commit: string } | null }>(
      session.client,
      'deploy_status',
      { host_alias: 'prod', app: 'acme' },
    );
    expect(status.structured.live?.commit).toBe('c1111111');
    await session.close();
  }, 30_000);

  it('explains a sudo password prompt instead of hanging', async () => {
    const srv = server({ FAKE_SUDO_PASSWORD: '1' });
    const session = await connect(srv.config);
    const r = await call(session.client, 'deploy_logs', { host_alias: 'prod', app: 'acme' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never types one/);
    await session.close();
  });

  it('explains a missing release manager', async () => {
    const srv = server();
    const session = await connect(srv.config);
    const r = await call(session.client, 'deploy_status', { host_alias: 'prod', app: 'other' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/There is no release manager at \/usr\/local\/bin\/other-deploy/);
    await session.close();
  });

  it('explains an unknown host key, and never retries without checking it', async () => {
    const state = path.join(scratch, `hk-${++n}`);
    const config = testConfig({
      sshBin: FAKE_SSH,
      allowedHosts: ['prod'],
      childEnv: {
        PATH: process.env.PATH,
        FAKE_SSH_STATE: state,
        FAKE_SSH_STDERR: 'Host key verification failed.\n',
        FAKE_SSH_EXIT: '255',
      },
    });
    const session = await connect(config);
    const r = await call(session.client, 'deploy_status', { host_alias: 'prod', app: 'acme' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never adds host keys/);
    expect(readDirCount(state)).toBe(1);
    await session.close();
  });

  it('reaches no host unless PLESK_DEPLOY_SSH_HOSTS allows it', async () => {
    const off = server({}, []);
    const s1 = await connect(off.config);
    const r1 = await call(s1.client, 'deploy_status', { host_alias: 'prod', app: 'acme' });
    expect(r1.isError).toBe(true);
    expect(r1.text).toMatch(/server tools are off.*PLESK_DEPLOY_SSH_HOSTS/s);
    await s1.close();

    const other = server({}, ['staging']);
    const s2 = await connect(other.config);
    const r2 = await call(s2.client, 'rollback', {
      host_alias: 'prod',
      app: 'acme',
      confirm: 'acme@prod',
    });
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/not in PLESK_DEPLOY_SSH_HOSTS/);
    await s2.close();
    expect(existsSync(off.state) || existsSync(other.state)).toBe(false);
  });
});

function readDirCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return spawnSync('ls', ['-1', dir], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l.startsWith('call-')).length;
}
