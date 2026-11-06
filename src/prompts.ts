import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { workflowRules } from './catalog.js';
import { hostAlias, localDir } from './lib/validate.js';

export const SETUP_PROMPT = 'setup-plesk-deployment';

export function setupPromptText(args: { project_dir?: string; host_alias?: string }): string {
  const project = args.project_dir ? ` for the project at \`${args.project_dir}\`` : '';
  const dirArg = args.project_dir ? ` with project_dir "${args.project_dir}"` : '';
  const server = args.host_alias
    ? `If the user agrees, you can instead run **server_discover** with host_alias "${args.host_alias}" (read-only, fixed commands, secrets redacted).`
    : 'If the user has enabled the SSH tools (PLESK_DEPLOY_SSH_HOSTS) and agrees, **server_discover** runs the same read-only commands for them.';

  return `Set up a production deployment to a Plesk server${project}, using the plesk-deploy workflow.

Read the resource plesk-deploy://workflow first. Work through the phases in order, and keep every rule below. When a rule gets in the way, stop and ask the user; don't work around it.

## Rules that are never relaxed

${workflowRules()}

## The phases, and the tools for each

1. **Inspect the project.** Call **inspect_project**${dirArg}, and read plesk-deploy://references/discovery. Show the Deployment facts table, each fact marked verified, reported or unknown.
2. **Inspect the server, read-only.** Call **server_discovery_commands** and give the user the block to run as root. Ask them to redact secrets before pasting. ${server} Add what you learn to the facts table, and correct anything the server contradicts.
3. **Choose the deployment model.** Read plesk-deploy://references/hosting-models. Keep the process manager, proxy, ports and database that already work.
4. **Write the plan and agree it.** Cover the pipeline, the layout on the server, every change (automated or manual, new or changed), migrations, backups, health checks and rollback, what stays the same, and open questions with a recommended answer. **Stop here until the user agrees.** Earlier approval doesn't carry over to production changes they haven't seen.
5. **Build it in the repository.** Read plesk-deploy://references/github-actions and plesk-deploy://references/release-manager. Call **generate_deploy_kit** (a dry run) and show the diff. Write only after the user agrees (\`write: true\`). Never list a file in \`overwrite\` without showing what is there and getting agreement. Then call **validate_deploy_kit** and fix every failure.
6. **Hand over the manual steps,** split into server (as root), Plesk and GitHub. Read plesk-deploy://references/environment-and-database and plesk-deploy://references/security-and-safety. Say where each secret goes (a GitHub environment secret, or a root-owned file on the server). Never ask for its value.
7. **First deploy, verification and a rollback drill.** The user pushes and approves the deploy in GitHub. **github_deploy_runs** follows the run; **deploy_status** and **deploy_logs** read the server. Verify from outside with plesk-deploy://references/verification-checklist. For the drill, call **rollback** only after the user confirms, with confirm "<app>@<host_alias>". Read plesk-deploy://references/troubleshooting when something fails.
8. **Leave it documented** in deploy/plesk/README.md, and point to it from the project's main deployment doc.

Deploys always go through GitHub Actions with a person approving them. Never build or deploy from this machine. Report your work as **done and verified**, **done but not verified** and **the user's to do**, and label each fact verified, reported or assumed.`;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    SETUP_PROMPT,
    {
      title: 'Set up a Plesk deployment',
      description:
        'Walks an agent through the 8 phases of the plesk-deploy workflow: inspect, discover the server read-only, choose a model, agree a plan, build and validate the kit, hand over manual steps, verify the first deploy with a rollback drill, and document it.',
      argsSchema: z.object({
        project_dir: localDir.optional().describe('The project folder (absolute path)'),
        host_alias: hostAlias.optional(),
      }),
    },
    async (args) => ({
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: setupPromptText(args) } },
      ],
    }),
  );
}
