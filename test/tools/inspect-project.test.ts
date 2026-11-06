import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectInspection } from '../../src/inspect/project.js';
import { call, connect, testConfig } from '../helpers/client.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/projects');
const project = (name: string) => path.join(FIXTURES, name);

let session: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => session.close());

const inspect = (name: string) =>
  call<ProjectInspection>(session.client, 'inspect_project', { project_dir: project(name) });
const fact = (r: ProjectInspection, name: string) => r.facts.find((f) => f.fact === name);

describe('inspect_project', () => {
  it('is read-only, idempotent and closed-world', async () => {
    const { tools } = await session.client.listTools();
    const tool = tools.find((t) => t.name === 'inspect_project');
    expect(tool?.annotations).toMatchObject({
      title: expect.any(String),
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.outputSchema).toBeDefined();
  });

  describe('a NestJS + Next.js monorepo', () => {
    let r: ProjectInspection;
    let text: string;
    let raw: unknown;
    beforeAll(async () => {
      const result = await inspect('monorepo');
      expect(result.isError, result.text).toBe(false);
      r = result.structured;
      text = result.text;
      raw = result.raw;
    });

    it('finds the deployable apps, leaving the mobile app out', () => {
      const apps = r.apps.map((a) => [a.path, a.kind, a.suggested_stack]);
      expect(apps).toContainEqual(['api', 'nestjs', 'node']);
      expect(apps).toContainEqual(['web', 'nextjs', 'next']);
      expect(r.apps.some((a) => a.path === 'mobile')).toBe(false);
      expect(r.apps.find((a) => a.path === 'api')?.migrate).toMatch(/migration:run/);
    });

    it('marks facts it read as verified, with their source', () => {
      expect(fact(r, 'Monorepo')).toMatchObject({ status: 'verified', evidence: 'package.json' });
      expect(fact(r, 'Node version pin')).toMatchObject({
        status: 'verified',
        value: expect.stringContaining('24 (.nvmrc)'),
      });
      expect(fact(r, 'Database')).toMatchObject({ status: 'verified', value: 'PostgreSQL' });
      expect(fact(r, 'Native modules')?.value).toMatch(/bcrypt/);
      expect(fact(r, 'Redis / queues')?.value).toMatch(/ioredis/);
      expect(fact(r, 'Scheduled jobs')?.status).toBe('verified');
      expect(fact(r, 'Health endpoint')?.status).toBe('verified');
      expect(fact(r, 'Reports its release')?.status).toBe('verified');
      expect(fact(r, 'Next.js config')?.value).toMatch(/standalone/);
      expect(fact(r, 'Dockerfiles')?.value).toMatch(/node:24-alpine/);
      expect(fact(r, 'Files written at run time')?.value).toMatch(/api\/uploads/);
    });

    it('never upgrades an absence to a fact', () => {
      expect(fact(r, 'Auto-sync of the schema')).toMatchObject({
        status: 'unknown',
        value: expect.stringMatching(/^none found/),
      });
      const server = r.facts.filter((f) =>
        /on the server|Proxy|Other tenants|production \.env/.test(f.fact),
      );
      expect(server.length).toBeGreaterThanOrEqual(6);
      expect(server.every((f) => f.status === 'unknown')).toBe(true);
    });

    it('splits env names into build-time and run-time', () => {
      expect(r.env_names.build_time).toEqual(['NEXT_PUBLIC_API_URL']);
      expect(r.env_names.run_time).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'JWT_SECRET', 'PORT', 'RELEASE_VERSION']),
      );
    });

    it('reports the real .env as present without reading it', () => {
      expect(r.env_files_present).toEqual(['api/.env']);
      const everything = JSON.stringify(raw);
      expect(everything).not.toContain('canary-7f3a9e');
      expect(everything).not.toContain('NAME_ONLY_IN_REAL_ENV');
      expect(everything).not.toContain('user:pass');
    });

    it('sees that CI is already callable', () => {
      expect(r.ci).toEqual([
        {
          file: '.github/workflows/ci.yml',
          triggers: ['pull_request', 'push', 'workflow_call'],
          callable: true,
        },
      ]);
    });

    it('renders a facts table', () => {
      expect(text).toMatch(/\| Fact \| Value \| Source \|/);
      expect(text).toMatch(/\| Database \| PostgreSQL \| verified: api\/package\.json \|/);
    });
  });

  it('reads a Vite single-page app', async () => {
    const { structured: r, raw } = await inspect('vite-spa');
    expect(r.apps).toEqual([
      expect.objectContaining({ path: '.', kind: 'static-spa', suggested_stack: 'static' }),
    ]);
    expect(fact(r, 'Vite config')?.value).toBe('base: /app/');
    expect(r.env_names.build_time).toEqual(['VITE_API_URL']);
    expect(r.env_files_present).toEqual(['.env.production']);
    expect(fact(r, 'Package manager')?.status).toBe('unknown');
    expect(JSON.stringify(raw)).not.toContain('canary-should-not-appear');
  });

  it('reads a Laravel app, keeping its Vite assets part of it', async () => {
    const { structured: r } = await inspect('laravel');
    expect(r.apps).toEqual([
      expect.objectContaining({
        path: '.',
        kind: 'laravel',
        suggested_stack: 'laravel',
        migrate: 'php artisan migrate --force',
      }),
    ]);
    expect(fact(r, 'PHP version')).toMatchObject({ status: 'verified', value: '^8.3' });
    expect(fact(r, 'Seeds')?.value).toMatch(/database\/seeders/);
    expect(fact(r, 'Health endpoint')?.value).toMatch(/\/up/);
    expect(r.env_names.run_time).toEqual(
      expect.arrayContaining(['APP_KEY', 'APP_NAME', 'DB_CONNECTION', 'DB_PASSWORD']),
    );
    expect(fact(r, 'Files written at run time')?.value).toMatch(/storage/);
  });

  it('says what it could not find in an empty folder', async () => {
    const { structured: r } = await inspect('empty');
    expect(r.apps).toEqual([]);
    expect(fact(r, 'Deployable apps')).toMatchObject({ status: 'unknown', value: 'none found' });
    expect(fact(r, 'Existing CI')?.status).toBe('unknown');
  });

  it('explains a missing folder or argument', async () => {
    const missing = await call(session.client, 'inspect_project', { project_dir: project('nope') });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/There is no folder/);
    const none = await call(session.client, 'inspect_project', {});
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/Pass project_dir/);
  });

  it('rejects a relative path', async () => {
    const r = await session.client
      .callTool({ name: 'inspect_project', arguments: { project_dir: 'relative/path' } })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it("uses Claude Code's CLAUDE_PROJECT_DIR when no folder is given", async () => {
    const other = await connect(testConfig({ defaultProjectDir: project('vite-spa') }));
    const r = await call<ProjectInspection>(other.client, 'inspect_project', {});
    expect(r.structured.apps[0]?.kind).toBe('static-spa');
    await other.close();
  });
});
