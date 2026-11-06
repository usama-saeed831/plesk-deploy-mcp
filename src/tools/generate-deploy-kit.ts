import { createTwoFilesPatch } from 'diff';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { kitPath } from '../kit.js';
import {
  KIT_PARTS,
  type KitParams,
  type RenderedFile,
  adaptPoints,
  renderKit,
} from '../kit/render.js';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { findSecrets, type SecretFinding } from '../lib/secrets.js';
import {
  appName,
  envName,
  gitBranch,
  healthText,
  httpUrl,
  httpsUrl,
  localDir,
  pm2Name,
  port,
  relPath,
  remotePath,
  shellCommand,
  systemUser,
  unitName,
  workflowFile,
} from '../lib/validate.js';
import { projectDir } from './common.js';
import type { ToolModule } from './index.js';

const safeArgs = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z0-9 ._:=/@,+-]+$/,
    'Plain arguments: letters, digits, spaces and . _ : = / @ , + -',
  );

const pathPrefix = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/, 'A path prefix such as docs/')
  .refine((s) => !s.split('/').includes('..'), 'No ".." segments');

export const generateInput = z
  .object({
    project_dir: localDir
      .optional()
      .describe(
        'Absolute path of the repository root. Defaults to the open project in Claude Code.',
      ),
    app: appName,
    stack: z
      .enum(['node', 'next', 'static', 'laravel'])
      .describe('Which build-bundle.sh branch builds the release'),
    process_manager: z
      .enum(['pm2', 'systemd', 'php-fpm', 'none'])
      .describe('What the server reloads after the switch; keep what runs today'),
    branch: gitBranch.default('main').describe('The production branch'),
    ci_workflow: workflowFile
      .default('ci.yml')
      .describe('The existing CI workflow the deploy calls for its tests'),
    site_url: httpsUrl.describe('The public site, checked from outside after each deploy'),
    public_health_url: httpsUrl.describe(
      'A public URL whose answer contains the deployed commit (a health endpoint or version.json)',
    ),
    base_dir: remotePath.describe('BASE on the server: where releases/, current and shared/ live'),
    health_checks: z
      .array(z.object({ url: httpUrl, contains: healthText.optional() }))
      .min(1)
      .max(10)
      .describe(
        'What the release manager checks after the switch; prefer the app’s own port, e.g. http://127.0.0.1:3001/health',
      ),
    health_commit_url: httpUrl
      .optional()
      .describe('A URL whose answer must contain the release’s commit'),
    app_user: systemUser
      .optional()
      .describe('The account that runs the app, from the server. Left as FILL IN if unknown'),
    app_group: systemUser.optional(),
    deploy_user: systemUser
      .optional()
      .describe('The SSH account GitHub Actions uses (default <app>-deploy)'),
    node_bin_dir: remotePath
      .optional()
      .describe('The folder with the node (and pm2) the app uses, e.g. /opt/plesk/node/24/bin'),
    pm2_home: remotePath.optional(),
    pm2_apps: z
      .array(
        z.object({
          name: pm2Name,
          dir: z.union([z.literal('.'), relPath]),
          script: relPath,
          args: safeArgs.optional(),
        }),
      )
      .max(10)
      .optional()
      .describe('Each PM2 process: its name, its folder in the release, its script, and arguments'),
    systemd_units: z
      .array(z.object({ name: unitName, dir: z.union([z.literal('.'), relPath]), script: relPath }))
      .max(10)
      .optional(),
    php_fpm_service: unitName.optional().describe("The domain's FPM service, e.g. plesk-php83-fpm"),
    php_version: z
      .string()
      .regex(/^\d+\.\d+$/, 'major.minor, e.g. 8.3')
      .optional(),
    env_file: remotePath
      .optional()
      .describe("The app's env file on the server (default /etc/<app>/app.env)"),
    shared_links: z
      .array(z.object({ path: relPath, target: remotePath }))
      .max(20)
      .optional(),
    required_files: z.array(relPath).max(30).optional(),
    database: z
      .enum(['postgres', 'mysql', 'none'])
      .default('none')
      .describe('Adds the pre-migration dump for this engine'),
    migrate_cmd: shellCommand.optional(),
    post_switch_cmd: shellCommand.optional(),
    build_time_vars: z
      .array(envName)
      .max(30)
      .default([])
      .describe('Public build-time values (repository variables), names only'),
    runtime_env_names: z
      .array(envName)
      .max(200)
      .default([])
      .describe('Names for the placeholder env file server-setup.sh creates, never values'),
    not_deployed_paths: z
      .array(pathPrefix)
      .max(20)
      .default(['docs/'])
      .describe('Path prefixes whose changes are tested but not deployed (.md files never deploy)'),
    static_dir: relPath.optional().describe('Static sites: the build output folder (default dist)'),
    checkout_env: relPath
      .optional()
      .describe('The env file inside the folder production runs from today'),
    checkout_uploads: relPath
      .optional()
      .describe('Run-time files inside the folder production runs from today'),
    nginx: z
      .enum(['none', 'proxy', 'spa'])
      .default('none')
      .describe('Only if the proxy needs changing; a working proxy is left alone'),
    proxy_port: port.optional(),
    parts: z
      .array(z.enum(KIT_PARTS as [string, ...string[]]))
      .max(KIT_PARTS.length)
      .optional()
      .describe('Generate only these parts'),
    write: z
      .boolean()
      .default(false)
      .describe('false (default): return the plan and diffs, write nothing'),
    overwrite: z
      .array(relPath)
      .max(30)
      .default([])
      .describe(
        'Existing files that may be replaced. List one only after showing the user what is there and getting agreement',
      ),
  })
  .superRefine((p, ctx) => {
    const need = (ok: boolean, field: string, why: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [field], message: why });
    };
    need(
      p.process_manager !== 'pm2' || !!p.pm2_apps?.length,
      'pm2_apps',
      'pm2_apps is required with process_manager pm2',
    );
    need(
      p.process_manager !== 'systemd' || !!p.systemd_units?.length,
      'systemd_units',
      'systemd_units is required with process_manager systemd',
    );
    need(
      p.process_manager !== 'php-fpm' || !!p.php_fpm_service,
      'php_fpm_service',
      'php_fpm_service is required with process_manager php-fpm',
    );
    need(
      p.nginx !== 'proxy' || p.proxy_port !== undefined,
      'proxy_port',
      'proxy_port is required with nginx proxy',
    );
  });

type Action = 'create' | 'unchanged' | 'overwrite' | 'blocked-exists' | 'blocked-symlink';

interface PlannedFile {
  path: string;
  action: Action;
  mode: string;
  lines: number;
  template?: string;
  diff_base: 'existing' | 'template' | 'none';
  diff: string;
}

async function lstatOrUndefined(p: string) {
  try {
    return await lstat(p);
  } catch {
    return undefined;
  }
}

/** True when the path, or any folder on the way to it inside root, is a symlink. */
async function goesThroughSymlink(root: string, rel: string): Promise<boolean> {
  let current = root;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    const info = await lstatOrUndefined(current);
    if (!info) return false;
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

async function plan(
  root: string,
  file: RenderedFile,
  overwrite: Set<string>,
): Promise<PlannedFile> {
  const full = path.join(root, file.path);
  const lines = file.content.split('\n').length;
  const base = {
    path: file.path,
    mode: file.mode.toString(8),
    lines,
    ...(file.template ? { template: file.template } : {}),
  };
  if (await goesThroughSymlink(root, file.path)) {
    return { ...base, action: 'blocked-symlink', diff_base: 'none', diff: '' };
  }
  const info = await lstatOrUndefined(full);
  if (info) {
    const existing = await readFile(full, 'utf8');
    if (existing === file.content)
      return { ...base, action: 'unchanged', diff_base: 'existing', diff: '' };
    const diff = createTwoFilesPatch(
      `a/${file.path}`,
      `b/${file.path}`,
      existing,
      file.content,
      'existing',
      'generated',
    );
    return {
      ...base,
      action: overwrite.has(file.path) ? 'overwrite' : 'blocked-exists',
      diff_base: 'existing',
      diff,
    };
  }
  const original = file.template ? await readFile(kitPath(file.template), 'utf8') : '';
  const diff = createTwoFilesPatch(
    file.template ?? '/dev/null',
    `b/${file.path}`,
    original,
    file.content,
    'template',
    'generated',
  );
  return { ...base, action: 'create', diff_base: file.template ? 'template' : 'none', diff };
}

/** Writes through a temporary file and a rename, creating folders but never following a symlink. */
async function writeKitFile(root: string, file: RenderedFile): Promise<void> {
  let dir = root;
  for (const segment of file.path.split('/').slice(0, -1)) {
    dir = path.join(dir, segment);
    const info = await lstatOrUndefined(dir);
    if (!info) await mkdir(dir);
    else if (info.isSymbolicLink() || !info.isDirectory())
      throw new ToolError(`${path.relative(root, dir)} is not a plain folder.`);
  }
  const full = path.join(root, file.path);
  const tmp = `${full}.plesk-deploy-mcp-${process.pid}.tmp`;
  try {
    await writeFile(tmp, file.content, { flag: 'wx', mode: file.mode });
    await chmod(tmp, file.mode);
    await rename(tmp, full);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function repositoryRoot(root: string): Promise<void> {
  if (await lstatOrUndefined(path.join(root, '.git'))) return;
  let dir = path.dirname(root);
  while (dir !== path.dirname(dir)) {
    if (await lstatOrUndefined(path.join(dir, '.git'))) {
      throw new ToolError(
        `project_dir must be the repository root (GitHub reads workflows from there). It is ${dir}.`,
      );
    }
    dir = path.dirname(dir);
  }
  throw new ToolError(
    'project_dir is not a git repository. The deploy runs from GitHub Actions, so the kit belongs in one.',
  );
}

async function warnings(root: string, p: KitParams): Promise<string[]> {
  const out: string[] = [];
  const ciFile = path.join(root, '.github', 'workflows', p.ci_workflow);
  const ci = await lstatOrUndefined(ciFile);
  if (!ci) {
    out.push(
      `There is no .github/workflows/${p.ci_workflow}. Write the CI first; never deploy untested. The deploy calls it with workflow_call (plesk-deploy://templates/github/ci-callable.md).`,
    );
  } else {
    try {
      const doc = parseYaml(await readFile(ciFile, 'utf8')) as {
        on?: Record<string, unknown>;
        true?: Record<string, unknown>;
      } | null;
      const on = doc?.on ?? doc?.true;
      const call =
        on && typeof on === 'object' && !Array.isArray(on)
          ? (on.workflow_call as { inputs?: Record<string, unknown> } | null | undefined)
          : undefined;
      if (call === undefined) {
        out.push(
          `${p.ci_workflow} isn't callable yet: add the workflow_call trigger with ref and skip_build inputs (plesk-deploy://templates/github/ci-callable.md). Ask before changing it.`,
        );
      } else if (!call?.inputs || !('ref' in call.inputs) || !('skip_build' in call.inputs)) {
        out.push(
          `${p.ci_workflow} is callable but lacks the ref and skip_build inputs the deploy passes (plesk-deploy://templates/github/ci-callable.md).`,
        );
      }
    } catch {
      out.push(`${p.ci_workflow} could not be parsed as YAML.`);
    }
  }
  // Every stack builds with Node on the runner (Laravel for its assets).
  if (!(await lstatOrUndefined(path.join(root, '.nvmrc')))) {
    out.push(
      'There is no .nvmrc: the workflow reads the Node version from it. Pin the Node major the server runs.',
    );
  }
  const pkg = await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '');
  if (/"workspaces"/.test(pkg)) {
    out.push(
      'This is a monorepo: build-bundle.sh stages one app. Stage each deployed app into its own folder (see the comments at its top) and match PM2_APPS and REQUIRED_FILES.',
    );
  }
  if (!p.migrate_cmd && p.database !== 'none')
    out.push('A database is set but no migrate_cmd: MIGRATE_CMD is empty in deploy.conf.example.');
  if (!p.health_commit_url)
    out.push(
      'No health_commit_url: the release manager will not prove the new commit answers (HEALTH_COMMIT_URL is empty).',
    );
  return out;
}

const fileSchema = z.object({
  path: z.string(),
  action: z.enum(['create', 'unchanged', 'overwrite', 'blocked-exists', 'blocked-symlink']),
  mode: z.string(),
  lines: z.number(),
  template: z.string().optional(),
  diff_base: z.enum(['existing', 'template', 'none']),
  diff: z.string(),
});

export const registerGenerateDeployKit: ToolModule = (server, config) => {
  server.registerTool(
    'generate_deploy_kit',
    {
      title: 'Generate the deploy kit',
      description:
        'Renders the deploy kit for a project from explicit parameters: .github/workflows/deploy-plesk.yml and deploy/plesk/ (build-bundle.sh, the <app>-deploy release manager, deploy.conf.example, server-setup.sh, the database dump helper, PM2 or systemd definitions, optional nginx directives, README.md). A DRY RUN by default: it returns each file’s action and a diff (against the vetted template for a new file, against the current file for an existing one) and writes nothing. With write: true it writes inside the repository root only, never through a symlink, never deletes, and never replaces an existing file unless its path is listed in overwrite. Values it doesn’t know are left as FILL IN and listed. Use it in phase 5, after the user agreed the plan; write only after they saw the diff. Refuses to write a kit that contains anything that looks like a secret.',
      inputSchema: generateInput,
      outputSchema: z.object({
        project_dir: z.string(),
        written: z.boolean(),
        files: z.array(fileSchema),
        adapt: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
        warnings: z.array(z.string()),
        secrets: z.array(z.object({ file: z.string(), line: z.number(), kind: z.string() })),
      }),
      annotations: {
        title: 'Generate the deploy kit',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const root = await projectDir(args.project_dir, config);
      const { project_dir: _dir, write, overwrite, ...rest } = args;
      const params: KitParams = rest as KitParams;
      const rendered = renderKit(params);
      const overwriteSet = new Set(overwrite);
      const files = await Promise.all(rendered.map((f) => plan(root, f, overwriteSet)));
      const secrets: SecretFinding[] = rendered.flatMap((f) => findSecrets(f.path, f.content));
      const adapt = adaptPoints(rendered);
      const warns = await warnings(root, params);
      const unknownOverwrite = overwrite.filter((o) => !rendered.some((f) => f.path === o));
      if (unknownOverwrite.length)
        warns.push(`Not part of the kit, so not overwritten: ${unknownOverwrite.join(', ')}.`);

      let written = false;
      const blocked = files.filter((f) => f.action.startsWith('blocked'));
      if (write) {
        if (secrets.length)
          throw new ToolError(
            `Nothing was written: the kit contains values that look like secrets (${secrets.map((s) => `${s.file}:${s.line} ${s.kind}`).join(', ')}). Secrets belong in GitHub environment secrets or on the server.`,
          );
        if (blocked.length) {
          throw new ToolError(
            `Nothing was written. These files already exist (or sit behind a symlink): ${blocked.map((b) => b.path).join(', ')}. Show the user the diff; list a file in overwrite only if they agree to replace it, or leave it out with parts.`,
          );
        }
        await repositoryRoot(root);
        for (const f of rendered) {
          const planned = files.find((x) => x.path === f.path)!;
          if (planned.action === 'create' || planned.action === 'overwrite')
            await writeKitFile(root, f);
        }
        written = true;
      }

      const table = [
        '| File | Action | Lines | From |',
        '|---|---|---|---|',
        ...files.map((f) => `| ${f.path} | ${f.action} | ${f.lines} | ${f.template ?? ''} |`),
      ].join('\n');
      const text = [
        written
          ? `## Deploy kit written to ${root}`
          : `## Deploy kit plan for ${root} (dry run: nothing written)`,
        '',
        table,
        warns.length ? `\n**Warnings**\n${warns.map((w) => `- ${w}`).join('\n')}` : '',
        secrets.length
          ? `\n**Looks like a secret** (never write one into the kit):\n${secrets.map((s) => `- ${s.file}:${s.line} (${s.kind})`).join('\n')}`
          : '',
        adapt.length
          ? `\n**Still to adapt by a person** (${adapt.length}):\n${adapt
              .slice(0, 40)
              .map((a) => `- ${a.file}:${a.line}: ${a.text}`)
              .join(
                '\n',
              )}${adapt.length > 40 ? `\n- … ${adapt.length - 40} more in the structured result` : ''}`
          : '',
        written
          ? '\nNext: validate_deploy_kit, then the manual steps (server, Plesk, GitHub) from deploy/plesk/README.md.'
          : '\nShow the user these diffs (against the vetted templates, or the current files). Call again with write: true only after they agree.',
        '',
        ...files
          .filter((f) => f.diff)
          .map(
            (f) =>
              `### ${f.path} (${f.action}; diff against the ${f.diff_base} file)\n\`\`\`diff\n${f.diff}\`\`\``,
          ),
      ].join('\n');
      return textResult(text, {
        project_dir: root,
        written,
        files,
        adapt,
        warnings: warns,
        secrets,
      });
    }),
  );
};
