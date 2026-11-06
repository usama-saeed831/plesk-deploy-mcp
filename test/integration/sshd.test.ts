/**
 * The SSH tools against a real sshd and the real release manager, in Docker.
 * CI only: it needs Docker and writes ~/.ssh/config on the (throwaway) runner,
 * because OpenSSH reads the config from the account's home, not $HOME.
 *
 *   PLESK_IT_SSHD=1 npm run test:integration
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RELEASE_MANAGER_TEMPLATE } from '../../src/kit.js';
import { call, connect } from '../helpers/client.js';

const ENABLED = process.env.PLESK_IT_SSHD === '1';
const IMAGE = 'plesk-deploy-mcp-it';
const PORT = '2222';
const ALIAS = 'it-sshd';
const UNKNOWN = 'it-sshd-unpinned';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

describe.skipIf(!ENABLED)('SSH tools against a real sshd', () => {
  let work: string;
  let container: string;
  let session: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'it-sshd-'));
    const context = path.join(work, 'context');
    mkdirSync(context);
    for (const f of ['Dockerfile', 'deploy.conf', 'seed.sh']) {
      copyFileSync(path.join(import.meta.dirname, 'sshd', f), path.join(context, f));
    }
    copyFileSync(RELEASE_MANAGER_TEMPLATE, path.join(context, 'app-deploy'));
    execFileSync('docker', ['build', '-q', '-t', IMAGE, context], { stdio: 'inherit' });

    const key = path.join(work, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
    container = docker(
      'run',
      '-d',
      '--rm',
      '-p',
      `127.0.0.1:${PORT}:22`,
      '-e',
      `AUTHORIZED_KEY=${publicKey}`,
      IMAGE,
    );

    // Wait for sshd, then pin its host key, as a user would after checking it.
    let known = '';
    for (let i = 0; i < 30 && !known; i++) {
      known = spawnSync('ssh-keyscan', ['-p', PORT, '-t', 'ed25519', '127.0.0.1'], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!known) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(known, 'sshd did not come up').not.toBe('');
    writeFileSync(path.join(work, 'known_hosts'), `${known}\n`);
    writeFileSync(path.join(work, 'empty_known_hosts'), '');

    const sshDir = path.join(homedir(), '.ssh');
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const host = (alias: string, knownHosts: string) =>
      `Host ${alias}\n  HostName 127.0.0.1\n  Port ${PORT}\n  User acme-deploy\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${knownHosts}\n`;
    appendFileSync(
      path.join(sshDir, 'config'),
      `\n${host(ALIAS, path.join(work, 'known_hosts'))}\n${host(UNKNOWN, path.join(work, 'empty_known_hosts'))}`,
    );

    const config = loadConfig({ ...process.env, PLESK_DEPLOY_SSH_HOSTS: `${ALIAS},${UNKNOWN}` });
    session = await connect({ ...config, fetch: () => Promise.reject(new Error('no network')) });
  });

  afterAll(async () => {
    await session?.close();
    if (container) spawnSync('docker', ['rm', '-f', container]);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('deploy_status reads the releases without sudo', async () => {
    const r = await call<{ live: { commit: string } | null; releases: unknown[] }>(
      session.client,
      'deploy_status',
      {
        host_alias: ALIAS,
        app: 'acme',
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.releases).toHaveLength(2);
    expect(r.structured.live?.commit).toBe('c2222222');
  });

  it('deploy_logs reads the root-only log through the single sudo rule', async () => {
    const r = await call<{ lines: string[] }>(session.client, 'deploy_logs', {
      host_alias: ALIAS,
      app: 'acme',
      lines: 20,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.lines.join('\n')).toMatch(/c2222222\) is live/);
  });

  it('server_discover frames real command output over a real session', async () => {
    const r = await call<{ results: { id: string; exit_code: number | null; output: string }[] }>(
      session.client,
      'server_discover',
      {
        host_alias: ALIAS,
        domain: 'example.com',
        app: 'acme',
        sections: ['plesk', 'release'],
      },
    );
    expect(r.isError, r.text).toBe(false);
    const byId = new Map(r.structured.results.map((x) => [x.id, x]));
    expect(byId.get('os')?.output).toMatch(/Debian/);
    expect(byId.get('plesk-version')?.exit_code).not.toBe(0); // no Plesk in the container
    expect(byId.get('release-manager')?.output).toMatch(/\/usr\/local\/bin\/acme-deploy/);
  });

  it('server_discover with sudo is refused for an account without password-less sudo', async () => {
    const r = await call(session.client, 'server_discover', {
      host_alias: ALIAS,
      domain: 'example.com',
      sudo: true,
      sections: ['plesk'],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never types one/);
  });

  it('refuses a host whose key is not pinned', async () => {
    const r = await call(session.client, 'deploy_status', { host_alias: UNKNOWN, app: 'acme' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never adds host keys/);
  });

  it('rollback switches back to the previous release', async () => {
    const r = await call<{
      before: { commit: string } | null;
      after: { commit: string } | null;
      exit_code: number;
    }>(session.client, 'rollback', { host_alias: ALIAS, app: 'acme', confirm: `acme@${ALIAS}` });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.exit_code).toBe(0);
    expect(r.structured.before?.commit).toBe('c2222222');
    expect(r.structured.after?.commit).toBe('c1111111');
  });
});
