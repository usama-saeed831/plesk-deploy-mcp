import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { RELEASE_MANAGER_TESTS } from '../kit.js';
import { run } from '../lib/exec.js';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { findSecrets } from '../lib/secrets.js';
import { appName, localDir } from '../lib/validate.js';
import { which } from '../lib/which.js';
import { projectDir } from './common.js';
import type { ToolModule } from './index.js';

type Status = 'pass' | 'fail' | 'warn' | 'skipped';

interface Check {
  id: string;
  title: string;
  status: Status;
  details: string[];
}

const KIT_DIR = 'deploy/plesk';
const WORKFLOW = '.github/workflows/deploy-plesk.yml';

/** Lines the release manager must keep: each is a safety check from the workflow's rules. */
const SAFETY_MARKERS: [string, string][] = [
  ['Bundles are only taken from', 'bundles are only taken from INCOMING'],
  ['is not a .tgz bundle', 'only .tgz bundles are accepted'],
  ['-L "$bundle"', 'symlinked bundles are refused'],
  ['flock', 'one deploy at a time (lock)'],
  ['check_release', 'REQUIRED_FILES and the Node major are checked before the switch'],
  ['The migrations failed', 'a failed migration abandons the release before the switch'],
  ['switch_to "$previous"', 'an unhealthy release switches back by itself'],
  ['healthy "$commit"', 'health checks prove the new commit answers'],
];

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function confValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const m of text.matchAll(/^([A-Z_][A-Z0-9_]*)=(.*)$/gm)) {
    let v = m[2]!.replace(/\s+#.*$/, '').trim();
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.endsWith(v[0])) v = v.slice(1, -1);
    values.set(m[1]!, v);
  }
  return values;
}

export const registerValidateDeployKit: ToolModule = (server, config) => {
  server.registerTool(
    'validate_deploy_kit',
    {
      title: 'Validate the deploy kit',
      description:
        'Checks the deploy kit in a project (deploy/plesk/ and .github/workflows/deploy-plesk.yml) without touching anything outside a temporary folder. It runs bash -n on every script, shellcheck if installed, a YAML parse of the workflows, and checks of the workflow’s safety settings (StrictHostKeyChecking=yes, the production environment, deploys never cancelled, the SSH key removed, read-only permissions, callable CI). It confirms that the release manager kept every safety check and that a backup runs before migrations, and scans for secrets (reporting file and line, never the value). It also runs the release manager’s test suite against the project’s own copy in a temporary folder, with stand-ins for pm2, node and the network. Use it after generate_deploy_kit writes the kit, and after any change to it.',
      inputSchema: z.object({
        project_dir: localDir
          .optional()
          .describe(
            'Absolute path of the repository root. Defaults to the open project in Claude Code.',
          ),
        app: appName
          .optional()
          .describe('The app name, if deploy/plesk holds more than one *-deploy script'),
        run_release_manager_tests: z
          .boolean()
          .default(true)
          .describe('Run the release manager suite (about 20 seconds)'),
      }),
      outputSchema: z.object({
        project_dir: z.string(),
        app: z.string().optional(),
        ok: z.boolean(),
        checks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(['pass', 'fail', 'warn', 'skipped']),
            details: z.array(z.string()),
          }),
        ),
      }),
      annotations: {
        title: 'Validate the deploy kit',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args, signal) => {
      const root = await projectDir(args.project_dir, config);
      const kitDir = path.join(root, KIT_DIR);
      if (!(await exists(kitDir))) {
        throw new ToolError(
          `There is no ${KIT_DIR} in ${root}. Generate the kit first (generate_deploy_kit).`,
        );
      }
      const entries = (await readdir(kitDir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
      const managers = entries.filter((n) => /^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?-deploy$/.test(n));
      const app =
        args.app ?? (managers.length === 1 ? managers[0]!.replace(/-deploy$/, '') : undefined);
      const checks: Check[] = [];
      const add = (id: string, title: string, status: Status, details: string[] = []) =>
        checks.push({ id, title, status, details });
      const env = config.childEnv;
      const bash = which('bash', env);

      // ── The release manager is there, with every safety check ────────────
      const managerFile = app ? path.join(kitDir, `${app}-deploy`) : undefined;
      let manager: string | undefined;
      if (!app) {
        add('release-manager', 'Release manager present', 'fail', [
          managers.length
            ? `More than one: ${managers.join(', ')}. Pass app.`
            : `No <app>-deploy in ${KIT_DIR}.`,
        ]);
      } else if (!(await exists(managerFile!))) {
        add('release-manager', 'Release manager present', 'fail', [`No ${KIT_DIR}/${app}-deploy.`]);
      } else {
        manager = await readFile(managerFile!, 'utf8');
        const missing = SAFETY_MARKERS.filter(([marker]) => !manager!.includes(marker)).map(
          ([, what]) => what,
        );
        add(
          'release-manager-safety',
          'Release manager kept every safety check',
          missing.length ? 'fail' : 'pass',
          missing.length
            ? missing.map(
                (m) => `Missing: ${m}. Restore it from plesk-deploy://templates/server/app-deploy.`,
              )
            : [],
        );
      }

      // ── Shell scripts ──────────────────────────────────────────────────────
      const scripts: string[] = [];
      for (const name of entries) {
        const head = (await readFile(path.join(kitDir, name), 'utf8')).slice(0, 64);
        if (name.endsWith('.sh') || /^#!.*\b(ba)?sh\b/.test(head)) scripts.push(name);
      }
      if (!bash) {
        add('bash-syntax', 'Shell syntax (bash -n)', 'skipped', ['bash was not found on PATH.']);
      } else {
        const errors: string[] = [];
        for (const name of scripts) {
          const r = await run(bash, ['-n', path.join(kitDir, name)], {
            env,
            timeoutMs: 10_000,
            signal,
          });
          if (r.code !== 0)
            errors.push(`${name}: ${(r.stderr || r.startError || 'failed').trim().split('\n')[0]}`);
        }
        add(
          'bash-syntax',
          `Shell syntax (bash -n) on ${scripts.length} scripts`,
          errors.length ? 'fail' : 'pass',
          errors,
        );
      }
      const shellcheck = which('shellcheck', env);
      if (!shellcheck) {
        add('shellcheck', 'shellcheck', 'skipped', ['shellcheck is not installed (optional).']);
      } else {
        const r = await run(
          shellcheck,
          ['-S', 'error', ...scripts.map((s) => path.join(kitDir, s))],
          { env, timeoutMs: 30_000, signal },
        );
        add(
          'shellcheck',
          'shellcheck (errors only)',
          r.code === 0 ? 'pass' : 'fail',
          r.code === 0 ? [] : r.stdout.trim().split('\n').slice(0, 20),
        );
      }

      // ── Workflows ──────────────────────────────────────────────────────────
      const wfPath = path.join(root, WORKFLOW);
      if (!(await exists(wfPath))) {
        add('workflow-yaml', 'Deploy workflow parses', 'fail', [`No ${WORKFLOW}.`]);
      } else {
        const raw = await readFile(wfPath, 'utf8');
        let wf: Record<string, unknown> | undefined;
        try {
          wf = parseYaml(raw) as Record<string, unknown>;
          add('workflow-yaml', 'Deploy workflow parses', 'pass');
        } catch (error) {
          add('workflow-yaml', 'Deploy workflow parses', 'fail', [
            (error as Error).message.split('\n')[0]!,
          ]);
        }
        if (wf) {
          const problems: string[] = [];
          const jobs = (wf.jobs ?? {}) as Record<string, Record<string, unknown>>;
          const perms = wf.permissions as Record<string, string> | string | undefined;
          if (!(
            perms &&
            typeof perms === 'object' &&
            perms.contents === 'read' &&
            Object.keys(perms).length === 1
          )) {
            problems.push('Top-level permissions should be exactly { contents: read }.');
          }
          if (!raw.includes('StrictHostKeyChecking=yes'))
            problems.push('SSH must use StrictHostKeyChecking=yes.');
          if (/StrictHostKeyChecking=(no|accept-new)/.test(raw))
            problems.push('StrictHostKeyChecking must never be no or accept-new.');
          const deploy = Object.values(jobs).find((j) => {
            const e = j.environment as string | { name?: string } | undefined;
            return (typeof e === 'string' ? e : e?.name) === 'production';
          });
          if (!deploy) {
            problems.push('No job uses the production environment, so nothing waits for approval.');
          } else {
            const concurrency = deploy.concurrency as
              { 'cancel-in-progress'?: unknown } | undefined;
            if (concurrency?.['cancel-in-progress'] !== false)
              problems.push('The deploy job must set cancel-in-progress: false.');
            const steps = (deploy.steps ?? []) as { if?: string; run?: string }[];
            if (!steps.some((s) => /always\(\)/.test(s.if ?? '') && /rm\b/.test(s.run ?? ''))) {
              problems.push('No if: always() step removes the SSH key.');
            }
            const needs = ([] as string[]).concat(
              (deploy.needs as string[] | string | undefined) ?? [],
            );
            if (needs.length < 2)
              problems.push('The deploy job should need both the tests and the bundle.');
          }
          add(
            'workflow-safety',
            'Deploy workflow safety settings',
            problems.length ? 'fail' : 'pass',
            problems,
          );

          const testJob = Object.values(jobs).find(
            (j) => typeof j.uses === 'string' && j.uses.startsWith('./.github/workflows/'),
          );
          if (!testJob) {
            add('ci-callable', 'Tests run inside the deploy', 'fail', [
              'No job calls the CI workflow: never deploy untested.',
            ]);
          } else {
            const ciPath = path.join(root, (testJob.uses as string).slice(2));
            try {
              const ci = parseYaml(await readFile(ciPath, 'utf8')) as {
                on?: Record<string, unknown>;
                true?: Record<string, unknown>;
              };
              const on = ci?.on ?? ci?.true;
              const callable = !!on && typeof on === 'object' && 'workflow_call' in on;
              add(
                'ci-callable',
                `${testJob.uses as string} is callable`,
                callable ? 'pass' : 'fail',
                callable
                  ? []
                  : [
                      'Add the workflow_call trigger (plesk-deploy://templates/github/ci-callable.md).',
                    ],
              );
            } catch {
              add('ci-callable', `${testJob.uses as string} is callable`, 'fail', [
                `${(testJob.uses as string).slice(2)} is missing or doesn't parse.`,
              ]);
            }
          }
        }
      }

      // ── Backups before migrations, and what is still to fill in ───────────
      const confPath = path.join(kitDir, 'deploy.conf.example');
      if (await exists(confPath)) {
        const conf = await readFile(confPath, 'utf8');
        const v = confValues(conf);
        const problems: string[] = [];
        if (v.get('MIGRATE_CMD') && !v.get('PRE_MIGRATE_CMD'))
          problems.push(
            'MIGRATE_CMD is set but PRE_MIGRATE_CMD (the dump) is not: back up before migrating.',
          );
        const helper = /\/usr\/local\/bin\/([a-z0-9-]+-db-backup)/.exec(
          v.get('PRE_MIGRATE_CMD') ?? '',
        )?.[1];
        if (helper && !entries.includes(helper))
          problems.push(`PRE_MIGRATE_CMD runs ${helper}, which isn't in ${KIT_DIR}.`);
        add(
          'backup-before-migrate',
          'A backup runs before migrations',
          problems.length ? 'fail' : 'pass',
          problems,
        );
        const fill = conf
          .split('\n')
          .filter((l) => /FILL IN|FILL_IN/.test(l))
          .map((l) => l.trim());
        add(
          'fill-in',
          'Values still to fill in on the server',
          fill.length ? 'warn' : 'pass',
          fill,
        );
      }

      // ── Secrets and files that must never ship ─────────────────────────────
      const secretFindings: string[] = [];
      for (const name of entries) {
        if (/^\.env(\.|$)/.test(name) && !/\.example$/.test(name))
          secretFindings.push(`${KIT_DIR}/${name}: an env file must never be in the kit.`);
        if (/\.(pem|key)$|^id_(rsa|ed25519|ecdsa)$/.test(name))
          secretFindings.push(`${KIT_DIR}/${name}: a key file must never be in the kit.`);
        const text = await readFile(path.join(kitDir, name), 'utf8');
        for (const f of findSecrets(`${KIT_DIR}/${name}`, text))
          secretFindings.push(`${f.file}:${f.line}: looks like a ${f.kind}.`);
      }
      if (await exists(wfPath)) {
        for (const f of findSecrets(WORKFLOW, await readFile(wfPath, 'utf8')))
          secretFindings.push(`${f.file}:${f.line}: looks like a ${f.kind}.`);
      }
      add(
        'secrets',
        'No secrets in the kit',
        secretFindings.length ? 'fail' : 'pass',
        secretFindings,
      );

      // ── The release manager's own suite ───────────────────────────────────
      if (!args.run_release_manager_tests) {
        add('release-manager-tests', 'Release manager test suite', 'skipped', ['Not requested.']);
      } else if (!bash) {
        add('release-manager-tests', 'Release manager test suite', 'skipped', [
          'bash was not found on PATH.',
        ]);
      } else if (!manager) {
        add('release-manager-tests', 'Release manager test suite', 'skipped', [
          'No release manager to test.',
        ]);
      } else {
        const r = await run(bash, [RELEASE_MANAGER_TESTS, managerFile!], {
          env,
          timeoutMs: 180_000,
          signal,
        });
        const summary = /(\d+) passed, (\d+) failed\./.exec(r.stdout);
        const failedLines = r.stdout.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
        const ok = r.code === 0 && summary?.[2] === '0';
        add(
          'release-manager-tests',
          'Release manager test suite',
          ok ? 'pass' : 'fail',
          summary
            ? [`${summary[1]} passed, ${summary[2]} failed.`, ...failedLines.slice(0, 20)]
            : [r.timedOut ? 'Timed out.' : (r.stderr || 'No summary line.').trim().slice(0, 500)],
        );
      }

      const ok = !checks.some((c) => c.status === 'fail');
      const icon: Record<Status, string> = {
        pass: 'pass',
        fail: '**FAIL**',
        warn: 'warn',
        skipped: 'skipped',
      };
      const text = [
        `## Deploy kit checks: ${root}${app ? ` (${app})` : ''}`,
        '',
        '| Check | Result |',
        '|---|---|',
        ...checks.map((c) => `| ${c.title} | ${icon[c.status]} |`),
        '',
        ...checks
          .filter((c) => c.details.length && c.status !== 'pass')
          .map((c) => `**${c.title}**\n${c.details.map((d) => `- ${d}`).join('\n')}\n`),
        ok
          ? 'Every check passed (warnings are values to fill in on the server). This proves the kit is consistent, not that a deploy works: that is only verified live, from outside.'
          : 'Fix every FAIL before the first deploy.',
      ].join('\n');
      return textResult(text, { project_dir: root, ...(app ? { app } : {}), ok, checks });
    }),
  );
};
