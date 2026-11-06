import * as z from 'zod';
import { commandBlock, discoveryCommands, lookingFor } from '../discovery/commands.js';
import { guarded, textResult } from '../lib/result.js';
import { appName, domain, pm2Name, remotePath, systemUser } from '../lib/validate.js';
import type { ToolModule } from './index.js';

export const discoveryInput = {
  domain,
  app: appName.optional(),
  system_user: systemUser
    .optional()
    .describe("The domain's system user (Plesk subscription), if known"),
  pm2_processes: z.array(pm2Name).max(10).optional().describe('PM2 process names, if known'),
  app_dir: remotePath.optional().describe('The folder the app runs from today, if known'),
  env_file: remotePath
    .optional()
    .describe("The path of the app's current .env on the server, if known"),
};

export const registerServerDiscoveryCommands: ToolModule = (server) => {
  server.registerTool(
    'server_discovery_commands',
    {
      title: 'Read-only server commands to run',
      description:
        'Returns the block of read-only commands for the user to run as root on the Plesk server and paste back (phase 2): Plesk and OS, who runs the app (PM2 as root and as the domain user, systemd), listening ports and nginx directives, the document root, git status of the app folder, env file NAMES only, databases, crontabs, and whether .env/.git are exposed. Values you know are filled in; unknown ones stay as <placeholders>. It runs nothing and connects to nothing. Use it when you can’t reach the server yourself, or before server_discover.',
      inputSchema: z.object(discoveryInput),
      outputSchema: z.object({
        block: z.string(),
        commands: z.array(
          z.object({
            id: z.string(),
            section: z.string(),
            purpose: z.string(),
            command: z.string(),
            missing: z.array(z.string()),
          }),
        ),
      }),
      annotations: {
        title: 'Read-only server commands to run',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const commands = discoveryCommands(args);
      const block = commandBlock(commands);
      const placeholders = [...new Set(commands.flatMap((c) => c.missing))];
      const text = [
        `Ask the user to run these **read-only** commands **as root** on the server for ${args.domain}, and to paste the output back. **Ask them to remove any secret before pasting.** Nothing here changes the server.`,
        '',
        '```bash',
        block,
        '```',
        '',
        placeholders.length
          ? `Fill in or skip the lines with <placeholders> (${placeholders.join(', ')}).`
          : 'Every value is filled in.',
        '',
        '**What you are looking for** (from the discovery reference):',
        '',
        lookingFor(),
        '',
        'Add what you learn to the Deployment facts table as *reported*, and correct any fact the server contradicts.',
      ].join('\n');
      return textResult(text, { block, commands });
    }),
  );
};
