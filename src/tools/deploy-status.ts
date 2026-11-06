import * as z from 'zod';
import { sshContext } from '../config.js';
import { guarded, textResult } from '../lib/result.js';
import { runRemote } from '../lib/ssh.js';
import { appName, hostAlias } from '../lib/validate.js';
import { DATA_NOTE } from './common.js';
import type { ToolModule } from './index.js';
import { VERIFY_NOTE, assertConnected, parseStatus, releaseManager } from './ssh-common.js';

export const releaseSchema = z.object({
  id: z.string(),
  commit: z.string(),
  live: z.boolean(),
  failed: z.boolean(),
});

export const registerDeployStatus: ToolModule = (server, config) => {
  server.registerTool(
    'deploy_status',
    {
      title: 'Deploy status (SSH)',
      description:
        'Runs `<app>-deploy --status` on the server over the user’s own ssh (a host alias allowed in PLESK_DEPLOY_SSH_HOSTS) and returns the releases, newest first, with their commits, which one is live, and which failed. Read-only; needs no sudo. Use it to see what is deployed, before a rollback (to show the user which release would become live), and after one. ' +
        DATA_NOTE,
      inputSchema: z.object({ host_alias: hostAlias, app: appName }),
      outputSchema: z.object({
        host_alias: z.string(),
        app: z.string(),
        live: releaseSchema.nullable(),
        releases: z.array(releaseSchema),
        raw: z.string(),
      }),
      annotations: {
        title: 'Deploy status (SSH)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(async ({ host_alias, app }, signal) => {
      const r = await runRemote(sshContext(config), host_alias, [releaseManager(app), '--status'], {
        timeoutMs: 30_000,
        signal,
      });
      assertConnected(r, host_alias, app);
      const releases = parseStatus(r.stdout);
      const live = releases.find((x) => x.live) ?? null;
      const text = [
        `## ${app} on "${host_alias}"`,
        '',
        live
          ? `Live: **${live.id}** (commit ${live.commit || 'unknown'})`
          : 'Nothing is live from the release folders yet.',
        '',
        '```',
        r.stdout.trim() || '(no output)',
        '```',
        r.code !== 0 ? `\nThe command exited with ${r.code}: ${r.stderr.trim()}` : '',
        '',
        VERIFY_NOTE,
      ].join('\n');
      return textResult(text, { host_alias, app, live, releases, raw: r.stdout });
    }),
  );
};
