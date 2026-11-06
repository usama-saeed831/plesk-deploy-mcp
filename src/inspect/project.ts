/**
 * Phase 1 of the workflow: read the project and build a Deployment facts
 * table. A fact is "verified" only when it was read in a file (and the file is
 * named as evidence). Absence is never upgraded to a fact: "none found" is
 * reported as "unknown". Env files are read for NAMES only; real .env files
 * are never opened.
 */
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isEnvExampleFile, isRealEnvFile, readSmall, walkProject } from '../lib/fs-safe.js';

export type FactStatus = 'verified' | 'unknown';

export interface Fact {
  fact: string;
  value: string;
  status: FactStatus;
  evidence?: string;
}

export type AppKind =
  | 'nextjs'
  | 'nestjs'
  | 'node-service'
  | 'static-spa'
  | 'laravel'
  | 'php'
  | 'wordpress-theme'
  | 'mobile'
  | 'library';

export interface AppInfo {
  path: string;
  name?: string;
  kind: AppKind;
  frameworks: string[];
  build?: string;
  start?: string;
  migrate?: string;
  /** The generate_deploy_kit stack that fits, when one does. */
  suggested_stack?: 'node' | 'next' | 'static' | 'laravel';
}

export interface ProjectInspection {
  project_dir: string;
  files_scanned: number;
  truncated: boolean;
  facts: Fact[];
  apps: AppInfo[];
  env_names: { build_time: string[]; run_time: string[]; sources: string[] };
  env_files_present: string[];
  ci: { file: string; triggers: string[]; callable: boolean }[];
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  volta?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|php)$/;
const BUILD_TIME_PREFIX =
  /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NG_APP_|VUE_APP_|EXPO_PUBLIC_|GATSBY_)/;
const NATIVE_MODULES = [
  'bcrypt',
  'sharp',
  'argon2',
  'better-sqlite3',
  'sqlite3',
  'canvas',
  'node-sass',
  're2',
];
const QUEUE_DEPS = [
  'ioredis',
  'redis',
  'bull',
  'bullmq',
  '@nestjs/bull',
  '@nestjs/bullmq',
  'agenda',
  'bee-queue',
  'predis/predis',
  'laravel/horizon',
];
const DB_DEPS: [string, string][] = [
  ['pg', 'PostgreSQL'],
  ['postgres', 'PostgreSQL'],
  ['mysql2', 'MySQL/MariaDB'],
  ['mysql', 'MySQL/MariaDB'],
  ['mariadb', 'MySQL/MariaDB'],
  ['better-sqlite3', 'SQLite'],
  ['sqlite3', 'SQLite'],
  ['mongoose', 'MongoDB'],
  ['mongodb', 'MongoDB'],
];
const ORM_DEPS = [
  'typeorm',
  '@prisma/client',
  'prisma',
  'sequelize',
  'knex',
  'drizzle-orm',
  'mikro-orm',
];

const ENV_IN_CODE = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\$_ENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];
const HEALTH_ROUTE =
  /['"`](\/?(?:api\/)?(?:v\d+\/)?(?:health(?:z|check)?(?:\/(?:ready|live))?|readyz|livez|up|version(?:\.json)?))['"`]/g;
const SCHEDULER =
  /@Cron\(|node-cron|cron\.schedule\(|new CronJob\(|\$schedule->|schedule:run|agenda\.every\(/;
const SYNCHRONIZE = /synchronize\s*:\s*true/;

const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
const list = (xs: string[], max = 12) =>
  xs.length === 0
    ? ''
    : xs.slice(0, max).join(', ') + (xs.length > max ? `, … (${xs.length - max} more)` : '');
const dirOf = (rel: string) => (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
const at = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);

function parseJson<T>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function deps(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

function classify(pkg: PackageJson, nextOutput?: string): { kind: AppKind; frameworks: string[] } {
  const d = deps(pkg);
  const has = (n: string) => n in d;
  const frameworks: string[] = [];
  if (has('next')) frameworks.push('Next.js');
  if (has('@nestjs/core')) frameworks.push('NestJS');
  if (has('express')) frameworks.push('Express');
  if (has('fastify')) frameworks.push('Fastify');
  if (has('koa')) frameworks.push('Koa');
  if (has('vite')) frameworks.push('Vite');
  if (has('react-scripts')) frameworks.push('Create React App');
  if (has('@angular/core')) frameworks.push('Angular');
  if (has('vue')) frameworks.push('Vue');
  if (has('svelte')) frameworks.push('Svelte');
  if (has('react')) frameworks.push('React');

  let kind: AppKind;
  // A mobile app shares the repository but is never deployed to the server.
  if (['expo', 'react-native'].some(has)) kind = 'mobile';
  else if (has('next')) kind = nextOutput === 'export' ? 'static-spa' : 'nextjs';
  else if (has('@nestjs/core')) kind = 'nestjs';
  else if (['express', 'fastify', 'koa', '@hapi/hapi'].some(has)) kind = 'node-service';
  else if (['vite', 'react-scripts', '@angular/core', '@angular/cli'].some(has))
    kind = 'static-spa';
  else if (pkg.scripts?.start) kind = 'node-service';
  else kind = 'library';
  return { kind, frameworks };
}

const STACK_FOR: Partial<Record<AppKind, AppInfo['suggested_stack']>> = {
  nextjs: 'next',
  nestjs: 'node',
  'node-service': 'node',
  'static-spa': 'static',
  laravel: 'laravel',
};

export async function inspectProject(root: string): Promise<ProjectInspection> {
  const { files, truncated } = await walkProject(root);
  const fileSet = new Set(files);
  const read = (rel: string) => readSmall(root, rel);
  const facts: Fact[] = [];
  const add = (fact: string, value: string, status: FactStatus, evidence?: string) =>
    facts.push(evidence ? { fact, value, status, evidence } : { fact, value, status });

  // ── Manifests ────────────────────────────────────────────────────────────
  const pkgFiles = files.filter((f) => path.posix.basename(f) === 'package.json');
  const packages = new Map<string, PackageJson>();
  for (const f of pkgFiles) {
    const pkg = parseJson<PackageJson>(await read(f));
    if (pkg) packages.set(dirOf(f), pkg);
  }
  const rootPkg = packages.get('');
  const composerFiles = files.filter((f) => path.posix.basename(f) === 'composer.json');
  const composers = new Map<
    string,
    { require?: Record<string, string>; scripts?: Record<string, unknown> }
  >();
  for (const f of composerFiles) {
    const c = parseJson<{ require?: Record<string, string> }>(await read(f));
    if (c) composers.set(dirOf(f), c);
  }

  // ── Package manager and workspaces ───────────────────────────────────────
  const locks = [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'Yarn'],
    ['bun.lockb', 'Bun'],
    ['bun.lock', 'Bun'],
    ['composer.lock', 'Composer'],
  ].filter(([f]) => fileSet.has(f!));
  if (locks.length > 0) {
    add(
      'Package manager',
      locks.map(([f, m]) => `${m} (${f})`).join('; '),
      'verified',
      locks.map(([f]) => f).join(', '),
    );
  } else if (packages.size + composers.size > 0) {
    add('Package manager', 'no lockfile at the root: installs are not reproducible', 'unknown');
  }

  const ws = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : rootPkg?.workspaces?.packages;
  const monorepoFiles = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'].filter((f) =>
    fileSet.has(f),
  );
  if (ws?.length || monorepoFiles.length) {
    add(
      'Monorepo',
      [ws?.length ? `workspaces: ${list(ws)}` : '', ...monorepoFiles].filter(Boolean).join('; '),
      'verified',
      ws?.length ? 'package.json' : monorepoFiles.join(', '),
    );
  }

  // ── Framework configs ────────────────────────────────────────────────────
  const nextOutputs = new Map<string, string>();
  for (const f of files.filter((x) => /(^|\/)next\.config\.(?:js|mjs|cjs|ts)$/.test(x))) {
    const text = (await read(f)) ?? '';
    const output = /output\s*:\s*['"](standalone|export)['"]/.exec(text)?.[1];
    if (output) nextOutputs.set(dirOf(f), output);
    const basePath = /basePath\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
    add(
      'Next.js config',
      `output: ${output ?? 'default (next start)'}${basePath ? `, basePath ${basePath}` : ''}`,
      'verified',
      f,
    );
  }
  for (const f of files.filter((x) => /(^|\/)vite\.config\.(?:js|mjs|cjs|ts|mts)$/.test(x))) {
    const base = /\bbase\s*:\s*['"]([^'"]+)['"]/.exec((await read(f)) ?? '')?.[1];
    add('Vite config', `base: ${base ?? '/ (default)'}`, base ? 'verified' : 'unknown', f);
  }
  for (const f of files.filter((x) => path.posix.basename(x) === 'angular.json')) {
    const json = parseJson<{
      projects?: Record<string, { architect?: { build?: { options?: { outputPath?: unknown } } } }>;
    }>(await read(f));
    const outs = Object.entries(json?.projects ?? {}).map(
      ([name, p]) =>
        `${name} → ${JSON.stringify(p.architect?.build?.options?.outputPath ?? 'dist/' + name)}`,
    );
    if (outs.length) add('Angular build output', list(outs), 'verified', f);
  }

  // ── Apps ─────────────────────────────────────────────────────────────────
  const apps: AppInfo[] = [];
  for (const [dir, pkg] of packages) {
    if (dir === '' && (ws?.length ?? 0) > 0 && !pkg.scripts?.start && !('next' in deps(pkg)))
      continue;
    // Laravel builds its assets with Vite: that package.json belongs to the Laravel app.
    if ('laravel/framework' in (composers.get(dir)?.require ?? {})) continue;
    const { kind, frameworks } = classify(pkg, nextOutputs.get(dir));
    if ((kind === 'library' && dir !== '') || kind === 'mobile') continue;
    const s = pkg.scripts ?? {};
    const migrateKey = Object.keys(s).find(
      (k) => /migrat/i.test(k) && !/revert|create|generate|down|fresh/i.test(k),
    );
    const app: AppInfo = { path: dir || '.', kind, frameworks };
    if (pkg.name) app.name = pkg.name;
    if (s.build) app.build = `npm run build  (${s.build})`;
    const startKey = ['start:prod', 'start'].find((k) => s[k]);
    if (startKey) app.start = `npm run ${startKey}  (${s[startKey]})`;
    if (migrateKey) app.migrate = `npm run ${migrateKey}  (${s[migrateKey]})`;
    const stack = STACK_FOR[kind];
    if (stack) app.suggested_stack = stack;
    apps.push(app);
  }
  for (const [dir, c] of composers) {
    const laravel = 'laravel/framework' in (c.require ?? {});
    const app: AppInfo = {
      path: dir || '.',
      kind: laravel ? 'laravel' : 'php',
      frameworks: laravel ? ['Laravel'] : ['PHP'],
    };
    if (laravel) {
      app.migrate = 'php artisan migrate --force';
      app.suggested_stack = 'laravel';
    }
    apps.push(app);
  }
  for (const f of files.filter((x) => path.posix.basename(x) === 'style.css')) {
    if (/Theme Name\s*:/i.test((await read(f)) ?? '')) {
      apps.push({
        path: dirOf(f) || '.',
        kind: 'wordpress-theme',
        frameworks: ['WordPress theme'],
      });
    }
  }
  if (fileSet.has('wp-config.php') || files.some((f) => f.startsWith('wp-content/'))) {
    add(
      'WordPress',
      'a WordPress install is in this repository: deploy only the theme or plugins you own',
      'verified',
      'wp-content/',
    );
  }
  add(
    'Deployable apps',
    apps.length
      ? apps
          .filter((a) => a.kind !== 'library')
          .map((a) => `${a.path} (${a.frameworks.join(' + ') || a.kind})`)
          .join('; ') || 'none found'
      : 'none found',
    apps.some((a) => a.kind !== 'library') ? 'verified' : 'unknown',
    apps.length ? 'package.json / composer.json' : undefined,
  );
  for (const a of apps.filter((x) => x.kind !== 'library')) {
    if (a.build)
      add(
        `Build (${a.path})`,
        a.build,
        'verified',
        at(a.path === '.' ? '' : a.path, 'package.json'),
      );
    if (a.start)
      add(
        `Start (${a.path})`,
        a.start,
        'verified',
        at(a.path === '.' ? '' : a.path, 'package.json'),
      );
  }

  // ── Runtime pins ─────────────────────────────────────────────────────────
  const nodePins: string[] = [];
  for (const f of ['.nvmrc', '.node-version']) {
    const v = (await read(f))?.trim().split('\n')[0];
    if (v) nodePins.push(`${v} (${f})`);
  }
  const toolVersions = /^nodejs\s+(\S+)/m.exec((await read('.tool-versions')) ?? '')?.[1];
  if (toolVersions) nodePins.push(`${toolVersions} (.tool-versions)`);
  if (rootPkg?.engines?.node) nodePins.push(`${rootPkg.engines.node} (package.json engines)`);
  if (rootPkg?.volta?.node) nodePins.push(`${rootPkg.volta.node} (package.json volta)`);
  if (packages.size > 0) {
    add(
      'Node version pin',
      nodePins.length
        ? nodePins.join('; ')
        : 'none: pin one (.nvmrc) so CI builds for the server’s major',
      nodePins.length ? 'verified' : 'unknown',
      nodePins.length ? nodePins.map((p) => p.replace(/^.*\((.*)\)$/, '$1')).join(', ') : undefined,
    );
  }
  for (const [dir, c] of composers) {
    const php = c.require?.php;
    add(
      'PHP version',
      php ?? 'not pinned in composer.json',
      php ? 'verified' : 'unknown',
      at(dir, 'composer.json'),
    );
  }
  const dockerfiles = files.filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f));
  const froms: string[] = [];
  for (const f of dockerfiles) {
    for (const m of ((await read(f)) ?? '').matchAll(/^FROM\s+(\S+)/gim))
      froms.push(`${m[1]} (${f})`);
  }
  if (dockerfiles.length)
    add(
      'Dockerfiles',
      froms.length ? list(froms) : list(dockerfiles),
      'verified',
      list(dockerfiles, 5),
    );

  // ── Dependencies: database, ORM, queues, native modules ─────────────────
  const allDeps = new Map<string, string[]>();
  for (const [dir, pkg] of packages) {
    for (const name of Object.keys(deps(pkg)))
      allDeps.set(name, [...(allDeps.get(name) ?? []), at(dir, 'package.json')]);
  }
  for (const [dir, c] of composers) {
    for (const name of Object.keys(c.require ?? {}))
      allDeps.set(name, [...(allDeps.get(name) ?? []), at(dir, 'composer.json')]);
  }
  const evidenceFor = (names: string[]) =>
    uniq(names.flatMap((n) => allDeps.get(n) ?? [])).join(', ');

  const dbs = uniq(DB_DEPS.filter(([d]) => allDeps.has(d)).map(([, label]) => label));
  const prismaSchema = files.find((f) => /(^|\/)schema\.prisma$/.test(f));
  if (prismaSchema) {
    const provider =
      /provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/.exec(
        (await read(prismaSchema)) ?? '',
      )?.[1];
    if (provider) dbs.push(`${provider} (Prisma)`);
  }
  const laravelApps = apps.filter((a) => a.kind === 'laravel');
  add(
    'Database',
    dbs.length
      ? uniq(dbs).join(', ')
      : laravelApps.length
        ? 'set by DB_CONNECTION in the server’s .env'
        : 'none found in the dependencies',
    dbs.length ? 'verified' : 'unknown',
    dbs.length ? evidenceFor(DB_DEPS.map(([d]) => d)) || prismaSchema : undefined,
  );
  const orms = ORM_DEPS.filter((d) => allDeps.has(d));
  if (orms.length) add('ORM / query builder', list(orms), 'verified', evidenceFor(orms));

  const migrationDirs = uniq(
    files
      .filter((f) => /(^|\/)migrations\//.test(f))
      .map((f) => f.replace(/(^|\/)migrations\/.*$/, '$1migrations')),
  );
  const migrateScripts = apps.filter((a) => a.migrate).map((a) => `${a.path}: ${a.migrate}`);
  add(
    'Migrations',
    [...migrateScripts, ...migrationDirs.map((d) => `folder ${d}`)].join('; ') || 'none found',
    migrateScripts.length || migrationDirs.length ? 'verified' : 'unknown',
    migrationDirs.length
      ? list(migrationDirs, 5)
      : migrateScripts.length
        ? 'package.json'
        : undefined,
  );

  const seeds = uniq(
    files
      .filter((f) => /(^|\/)(seeders?|seeds?)(\/|\.[cm]?[jt]s$)|(^|\/)seed\.[cm]?[jt]s$/i.test(f))
      .map(dirOf),
  );
  const seedScripts = [...packages.entries()].flatMap(([dir, p]) =>
    Object.entries(p.scripts ?? {})
      .filter(([k]) => /seed/i.test(k))
      .map(([k]) => `${at(dir, 'package.json')} "${k}"`),
  );
  if (seeds.length || seedScripts.length) {
    add(
      'Seeds',
      `${list([...seedScripts, ...seeds.map((s) => s || '.')])}: confirm none runs in production`,
      'verified',
      list([...seeds, ...seedScripts], 5),
    );
  }

  const queues = QUEUE_DEPS.filter((d) => allDeps.has(d));
  if (queues.length) add('Redis / queues', list(queues), 'verified', evidenceFor(queues));
  const native = NATIVE_MODULES.filter((d) => allDeps.has(d));
  add(
    'Native modules',
    native.length
      ? `${list(native)}: the server must run the same Node major as CI`
      : 'none of the common ones',
    native.length ? 'verified' : 'unknown',
    native.length ? evidenceFor(native) : undefined,
  );

  // ── Source scan: env names, health, schedulers, synchronize ──────────────
  const sources = files
    .filter((f) => SOURCE_EXT.test(f) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f))
    .slice(0, 2000);
  const codeEnv = new Set<string>();
  const health = new Map<string, string>();
  const schedulers: string[] = [];
  const synchronize: string[] = [];
  const release: string[] = [];
  for (const f of sources) {
    const text = await readSmall(root, f, 256 * 1024);
    if (!text) continue;
    for (const re of ENV_IN_CODE) for (const m of text.matchAll(re)) codeEnv.add(m[1]!);
    for (const m of text.matchAll(HEALTH_ROUTE)) if (!health.has(m[1]!)) health.set(m[1]!, f);
    if (SCHEDULER.test(text)) schedulers.push(f);
    if (SYNCHRONIZE.test(text)) synchronize.push(f);
    if (/RELEASE_VERSION|version\.json/.test(text)) release.push(f);
  }

  // ── Env names (examples) and env files present (never opened) ───────────
  const exampleEnv = new Set<string>();
  const envSources: string[] = [];
  for (const f of files.filter(isEnvExampleFile)) {
    const text = await read(f);
    if (!text) continue;
    envSources.push(f);
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm))
      exampleEnv.add(m[1]!);
  }
  const allEnv = uniq([...exampleEnv, ...codeEnv]).sort();
  const buildTime = allEnv.filter((n) => BUILD_TIME_PREFIX.test(n));
  const runTime = allEnv.filter((n) => !BUILD_TIME_PREFIX.test(n));
  if (codeEnv.size) envSources.push(`source code (${sources.length} files scanned)`);
  const envFilesPresent = files.filter(isRealEnvFile);
  add(
    'Run-time settings (names)',
    runTime.length ? list(runTime, 40) : 'none found',
    runTime.length ? 'verified' : 'unknown',
    envSources.length ? list(envSources, 5) : undefined,
  );
  add(
    'Build-time settings (names, public)',
    buildTime.length
      ? `${list(buildTime, 40)}: CI repository variables, compiled into the bundle`
      : 'none found',
    buildTime.length ? 'verified' : 'unknown',
    buildTime.length ? list(envSources, 5) : undefined,
  );
  if (envFilesPresent.length) {
    add(
      'Env files present (not opened)',
      `${list(envFilesPresent)}: their values were not read. Production values live on the server`,
      'verified',
    );
  }

  add(
    'Health endpoint',
    health.size
      ? list([...health.keys()])
      : 'none found: add one that checks the database and reports the release',
    health.size ? 'verified' : 'unknown',
    health.size ? list(uniq(health.values()), 5) : undefined,
  );
  add(
    'Reports its release',
    release.length
      ? 'RELEASE_VERSION or version.json is used'
      : 'not found: plan to report the commit (RELEASE_VERSION or version.json)',
    release.length ? 'verified' : 'unknown',
    release.length ? list(release, 5) : undefined,
  );
  if (schedulers.length) {
    add(
      'Scheduled jobs',
      `in ${schedulers.length} file(s): make sure exactly one process runs each`,
      'verified',
      list(schedulers, 5),
    );
  }
  add(
    'Auto-sync of the schema',
    synchronize.length
      ? 'synchronize: true found: it must be off in production'
      : `none found (searched ${sources.length} files)`,
    synchronize.length ? 'verified' : 'unknown',
    synchronize.length ? list(synchronize, 5) : undefined,
  );
  const pushScripts = [...packages.entries()].flatMap(([dir, p]) =>
    Object.entries(p.scripts ?? {})
      .filter(([, v]) => /db push|db:push|migrate:fresh|migrate:reset|schema:sync/.test(v))
      .map(([k]) => `${at(dir, 'package.json')} "${k}"`),
  );
  if (pushScripts.length)
    add(
      'Destructive schema scripts',
      `${list(pushScripts)}: never run against production`,
      'verified',
      list(pushScripts, 5),
    );

  const runtimeDirs = uniq(
    files
      .map((f) => /^(.*?(?:^|\/)(?:uploads|storage\/app|public\/uploads))\//.exec(f)?.[1])
      .filter((d): d is string => !!d),
  );
  const sqlite = files.filter((f) => /\.(sqlite3?|db)$/.test(f));
  if (runtimeDirs.length || sqlite.length || laravelApps.length) {
    add(
      'Files written at run time',
      [
        ...runtimeDirs,
        ...sqlite,
        ...laravelApps.map((a) => at(a.path === '.' ? '' : a.path, 'storage')),
      ].join(', ') + ': keep them in shared/, outside the release',
      'verified',
      list([...runtimeDirs, ...sqlite], 5) || 'composer.json (Laravel)',
    );
  }

  // ── Existing delivery ────────────────────────────────────────────────────
  const ci: ProjectInspection['ci'] = [];
  for (const f of files.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
    let triggers: string[];
    try {
      const doc = parseYaml((await read(f)) ?? '') as { on?: unknown; true?: unknown } | null;
      const on = doc?.on ?? doc?.true; // YAML 1.1 reads a bare `on:` as true
      triggers =
        typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(on ?? {});
    } catch {
      triggers = ['(unparseable)'];
    }
    ci.push({ file: f, triggers, callable: triggers.includes('workflow_call') });
  }
  const otherCi = [
    '.gitlab-ci.yml',
    'bitbucket-pipelines.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    'azure-pipelines.yml',
  ].filter((f) => fileSet.has(f));
  add(
    'Existing CI',
    ci.length || otherCi.length
      ? [
          ...ci.map(
            (c) => `${c.file} (${c.triggers.join(', ')}${c.callable ? '' : '; not callable yet'})`,
          ),
          ...otherCi,
        ].join('; ')
      : 'none: write CI before any deploy (never deploy untested)',
    ci.length || otherCi.length ? 'verified' : 'unknown',
    ci.length || otherCi.length ? list([...ci.map((c) => c.file), ...otherCi], 5) : undefined,
  );
  const deployFiles = files.filter(
    (f) =>
      /(^|\/)(deploy[^/]*\.(sh|bash)|ecosystem\.config\.(js|cjs|json)|Procfile|[^/]+\.service|Makefile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|appspec\.yml)$/.test(
        f,
      ) || f.startsWith('deploy/'),
  );
  if (deployFiles.length) {
    add(
      'Existing deploy files',
      `${list(deployFiles)}: read each before replacing anything, and ask`,
      'verified',
      list(deployFiles, 5),
    );
  }

  // ── The server: never known from the repository ─────────────────────────
  for (const fact of [
    'Process manager on the server (PM2 owner, systemd, Passenger)',
    'Runtime on the server (Node / PHP version and path)',
    'Where the app runs from on the server',
    'Proxy (Additional nginx directives, Node.js extension) and document root',
    'Where the production .env lives',
    'Database on the server (engine, version, exact names)',
    'Other tenants (ports, Redis databases)',
  ]) {
    add(fact, 'unknown until the server is inspected: use server_discovery_commands', 'unknown');
  }

  return {
    project_dir: root,
    files_scanned: files.length,
    truncated,
    facts,
    apps,
    env_names: { build_time: buildTime, run_time: runTime, sources: envSources },
    env_files_present: envFilesPresent,
    ci,
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function factsTable(facts: Fact[]): string {
  const rows = facts.map(
    (f) =>
      `| ${cell(f.fact)} | ${cell(f.value)} | ${f.status}${f.evidence ? `: ${cell(f.evidence)}` : ''} |`,
  );
  return ['| Fact | Value | Source |', '|---|---|---|', ...rows].join('\n');
}
