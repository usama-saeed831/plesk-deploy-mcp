import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/lib/exec.js';
import { minimalEnv } from '../../src/lib/exec.js';
import {
  SSH_OPTIONS,
  type SshContext,
  SshNotAllowedError,
  assertHostAllowed,
  buildSshArgs,
  explainSshFailure,
  runRemote,
} from '../../src/lib/ssh.js';

const FAKE_SSH = path.resolve(import.meta.dirname, '../fixtures/bin/ssh');

let state: string;
beforeEach(() => {
  state = mkdtempSync(path.join(tmpdir(), 'fake-ssh-'));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

function ctx(extra: Record<string, string> = {}, allowedHosts = ['prod']): SshContext {
  const env = {
    ...minimalEnv({ ...process.env, PLESK_DEPLOY_GITHUB_TOKEN: 'must-not-leak' }),
    FAKE_SSH_STATE: state,
    ...extra,
  };
  return { sshBin: FAKE_SSH, allowedHosts, env };
}

const call = (n = 1) => ({
  argv: readFileSync(path.join(state, `call-${n}`, 'argv'), 'utf8')
    .split('\0')
    .slice(0, -1),
  stdin: readFileSync(path.join(state, `call-${n}`, 'stdin'), 'utf8'),
  env: readFileSync(path.join(state, `call-${n}`, 'env'), 'utf8'),
});

describe('host allowlist', () => {
  it('refuses everything while PLESK_DEPLOY_SSH_HOSTS is empty, and says how to enable it', () => {
    expect(() => assertHostAllowed(ctx({}, []), 'prod')).toThrow(/PLESK_DEPLOY_SSH_HOSTS/);
  });
  it('refuses aliases that are not listed', () => {
    expect(() => assertHostAllowed(ctx(), 'staging')).toThrow(SshNotAllowedError);
  });
  it('refuses malformed aliases even if someone listed them', () => {
    expect(() => assertHostAllowed(ctx({}, ['-oProxyCommand=id']), '-oProxyCommand=id')).toThrow(
      /not a valid/,
    );
  });
});

describe('buildSshArgs', () => {
  it('puts the fixed options first, then "--", the alias and one quoted command', () => {
    const args = buildSshArgs('prod', ['sudo', '-n', '/usr/local/bin/myapp-deploy', '--rollback']);
    expect(args.slice(0, SSH_OPTIONS.length)).toEqual(SSH_OPTIONS);
    expect(args.slice(SSH_OPTIONS.length)).toEqual([
      '--',
      'prod',
      'sudo -n /usr/local/bin/myapp-deploy --rollback',
    ]);
    expect(SSH_OPTIONS).toEqual(
      expect.arrayContaining(['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ForwardAgent=no']),
    );
  });
});

describe.skipIf(process.platform === 'win32')('runRemote with the fake ssh', () => {
  it('sends exactly the built argv and the stdin, and never the GitHub token', async () => {
    const r = await runRemote(ctx({ FAKE_SSH_STDOUT: 'hello' }), 'prod', ['sh', '-s'], {
      timeoutMs: 10_000,
      input: 'echo hi\n',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello');
    const c = call();
    expect(c.argv).toEqual(buildSshArgs('prod', ['sh', '-s']));
    expect(c.stdin).toBe('echo hi\n');
    expect(c.env).not.toContain('must-not-leak');
    expect(c.env).not.toMatch(/GITHUB_TOKEN/);
  });

  it('quotes a hostile value so the remote shell sees one word', async () => {
    const hostile = "x'; reboot; echo '";
    await runRemote(ctx(), 'prod', ['tail', '-n', '5', '--', hostile], { timeoutMs: 10_000 });
    const remote = call().argv.at(-1)!;
    const parsed = spawnSync(
      '/bin/sh',
      [
        '-c',
        `${process.execPath} -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' ${remote}`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(parsed.stdout)).toEqual(['tail', '-n', '5', '--', hostile]);
  });

  it('does not start ssh at all for an alias that is not allowed', async () => {
    await expect(runRemote(ctx(), 'other', ['true'], { timeoutMs: 5000 })).rejects.toThrow(
      SshNotAllowedError,
    );
    expect(() => readFileSync(path.join(state, 'call-1', 'argv'))).toThrow();
  });

  it('times out and kills a hung connection', async () => {
    const r = await runRemote(ctx({ FAKE_SSH_SLEEP: '30' }), 'prod', ['true'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
});

describe('explainSshFailure', () => {
  const result = (stderr: string, code = 255): RunResult => ({
    code,
    signal: null,
    stdout: '',
    stderr,
    timedOut: false,
    aborted: false,
    stillRunning: false,
    truncated: false,
    durationMs: 1,
  });

  it.each([
    ['Host key verification failed.', /fingerprint/],
    [
      'No ED25519 host key is known for prod and you have requested strict checking.',
      /known_hosts/,
    ],
    ['user@1.2.3.4: Permission denied (publickey).', /ssh-agent/],
    ['ssh: Could not resolve hostname prod: nodename nor servname provided', /~\/\.ssh\/config/],
    ['ssh: connect to host 1.2.3.4 port 22: Operation timed out', /firewall/],
    ['sudo: a password is required', /never types one/],
  ])('%s', (stderr, expected) => {
    expect(explainSshFailure(result(stderr), 'prod')).toMatch(expected);
  });

  it('says when ssh itself is missing', () => {
    expect(explainSshFailure({ ...result(''), startError: 'ssh was not found' }, 'prod')).toMatch(
      /PLESK_DEPLOY_SSH_BIN/,
    );
  });

  it('stays quiet for an ordinary non-zero exit from the remote command', () => {
    expect(explainSshFailure(result('grep: no match', 1), 'prod')).toBeUndefined();
  });
});
