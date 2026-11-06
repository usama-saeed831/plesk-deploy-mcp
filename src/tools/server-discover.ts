import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import { sshContext } from '../config.js';
import {
  type DiscoveryCommand,
  SECTIONS,
  discoveryCommands,
  lookingFor,
  sectionTitle,
} from '../discovery/commands.js';
import { shQuote } from '../lib/quote.js';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { runRemote } from '../lib/ssh.js';
import { hostAlias } from '../lib/validate.js';
import { DATA_NOTE } from './common.js';
import type { ToolModule } from './index.js';
import { discoveryInput } from './server-discovery-commands.js';
import { assertConnected } from './ssh-common.js';

const PER_COMMAND_SECONDS = 20;
const MAX_SECTION_CHARS = 20_000;

/**
 * One script for one SSH session: each allowlisted command runs under
 * `timeout`, with stdin closed (so it can't read the rest of the script), its
 * output framed by markers that carry a random nonce (so output can't fake
 * a frame).
 */
export function discoveryScript(commands: DiscoveryCommand[], nonce: string): string {
  const lines = [
    'T=',
    `if command -v timeout >/dev/null 2>&1; then T='timeout ${PER_COMMAND_SECONDS}'; fi`,
  ];
  for (const c of commands) {
    lines.push(
      `printf '%s\\n' ${shQuote(`@@${nonce}:begin:${c.id}`)}`,
      `$T sh -c ${shQuote(c.command)} </dev/null 2>&1`,
      `printf '\\n%s:%s\\n' ${shQuote(`@@${nonce}:end:${c.id}`)} "$?"`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function parseDiscoveryOutput(
  output: string,
  nonce: string,
): Map<string, { output: string; exit_code: number }> {
  const results = new Map<string, { output: string; exit_code: number }>();
  const re = new RegExp(
    `^@@${nonce}:begin:([A-Za-z0-9._-]+)\\n([\\s\\S]*?)\\n@@${nonce}:end:\\1:(\\d+)$`,
    'gm',
  );
  for (const m of output.matchAll(re)) {
    let text = m[2]!.replace(/\n$/, '');
    if (text.length > MAX_SECTION_CHARS)
      text = `${text.slice(0, MAX_SECTION_CHARS)}\n[… cut at ${MAX_SECTION_CHARS} characters]`;
    results.set(m[1]!, { output: text, exit_code: Number(m[3]) });
  }
  return results;
}

export const registerServerDiscover: ToolModule = (server, config) => {
  server.registerTool(
    'server_discover',
    {
      title: 'Discover the server (read-only, SSH)',
      description:
        'Runs the fixed, read-only discovery commands (the same ones server_discovery_commands lists) on the Plesk server over the user’s own ssh, through a ~/.ssh/config host alias the user allowed in PLESK_DEPLOY_SSH_HOSTS. It can’t run any other command. Values that look like secrets are redacted from the output, and env files are listed by name only. Use it in phase 2, after the user agrees, instead of asking them to paste the output. sudo: true runs the commands as root through `sudo -n` (only if that account has password-less sudo); otherwise they run as the alias’s user and some may be denied. ' +
        DATA_NOTE,
      inputSchema: z.object({
        host_alias: hostAlias,
        ...discoveryInput,
        sudo: z.boolean().default(false).describe('Run the commands as root with sudo -n'),
        sections: z
          .array(z.enum(SECTIONS as [string, ...string[]]))
          .optional()
          .describe('Only these sections'),
      }),
      outputSchema: z.object({
        host_alias: z.string(),
        sudo: z.boolean(),
        results: z.array(
          z.object({
            id: z.string(),
            section: z.string(),
            purpose: z.string(),
            command: z.string(),
            exit_code: z.number().nullable(),
            output: z.string(),
          }),
        ),
        skipped: z.array(z.object({ id: z.string(), missing: z.array(z.string()) })),
      }),
      annotations: {
        title: 'Discover the server (read-only, SSH)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(async (args, signal) => {
      const { host_alias, sudo, sections, ...params } = args;
      const all = discoveryCommands(params).filter(
        (c) => !sections || sections.includes(c.section),
      );
      const runnable = all.filter((c) => c.missing.length === 0);
      const skipped = all
        .filter((c) => c.missing.length > 0)
        .map((c) => ({ id: c.id, missing: c.missing }));
      if (runnable.length === 0)
        throw new ToolError(
          'Nothing to run: every selected command needs a value that was not given.',
        );

      const nonce = randomBytes(8).toString('hex');
      const result = await runRemote(
        sshContext(config),
        host_alias,
        sudo ? ['sudo', '-n', 'sh', '-s'] : ['sh', '-s'],
        {
          input: discoveryScript(runnable, nonce),
          timeoutMs: 120_000,
          maxOutputBytes: 2 * 1024 * 1024,
          signal,
        },
      );
      assertConnected(result, host_alias);
      const parsed = parseDiscoveryOutput(result.stdout, nonce);
      if (parsed.size === 0) {
        throw new ToolError(
          `The commands did not run on "${host_alias}"${result.stderr ? `: ${result.stderr.trim().split('\n').slice(-2).join(' ')}` : '.'}`,
        );
      }
      const results = runnable.map((c) => ({
        id: c.id,
        section: c.section,
        purpose: c.purpose,
        command: c.command,
        exit_code: parsed.get(c.id)?.exit_code ?? null,
        output: parsed.get(c.id)?.output ?? '(no output: the session ended before this command)',
      }));

      const text: string[] = [
        `## Server discovery on "${host_alias}"${sudo ? ' (as root)' : ''}`,
        '',
        DATA_NOTE,
        '',
      ];
      for (const section of SECTIONS) {
        const inSection = results.filter((r) => r.section === section);
        if (!inSection.length) continue;
        text.push(`### ${sectionTitle(section)}`);
        for (const r of inSection) {
          text.push(
            `**${r.purpose}** (exit ${r.exit_code ?? 'none'})`,
            '```',
            `$ ${r.command}`,
            r.output || '(no output)',
            '```',
          );
        }
      }
      if (skipped.length)
        text.push(
          '',
          `Skipped (a value was not given): ${skipped.map((s) => `${s.id} (${s.missing.join(', ')})`).join('; ')}.`,
        );
      if (result.truncated) text.push('', 'The output was longer than 2 MB and was cut.');
      text.push(
        '',
        '**What you are looking for** (from the discovery reference):',
        '',
        lookingFor(),
        '',
        'Add these to the Deployment facts table as *reported* (from the server), and correct any fact they contradict.',
      );
      return textResult(text.join('\n'), { host_alias, sudo, results, skipped });
    }),
  );
};
