import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { minimalEnv, run } from '../../src/lib/exec.js';

const NODE = process.execPath;
const env = { PATH: process.env.PATH ?? '' };
const scratch = mkdtempSync(path.join(tmpdir(), 'exec-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('run', () => {
  it('returns exit code and output, with stdin delivered', async () => {
    const r = await run(
      NODE,
      [
        '-e',
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("got:"+s);process.stderr.write("e");process.exit(3)})',
      ],
      { env, input: 'hello', timeoutMs: 10_000 },
    );
    expect(r).toMatchObject({
      code: 3,
      stdout: 'got:hello',
      stderr: 'e',
      timedOut: false,
      stillRunning: false,
    });
  });

  it('passes arguments verbatim, with no shell in between', async () => {
    const tricky = ['$(id)', '; rm -rf /', "a'b", 'a b'];
    const r = await run(
      NODE,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
      {
        env,
        timeoutMs: 10_000,
      },
    );
    expect(JSON.parse(r.stdout)).toEqual(tricky);
  });

  it('kills a process that runs past its timeout', async () => {
    const r = await run(NODE, ['-e', 'setTimeout(()=>{}, 60000)'], { env, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stillRunning).toBe(false);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('leaves the process running when asked to detach, and it finishes on its own', async () => {
    const marker = path.join(scratch, 'finished');
    const r = await run(
      NODE,
      ['-e', `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"y"), 800)`],
      { env, timeoutMs: 100, detachOnTimeout: true },
    );
    expect(r).toMatchObject({ timedOut: true, stillRunning: true, code: null });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(true);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await run(NODE, ['-e', 'setTimeout(()=>{}, 60000)'], {
      env,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.code).toBeNull();
  });

  it('caps output and says it did', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("x".repeat(300000))'], {
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
    });
    expect(r.stdout).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect(r.code).toBe(0);
  });

  it('reports a program that does not exist', async () => {
    const r = await run('definitely-not-a-program-xyz', [], { env, timeoutMs: 5000 });
    expect(r.startError).toMatch(/not found/);
    expect(r.code).toBeNull();
  });

  it('gives the child only the environment it is handed', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: { ...env, ONLY_THIS: '1' },
      timeoutMs: 10_000,
    });
    const seen = JSON.parse(r.stdout) as Record<string, string>;
    expect(seen.ONLY_THIS).toBe('1');
    expect(Object.keys(seen)).not.toContain('HOME');
  });
});

describe('minimalEnv', () => {
  it('keeps what ssh needs and drops tokens', () => {
    const out = minimalEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      PLESK_DEPLOY_GITHUB_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      NPM_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/me', SSH_AUTH_SOCK: '/tmp/agent.sock' });
  });
});
