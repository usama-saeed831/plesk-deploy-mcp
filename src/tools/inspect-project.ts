import * as z from 'zod';
import { factsTable, inspectProject } from '../inspect/project.js';
import { guarded, textResult } from '../lib/result.js';
import { localDir } from '../lib/validate.js';
import { projectDir } from './common.js';
import type { ToolModule } from './index.js';

const factSchema = z.object({
  fact: z.string(),
  value: z.string(),
  status: z.enum(['verified', 'unknown']),
  evidence: z.string().optional(),
});

export const inspectProjectOutput = z.object({
  project_dir: z.string(),
  files_scanned: z.number(),
  truncated: z.boolean(),
  facts: z.array(factSchema),
  apps: z.array(
    z.object({
      path: z.string(),
      name: z.string().optional(),
      kind: z.string(),
      frameworks: z.array(z.string()),
      build: z.string().optional(),
      start: z.string().optional(),
      migrate: z.string().optional(),
      suggested_stack: z.enum(['node', 'next', 'static', 'laravel']).optional(),
    }),
  ),
  env_names: z.object({
    build_time: z.array(z.string()),
    run_time: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  env_files_present: z.array(z.string()),
  ci: z.array(z.object({ file: z.string(), triggers: z.array(z.string()), callable: z.boolean() })),
});

export const registerInspectProject: ToolModule = (server, config) => {
  server.registerTool(
    'inspect_project',
    {
      title: 'Inspect a project for deployment',
      description:
        'Reads a project folder on this machine (manifests, lockfiles, runtime pins, framework configs, Dockerfiles, CI workflows, migrations, source code) and returns a Deployment facts table, each fact marked verified (with the file it came from) or unknown. Also lists the deployable apps with build/start/migrate commands and the environment variable NAMES split into build-time and run-time. Never reads env values: real .env files are reported as present, never opened. Use it first, in phase 1 of setting up a Plesk deployment. Changes nothing.',
      inputSchema: z.object({
        project_dir: localDir
          .optional()
          .describe(
            'Absolute path of the project folder. Defaults to the open project in Claude Code.',
          ),
      }),
      outputSchema: inspectProjectOutput,
      annotations: {
        title: 'Inspect a project for deployment',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const root = await projectDir(args.project_dir, config);
      const result = await inspectProject(root);
      const apps = result.apps
        .filter((a) => a.kind !== 'library')
        .map(
          (a) =>
            `- \`${a.path}\`: ${a.frameworks.join(' + ') || a.kind}${a.suggested_stack ? ` (generate_deploy_kit stack: ${a.suggested_stack})` : ''}`,
        );
      const text = [
        `## Deployment facts: ${root}`,
        '',
        factsTable(result.facts),
        '',
        apps.length ? `**Apps**\n${apps.join('\n')}` : '**Apps:** none found.',
        '',
        `Scanned ${result.files_scanned} files${result.truncated ? ' (stopped at the limit: some files were not read)' : ''}. ` +
          '"unknown" means it must be found out on the server or asked; it is never assumed. ' +
          'Next: server_discovery_commands for the read-only server checks.',
      ].join('\n');
      return textResult(text, result as unknown as Record<string, unknown>);
    }),
  );
};
