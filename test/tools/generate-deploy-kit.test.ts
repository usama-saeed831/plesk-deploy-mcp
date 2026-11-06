import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect } from '../helpers/client.js';
import { NODE_PM2 } from '../helpers/kit-params.js';

type Out = {
  written: boolean;
  files: { path: string; action: string; mode: string; diff: string; diff_base: string }[];
  adapt: { file: string; line: number; text: string }[];
  warnings: string[];
  secrets: { file: string; line: number; kind: string }[];
};

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/projects/monorepo');
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'kit-')));
let n = 0;
function repo({ git = true } = {}): string {
  const dir = path.join(scratch, `repo-${++n}`);
  cpSync(FIXTURE, dir, { recursive: true });
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const listAll = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => !f.startsWith('.git/') && f !== '.git')
    .sort();

let session: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => {
  await session.close();
  rmSync(scratch, { recursive: true, force: true });
});

const generate = (project_dir: string, extra: Record<string, unknown> = {}) =>
  call<Out>(session.client, 'generate_deploy_kit', { ...NODE_PM2, project_dir, ...extra });

describe('generate_deploy_kit', () => {
  it('is annotated as able to overwrite (when told to), idempotent and local', async () => {
    const { tools } = await session.client.listTools();
    expect(tools.find((t) => t.name === 'generate_deploy_kit')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('writes nothing on a dry run, and shows each new file as a diff against its template', async () => {
    const dir = repo();
    const before = listAll(dir);
    const r = await generate(dir);
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.written).toBe(false);
    expect(listAll(dir)).toEqual(before);
    const paths = r.structured.files.map((f) => f.path);
    expect(paths).toEqual([
      '.github/workflows/deploy-plesk.yml',
      'deploy/plesk/build-bundle.sh',
      'deploy/plesk/acme-deploy',
      'deploy/plesk/deploy.conf.example',
      'deploy/plesk/server-setup.sh',
      'deploy/plesk/acme-db-backup',
      'deploy/plesk/ecosystem.config.js',
      'deploy/plesk/README.md',
    ]);
    expect(r.structured.files.every((f) => f.action === 'create')).toBe(true);
    const conf = r.structured.files.find((f) => f.path.endsWith('deploy.conf.example'))!;
    expect(conf.diff_base).toBe('template');
    expect(conf.diff).toContain('+BASE=/var/www/acme-app');
    expect(conf.diff).toContain('-BASE=/var/www/myapp-app');
    expect(r.structured.files.find((f) => f.path.endsWith('acme-deploy'))!.diff).not.toMatch(
      /^[+-][^+-]/m,
    );
    expect(r.text).toMatch(/dry run: nothing written/);
  });

  it('warns about a monorepo bundle and lists what a person still has to adapt', async () => {
    const r = await generate(repo());
    expect(r.structured.warnings.join('\n')).toMatch(/monorepo/);
    expect(r.structured.adapt.some((a) => a.file === 'deploy/plesk/build-bundle.sh')).toBe(true);
    expect(r.structured.secrets).toEqual([]);
  });

  it('writes the kit with the right modes when asked, and a second run changes nothing', async () => {
    const dir = repo();
    const r = await generate(dir, { write: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.written).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, 'deploy/plesk/acme-deploy')).mode & 0o777).toBe(0o755);
      expect(statSync(path.join(dir, 'deploy/plesk/deploy.conf.example')).mode & 0o777).toBe(0o644);
    }
    expect(readFileSync(path.join(dir, 'deploy/plesk/deploy.conf.example'), 'utf8')).toMatch(
      /^BASE=\/var\/www\/acme-app$/m,
    );
    expect(listAll(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    const again = await generate(dir, { write: true });
    expect(again.structured.files.every((f) => f.action === 'unchanged')).toBe(true);
  });

  it('never replaces an existing file unless it is listed in overwrite', async () => {
    const dir = repo();
    mkdirSync(path.join(dir, 'deploy/plesk'), { recursive: true });
    writeFileSync(path.join(dir, 'deploy/plesk/README.md'), '# Our own notes\n');
    const plan = await generate(dir);
    const readme = plan.structured.files.find((f) => f.path === 'deploy/plesk/README.md')!;
    expect(readme.action).toBe('blocked-exists');
    expect(readme.diff_base).toBe('existing');
    expect(readme.diff).toContain('-# Our own notes');

    const refused = await generate(dir, { write: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Nothing was written.*deploy\/plesk\/README\.md/s);
    expect(existsSync(path.join(dir, 'deploy/plesk/acme-deploy'))).toBe(false);
    expect(readFileSync(path.join(dir, 'deploy/plesk/README.md'), 'utf8')).toBe(
      '# Our own notes\n',
    );

    const skipped = await generate(dir, { write: true, parts: ['release-manager', 'deploy-conf'] });
    expect(skipped.structured.written).toBe(true);
    expect(readFileSync(path.join(dir, 'deploy/plesk/README.md'), 'utf8')).toBe(
      '# Our own notes\n',
    );

    const replaced = await generate(dir, { write: true, overwrite: ['deploy/plesk/README.md'] });
    expect(replaced.isError, replaced.text).toBe(false);
    expect(readFileSync(path.join(dir, 'deploy/plesk/README.md'), 'utf8')).toMatch(
      /^# Deploying acme to Plesk/,
    );
  });

  it.skipIf(process.platform === 'win32')('refuses to write through a symlink', async () => {
    const dir = repo();
    const outside = path.join(scratch, `outside-${n}`);
    mkdirSync(outside);
    symlinkSync(outside, path.join(dir, 'deploy'));
    const r = await generate(dir, { write: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Nothing was written/);
    expect(readdirSync(outside)).toEqual([]);
    const plan = await generate(dir);
    expect(
      plan.structured.files
        .filter((f) => f.path.startsWith('deploy/'))
        .every((f) => f.action === 'blocked-symlink'),
    ).toBe(true);
  });

  it('writes only into the root of a git repository', async () => {
    const notGit = repo({ git: false });
    const r = await generate(notGit, { write: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a git repository/);
    expect(existsSync(path.join(notGit, 'deploy'))).toBe(false);

    const sub = path.join(repo(), 'api');
    const s = await generate(sub, { write: true });
    expect(s.isError).toBe(true);
    expect(s.text).toMatch(/must be the repository root/);
  });

  it('refuses to write a kit with something that looks like a secret in it', async () => {
    const dir = repo();
    const r = await generate(dir, {
      write: true,
      migrate_cmd: 'DB_PASSWORD=hunter2 npm run migration:run',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/look like secrets/);
    expect(r.text).not.toContain('hunter2');
    expect(existsSync(path.join(dir, 'deploy'))).toBe(false);
  });

  it('checks the arguments that depend on each other', async () => {
    const r = await session.client
      .callTool({
        name: 'generate_deploy_kit',
        arguments: { ...NODE_PM2, project_dir: repo(), pm2_apps: [] },
      })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/pm2_apps is required/);
  });

  it('rejects unsafe values before rendering anything', async () => {
    for (const bad of [
      { app: 'acme; rm -rf /' },
      { site_url: 'http://example.com/' },
      { base_dir: '/var/www/../etc' },
      { pm2_apps: [{ name: 'x', dir: '.', script: 'a.js', args: "start'; id'" }] },
      { build_time_vars: ['lower_case'] },
      { overwrite: ['../outside.txt'] },
    ]) {
      const r = await session.client
        .callTool({
          name: 'generate_deploy_kit',
          arguments: { ...NODE_PM2, project_dir: repo(), ...bad },
        })
        .catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('warns when the CI it would call is missing', async () => {
    const dir = repo();
    rmSync(path.join(dir, '.github'), { recursive: true });
    const r = await generate(dir);
    expect(r.structured.warnings.join('\n')).toMatch(
      /There is no \.github\/workflows\/ci\.yml.*never deploy untested/,
    );
  });

  it('warns when the CI is callable but lacks the inputs the deploy passes', async () => {
    const r = await generate(repo());
    expect(r.structured.warnings.join('\n')).toMatch(/lacks the ref and skip_build inputs/);
  });
});
