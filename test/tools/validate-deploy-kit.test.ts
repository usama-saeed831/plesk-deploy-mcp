import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect } from '../helpers/client.js';
import { NODE_PM2 } from '../helpers/kit-params.js';

type Out = {
  ok: boolean;
  app?: string;
  checks: { id: string; status: string; details: string[] }[];
};

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/projects/monorepo');
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'validate-')));
const posix = process.platform !== 'win32';
let n = 0;

let session: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => {
  await session.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh repository with a generated kit. */
async function kit(): Promise<string> {
  const dir = path.join(scratch, `repo-${++n}`);
  cpSync(FIXTURE, dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = await call(session.client, 'generate_deploy_kit', {
    ...NODE_PM2,
    project_dir: dir,
    write: true,
  });
  expect(r.isError, r.text).toBe(false);
  return dir;
}
const edit = (dir: string, file: string, change: (s: string) => string) => {
  const p = path.join(dir, file);
  writeFileSync(p, change(readFileSync(p, 'utf8')));
};
const validate = (dir: string, tests = false) =>
  call<Out>(session.client, 'validate_deploy_kit', {
    project_dir: dir,
    run_release_manager_tests: tests,
  });
const status = (r: Out, id: string) => r.checks.find((c) => c.id === id)?.status;

describe('validate_deploy_kit', () => {
  it('is read-only', async () => {
    const { tools } = await session.client.listTools();
    expect(tools.find((t) => t.name === 'validate_deploy_kit')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it.skipIf(!posix)(
    'passes a freshly generated kit, including the release manager suite',
    async () => {
      const r = await validate(await kit(), true);
      expect(r.isError, r.text).toBe(false);
      expect(r.structured.app).toBe('acme');
      const failed = r.structured.checks.filter((c) => c.status === 'fail');
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(r.structured.ok).toBe(true);
      const suite = r.structured.checks.find((c) => c.id === 'release-manager-tests')!;
      expect(suite.status).toBe('pass');
      expect(suite.details[0]).toMatch(/^\d+ passed, 0 failed\.$/);
      expect(Number(/^(\d+)/.exec(suite.details[0]!)![1])).toBeGreaterThanOrEqual(51);
      expect(status(r.structured, 'fill-in')).toBe('warn'); // PM2_HOME wasn't given
    },
    200_000,
  );

  it('fails when the workflow would accept any host key', async () => {
    const dir = await kit();
    edit(dir, '.github/workflows/deploy-plesk.yml', (s) =>
      s.replace(/StrictHostKeyChecking=yes/g, 'StrictHostKeyChecking=no'),
    );
    const r = await validate(dir);
    expect(status(r.structured, 'workflow-safety')).toBe('fail');
    expect(r.structured.ok).toBe(false);
  });

  it('fails when migrations would run without a backup first', async () => {
    const dir = await kit();
    edit(dir, 'deploy/plesk/deploy.conf.example', (s) =>
      s.replace(/^PRE_MIGRATE_CMD=.*$/m, 'PRE_MIGRATE_CMD='),
    );
    expect(status((await validate(dir)).structured, 'backup-before-migrate')).toBe('fail');
  });

  it('fails when a safety check was removed from the release manager', async () => {
    const dir = await kit();
    edit(dir, 'deploy/plesk/acme-deploy', (s) => s.replace(/flock/g, 'true'));
    const r = await validate(dir);
    const check = r.structured.checks.find((c) => c.id === 'release-manager-safety')!;
    expect(check.status).toBe('fail');
    expect(check.details.join(' ')).toMatch(/one deploy at a time/);
  });

  it.skipIf(!posix)('fails on a shell syntax error', async () => {
    const dir = await kit();
    edit(dir, 'deploy/plesk/build-bundle.sh', (s) => `${s}\nif then\n`);
    const check = (await validate(dir)).structured.checks.find((c) => c.id === 'bash-syntax')!;
    expect(check.status).toBe('fail');
    expect(check.details[0]).toMatch(/^build-bundle\.sh: /);
  });

  it('fails on a workflow that is not valid YAML', async () => {
    const dir = await kit();
    edit(dir, '.github/workflows/deploy-plesk.yml', (s) => `jobs: [\n${s}`);
    expect(status((await validate(dir)).structured, 'workflow-yaml')).toBe('fail');
  });

  it('finds secrets and env files in the kit without echoing them', async () => {
    const dir = await kit();
    writeFileSync(path.join(dir, 'deploy/plesk/.env'), 'X=1\n');
    edit(
      dir,
      'deploy/plesk/README.md',
      (s) =>
        `${s}\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretbody\n-----END OPENSSH PRIVATE KEY-----\n`,
    );
    const r = await validate(dir);
    const check = r.structured.checks.find((c) => c.id === 'secrets')!;
    expect(check.status).toBe('fail');
    expect(check.details.join('\n')).toMatch(/deploy\/plesk\/\.env: an env file/);
    expect(check.details.join('\n')).toMatch(/README\.md:\d+: looks like a private-key/);
    expect(JSON.stringify(r.raw)).not.toContain('AAAAsecretbody');
  });

  it.skipIf(!posix)(
    'fails when the release manager no longer passes its suite',
    async () => {
      const dir = await kit();
      edit(dir, 'deploy/plesk/acme-deploy', (s) =>
        s.replace('set -Eeuo pipefail\n', 'set -Eeuo pipefail\nexit 1\n'),
      );
      const check = (await validate(dir, true)).structured.checks.find(
        (c) => c.id === 'release-manager-tests',
      )!;
      expect(check.status).toBe('fail');
      expect(check.details[0]).toMatch(/passed, [1-9]\d* failed\./);
    },
    200_000,
  );

  it('says so when there is no kit', async () => {
    const dir = path.join(scratch, `empty-${++n}`);
    cpSync(FIXTURE, dir, { recursive: true });
    const r = await validate(dir);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/There is no deploy\/plesk/);
  });
});
