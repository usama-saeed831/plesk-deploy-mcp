import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { kitPath } from '../../src/kit.js';
import { type KitParams, type RenderedFile, adaptPoints, renderKit } from '../../src/kit/render.js';
import { findSecrets } from '../../src/lib/secrets.js';
import { params } from '../helpers/kit-params.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'render-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const posix = process.platform !== 'win32';

const byPath = (files: RenderedFile[], p: string) => {
  const f = files.find((x) => x.path === p);
  if (!f) throw new Error(`${p} was not rendered: ${files.map((x) => x.path).join(', ')}`);
  return f.content;
};

const STACKS: [string, Partial<KitParams>][] = [
  ['node + pm2 + postgres', { database: 'postgres' }],
  [
    'next + pm2',
    {
      stack: 'next',
      pm2_apps: [{ name: 'acme-web', dir: '.', script: 'node_modules/next/dist/bin/next', args: 'start -p 3000' }],
    },
  ],
  ['static + nginx spa', { stack: 'static', process_manager: 'none', pm2_apps: undefined, nginx: 'spa', static_dir: 'build' }],
  [
    'laravel + php-fpm + mysql',
    {
      stack: 'laravel',
      process_manager: 'php-fpm',
      pm2_apps: undefined,
      php_fpm_service: 'plesk-php83-fpm',
      php_version: '8.3',
      database: 'mysql',
      migrate_cmd: '/opt/plesk/php/8.3/bin/php artisan migrate --force',
      post_switch_cmd: '/opt/plesk/php/8.3/bin/php artisan config:cache',
    },
  ],
  [
    'node + systemd + nginx proxy',
    {
      process_manager: 'systemd',
      pm2_apps: undefined,
      systemd_units: [{ name: 'acme-api', dir: 'api', script: 'dist/main.js' }],
      nginx: 'proxy',
      proxy_port: 3001,
    },
  ],
];

describe.each(STACKS)('renderKit: %s', (_name, overrides) => {
  const p = params(overrides);
  const files = renderKit(p);

  it('replaces every template marker and example name', () => {
    for (const f of files) {
      expect(f.content, f.path).not.toMatch(/TEMPLATE —|TEMPLATE for|TEMPLATE:/);
      expect(f.content, f.path).not.toMatch(/myapp/);
    }
  });

  it('produces a workflow that parses and carries the values', () => {
    const wf = parseYaml(byPath(files, '.github/workflows/deploy-plesk.yml')) as {
      on: { push: { branches: string[] } };
      jobs: { test: { uses: string }; deploy: { environment: { url: string }; env: Record<string, string> } };
    };
    expect(wf.on.push.branches).toEqual([p.branch]);
    expect(wf.jobs.test.uses).toBe(`./.github/workflows/${p.ci_workflow}`);
    expect(wf.jobs.deploy.environment.url).toBe(p.site_url);
    expect(wf.jobs.deploy.env.RELEASE_MANAGER).toBe(`/usr/local/bin/${p.app}-deploy`);
    expect(wf.jobs.deploy.env.PUBLIC_HEALTH_URL).toBe(p.public_health_url);
  });

  it.skipIf(!posix)('produces shell scripts that bash can parse', () => {
    for (const f of files.filter((x) => x.mode === 0o755)) {
      const file = path.join(scratch, path.basename(f.path));
      writeFileSync(file, f.content);
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(r.status, `${f.path}: ${r.stderr}`).toBe(0);
    }
  });

  it.skipIf(!posix)('produces a deploy.conf that bash sources to the given values', () => {
    const conf = path.join(scratch, 'deploy.conf');
    writeFileSync(conf, byPath(files, 'deploy/plesk/deploy.conf.example'));
    const r = spawnSync(
      'bash',
      ['-c', 'set -eu; . "$1"; printf "%s\\n" "$BASE" "$PROCESS_MANAGER" "$HEALTH_CHECKS" "$APP_USER" "${MIGRATE_CMD:-}" "${DB_ENGINE:-}"', '_', conf],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const [base, pm, checks, user, migrate, engine] = r.stdout.split('\n');
    expect(base).toBe(p.base_dir);
    expect(pm).toBe(p.process_manager);
    expect(checks).toBe(p.health_checks.map((h) => (h.contains ? `${h.url}|${h.contains}` : h.url)).join(' '));
    expect(user).toBe(p.app_user ?? '');
    expect(migrate).toBe(p.migrate_cmd ?? '');
    expect(engine).toBe(p.database === 'none' ? '' : p.database);
  });

  it('copies the release manager unchanged', () => {
    expect(byPath(files, `deploy/plesk/${p.app}-deploy`)).toBe(
      readFileSync(kitPath('templates', 'server', 'app-deploy'), 'utf8'),
    );
  });

  it('contains nothing that looks like a secret', () => {
    expect(files.flatMap((f) => findSecrets(f.path, f.content))).toEqual([]);
  });
});

describe('renderKit details', () => {
  it('writes the build-time variables into the workflow check, its env and build-bundle.sh', () => {
    const files = renderKit(params({ build_time_vars: ['NEXT_PUBLIC_API_URL', 'CSP_MODE'] }));
    const wf = byPath(files, '.github/workflows/deploy-plesk.yml');
    expect(wf).toContain('[ -n "${{ vars.CSP_MODE }}" ] || missing="$missing CSP_MODE"');
    expect(wf).toContain('          NEXT_PUBLIC_API_URL: ${{ vars.NEXT_PUBLIC_API_URL }}');
    expect(byPath(files, 'deploy/plesk/build-bundle.sh')).toContain(
      ': "${CSP_MODE:?Set the repository variable CSP_MODE}"',
    );
  });

  it('drops the build-settings step when there are no build-time values', () => {
    const wf = byPath(renderKit(params({ build_time_vars: [] })), '.github/workflows/deploy-plesk.yml');
    expect(wf).not.toContain('The build settings are in place');
    expect(wf).not.toContain('PUBLIC_API_URL');
  });

  it('builds the not-deployed filter from the given paths', () => {
    const wf = byPath(renderKit(params({ not_deployed_paths: ['docs/', 'mobile/', 'design.v2/'] })), '.github/workflows/deploy-plesk.yml');
    expect(wf).toContain("grep -vqE '^(docs/|mobile/|design\\.v2/)|\\.md$'");
  });

  it('leaves unknown values empty and marked FILL IN, never guessed', () => {
    const files = renderKit(params({ app_user: undefined, app_group: undefined, node_bin_dir: undefined }));
    const conf = byPath(files, 'deploy/plesk/deploy.conf.example');
    expect(conf).toMatch(/^APP_USER= +# FILL IN/m);
    expect(conf).toMatch(/^NODE_BIN_DIR= +# FILL IN/m);
    const points = adaptPoints(files).filter((a) => a.file.endsWith('deploy.conf.example'));
    expect(points.map((a) => a.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^APP_USER=/)]));
  });

  it('puts the runtime names, without values, into the placeholder env file', () => {
    const setup = byPath(renderKit(params()), 'deploy/plesk/server-setup.sh');
    expect(setup).toContain("'NODE_ENV=production' 'PORT=' 'DATABASE_URL=' 'JWT_SECRET=' > \"$ENV_FILE\"");
    expect(setup).toMatch(/^APP_NAME=acme$/m);
  });

  it('generates PM2 apps that load in Node', () => {
    const eco = byPath(
      renderKit(params({ pm2_apps: [{ name: 'acme-api', dir: 'api', script: 'dist/main.js' }, { name: 'acme-web', dir: 'web', script: 'node_modules/next/dist/bin/next', args: 'start -p 3000' }] })),
      'deploy/plesk/ecosystem.config.js',
    );
    const file = path.join(scratch, 'ecosystem.config.cjs');
    writeFileSync(file, eco);
    const r = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(file)});console.log(JSON.stringify(c.apps.map(a=>[a.name,a.cwd.endsWith(a.name.split('-')[1]),a.script,a.args||''])))`], {
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      ['acme-api', true, 'dist/main.js', ''],
      ['acme-web', true, 'node_modules/next/dist/bin/next', 'start -p 3000'],
    ]);
  });

  it('only renders the parts asked for', () => {
    expect(renderKit(params({ parts: ['deploy-conf', 'readme'] })).map((f) => f.path)).toEqual([
      'deploy/plesk/deploy.conf.example',
      'deploy/plesk/README.md',
    ]);
  });

  it('uses PHP on the runner for Laravel', () => {
    const wf = byPath(renderKit(params({ stack: 'laravel', process_manager: 'php-fpm', php_fpm_service: 'plesk-php83-fpm', php_version: '8.2', pm2_apps: undefined })), '.github/workflows/deploy-plesk.yml');
    expect(wf).toContain('shivammathur/setup-php@v2');
    expect(wf).toContain("php-version: '8.2'");
  });
});
