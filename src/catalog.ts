/**
 * Every file of the vendored kit that is served as an MCP resource: the
 * workflow, the references and the templates. Static, so every client can
 * list them.
 */
import { readFileSync } from 'node:fs';
import { kitPath } from './kit.js';

export interface KitResource {
  /** Unique registration name. */
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  /** Path inside kit/. */
  file: string;
}

export const URI_PREFIX = 'plesk-deploy://';

const REFERENCES: [string, string, string][] = [
  [
    'discovery',
    'Discovery',
    'What to read in the project, and read-only commands for the server and Plesk.',
  ],
  [
    'hosting-models',
    'Hosting models',
    'Per stack: Node under PM2 or systemd, Next.js, NestJS, static SPA, Laravel/PHP, WordPress, full-stack, Plesk Git extension.',
  ],
  [
    'github-actions',
    'GitHub Actions',
    'Pipeline design, the production environment, secrets versus variables, concurrency, reusable CI.',
  ],
  [
    'release-manager',
    'Release manager',
    'How <app>-deploy works, every setting, a configuration per stack, testing it.',
  ],
  [
    'environment-and-database',
    'Environment and database',
    'Env files, build-time versus run-time values, databases, migrations, backups, Redis, cron, workers.',
  ],
  [
    'security-and-safety',
    'Security and safety',
    'The deploy account, keys, sudo, file exposure, ports, logs.',
  ],
  [
    'verification-checklist',
    'Verification checklist',
    'Before, during and after the first deploy, and the rollback drill.',
  ],
  [
    'troubleshooting',
    'Troubleshooting',
    'Symptom, cause and fix, including failures seen in real deployments.',
  ],
  ['rollback', 'Rollback', 'Automatic, manual, database and emergency rollback.'],
  [
    'worked-example',
    'Worked example',
    'An anonymised end-to-end account of the production deployment the workflow came from.',
  ],
];

const TEMPLATES: [string, string, string][] = [
  [
    'github/deploy-plesk.yml',
    'application/yaml',
    'Becomes .github/workflows/deploy-plesk.yml: tests and bundle in parallel, approval, upload, release manager, check from outside.',
  ],
  [
    'github/ci-callable.md',
    'text/markdown',
    'How to make the existing CI reusable (workflow_call) without weakening it.',
  ],
  [
    'build/build-bundle.sh',
    'text/x-shellscript',
    'Becomes deploy/plesk/build-bundle.sh: builds and checks the release bundle on the CI runner.',
  ],
  [
    'server/app-deploy',
    'text/x-shellscript',
    'Becomes deploy/plesk/<app>-deploy: the release manager (deploy, --rollback, --status).',
  ],
  [
    'server/deploy.conf.example',
    'text/plain',
    'Becomes deploy/plesk/deploy.conf.example: every release manager setting.',
  ],
  [
    'server/server-setup.sh',
    'text/x-shellscript',
    'Becomes deploy/plesk/server-setup.sh: the one-time, idempotent server set-up, run by root.',
  ],
  [
    'server/db-backup',
    'text/x-shellscript',
    'Becomes deploy/plesk/<app>-db-backup: the database dump before migrating.',
  ],
  [
    'process/ecosystem.config.js',
    'text/javascript',
    'PM2 process definitions that run from current.',
  ],
  ['process/app.service', 'text/plain', 'A systemd unit that runs from current.'],
  [
    'plesk/nginx-proxy-directives.conf',
    'text/plain',
    'Plesk additional nginx directives for a proxied app.',
  ],
  [
    'plesk/nginx-spa-directives.conf',
    'text/plain',
    'Plesk additional nginx directives for a single-page app.',
  ],
  [
    'docs/DEPLOY-README.md',
    'text/markdown',
    'Becomes deploy/plesk/README.md: set-up, secrets, every day, rollback.',
  ],
];

export const KIT_RESOURCES: readonly KitResource[] = [
  {
    name: 'workflow',
    uri: `${URI_PREFIX}workflow`,
    title: 'Plesk deployment workflow',
    description:
      'The 8 phases and the rules that are never relaxed. Read this first; it names the reference to read at each phase.',
    mimeType: 'text/markdown',
    file: 'SKILL.md',
  },
  ...REFERENCES.map(([slug, title, description]) => ({
    name: `reference-${slug}`,
    uri: `${URI_PREFIX}references/${slug}`,
    title,
    description,
    mimeType: 'text/markdown',
    file: `references/${slug}.md`,
  })),
  ...TEMPLATES.map(([file, mimeType, description]) => ({
    name: `template-${file.replace(/[/.]/g, '-')}`,
    uri: `${URI_PREFIX}templates/${file}`,
    title: `Template: ${file}`,
    description,
    mimeType,
    file: `templates/${file}`,
  })),
];

const WORKFLOW_NOTE = `> Served by plesk-deploy-mcp. Where this workflow names \`references/<name>.md\`, read the
> resource \`plesk-deploy://references/<name>\`; \`templates/<path>\` is
> \`plesk-deploy://templates/<path>\`. The tools inspect_project, server_discovery_commands,
> generate_deploy_kit and validate_deploy_kit do the local work of phases 1, 2, 5 and 7, and
> validate_deploy_kit runs \`scripts/test-release-manager.sh\` for you.

`;

/** The text served for a resource. The workflow loses its skill frontmatter and gains a note on resource names. */
export function readKitResource(resource: KitResource): string {
  const text = readFileSync(kitPath(resource.file), 'utf8');
  if (resource.file !== 'SKILL.md') return text;
  return WORKFLOW_NOTE + text.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

/** The "Rules that are never relaxed" section of the workflow, verbatim. */
export function workflowRules(): string {
  const skill = readFileSync(kitPath('SKILL.md'), 'utf8');
  const match = /## Rules that are never relaxed\n([\s\S]*?)\n## /.exec(skill);
  if (!match?.[1]) throw new Error('The workflow has no "Rules that are never relaxed" section.');
  return match[1].trim();
}
