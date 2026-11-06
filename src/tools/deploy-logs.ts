import * as z from 'zod';
import { sshContext } from '../config.js';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { runRemote } from '../lib/ssh.js';
import { appName, hostAlias } from '../lib/validate.js';
import { DATA_NOTE } from './common.js';
import type { ToolModule } from './index.js';
import { assertConnected, releaseManager } from './ssh-common.js';

export const registerDeployLogs: ToolModule = (server, config) => {
  server.registerTool(
    'deploy_logs',
    {
      title: 'Deploy log (SSH)',
      description:
        'Returns the last lines of the release manager’s deploy log on the server, through `sudo -n <app>-deploy --log <lines>` over the user’s own ssh (a host alias allowed in PLESK_DEPLOY_SSH_HOSTS). It goes through the deploy account’s single sudo rule, because the log is root-only. Values that look like secrets are redacted. Read-only. Use it when a deploy or rollback failed, to read what the release manager did. ' +
        DATA_NOTE,
      inputSchema: z.object({
        host_alias: hostAlias,
        app: appName,
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('How many lines from the end'),
      }),
      outputSchema: z.object({
        host_alias: z.string(),
        app: z.string(),
        lines: z.array(z.string()),
      }),
      annotations: {
        title: 'Deploy log (SSH)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(async ({ host_alias, app, lines }, signal) => {
      const r = await runRemote(
        sshContext(config),
        host_alias,
        ['sudo', '-n', releaseManager(app), '--log', String(lines)],
        { timeoutMs: 30_000, signal },
      );
      assertConnected(r, host_alias, app);
      if (
        r.code === 2 &&
        /<bundle\.tgz>/.test(r.stdout + r.stderr) &&
        !/--log/.test(r.stdout + r.stderr)
      ) {
        throw new ToolError(
          `The release manager on "${host_alias}" predates --log. Re-run server-setup.sh with the current kit to update it, or read the log as root: sudo tail -n ${lines} /var/log/${app}-deploy.log`,
        );
      }
      if (r.code !== 0)
        throw new ToolError(
          `The log could not be read (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
        );
      const out = r.stdout.replace(/\n$/, '').split('\n');
      const text = [
        `## Deploy log of ${app} on "${host_alias}" (last ${out.length} lines)`,
        '',
        DATA_NOTE,
        '',
        '```',
        r.stdout.trim(),
        '```',
      ].join('\n');
      return textResult(text, { host_alias, app, lines: out });
    }),
  );
};
