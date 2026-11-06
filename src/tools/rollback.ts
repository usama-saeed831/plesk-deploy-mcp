import * as z from 'zod';
import { sshContext } from '../config.js';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { type SshContext, runRemote } from '../lib/ssh.js';
import { appName, hostAlias } from '../lib/validate.js';
import { DATA_NOTE } from './common.js';
import type { ToolModule } from './index.js';
import { releaseSchema } from './deploy-status.js';
import { type Release, assertConnected, parseStatus, releaseManager } from './ssh-common.js';

async function liveRelease(
  ctx: SshContext,
  alias: string,
  app: string,
  signal: AbortSignal,
): Promise<Release | null> {
  const r = await runRemote(ctx, alias, [releaseManager(app), '--status'], {
    timeoutMs: 30_000,
    signal,
  });
  assertConnected(r, alias, app);
  return parseStatus(r.stdout).find((x) => x.live) ?? null;
}

export const registerRollback: ToolModule = (server, config) => {
  server.registerTool(
    'rollback',
    {
      title: 'Roll back to the previous release (SSH)',
      description:
        'DESTRUCTIVE: makes the previous good release live again on the server by running `sudo -n <app>-deploy --rollback` over the user’s own ssh (a host alias allowed in PLESK_DEPLOY_SSH_HOSTS). The release manager switches `current` back, reloads the processes and checks health. Migrations are NOT undone. Call it only after the user explicitly confirms. Show them deploy_status first, so they know which release becomes live. confirm must be exactly "<app>@<host_alias>", or nothing runs. A rollback that outlasts timeout_seconds keeps running on the server (it is never interrupted halfway); check deploy_status afterwards. ' +
        DATA_NOTE,
      inputSchema: z.object({
        host_alias: hostAlias,
        app: appName,
        confirm: z
          .string()
          .max(100)
          .describe('Exactly "<app>@<host_alias>", typed after the user confirmed'),
        timeout_seconds: z.number().int().min(60).max(1800).default(600),
      }),
      outputSchema: z.object({
        host_alias: z.string(),
        app: z.string(),
        before: releaseSchema.nullable(),
        after: releaseSchema.nullable(),
        exit_code: z.number().nullable(),
        still_running: z.boolean(),
        output: z.string(),
      }),
      annotations: {
        title: 'Roll back to the previous release (SSH)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(async ({ host_alias, app, confirm, timeout_seconds }, signal) => {
      const expected = `${app}@${host_alias}`;
      if (confirm !== expected) {
        throw new ToolError(
          `Not rolled back: confirm must be exactly "${expected}", after the user agreed. Nothing was run.`,
        );
      }
      const ctx = sshContext(config);
      const before = await liveRelease(ctx, host_alias, app, signal);
      const r = await runRemote(
        ctx,
        host_alias,
        ['sudo', '-n', releaseManager(app), '--rollback'],
        {
          timeoutMs: timeout_seconds * 1000,
          maxOutputBytes: 512 * 1024,
          signal,
          // An interrupted rollback is worse than a slow one: never kill it.
          detachOnTimeout: true,
        },
      );
      if (r.stillRunning) {
        return textResult(
          [
            `## Rollback of ${app} on "${host_alias}" is still running`,
            '',
            `It didn't finish within ${timeout_seconds}s (or the request was cancelled), and it was left running on the server rather than interrupted. Check deploy_status and deploy_logs in a minute.`,
          ].join('\n'),
          {
            host_alias,
            app,
            before,
            after: null,
            exit_code: null,
            still_running: true,
            output: r.stdout,
          },
        );
      }
      assertConnected(r, host_alias, app);
      const after = await liveRelease(ctx, host_alias, app, signal).catch(() => null);
      const ok = r.code === 0;
      const text = [
        ok
          ? `## Rolled back ${app} on "${host_alias}"`
          : `## The rollback of ${app} on "${host_alias}" failed (exit ${r.code})`,
        '',
        `Live before: ${before ? `${before.id} (${before.commit || 'unknown'})` : 'nothing'}`,
        `Live now: ${after ? `${after.id} (${after.commit || 'unknown'})` : 'unknown'}`,
        '',
        DATA_NOTE,
        '',
        '```',
        (r.stdout + r.stderr).trim() || '(no output)',
        '```',
        '',
        'Migrations were not undone: the previous release now runs on the current schema.',
        ok
          ? `Verify from outside: the public health URL must report ${after?.commit || 'the previous commit'}. Then fix forward through the pipeline.`
          : 'Read the release manager’s message above and deploy_logs. Nothing is verified until the live URL answers from outside.',
      ].join('\n');
      return textResult(text, {
        host_alias,
        app,
        before,
        after,
        exit_code: r.code,
        still_running: false,
        output: r.stdout + r.stderr,
      });
    }),
  );
};
