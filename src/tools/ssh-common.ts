import type { RunResult } from '../lib/exec.js';
import { ToolError } from '../lib/result.js';
import { explainSshFailure } from '../lib/ssh.js';

export const releaseManager = (app: string) => `/usr/local/bin/${app}-deploy`;

export interface Release {
  id: string;
  commit: string;
  live: boolean;
  failed: boolean;
}

/** Parses `<app>-deploy --status`: "* 20261106-101500        3f9c2a1" per release, newest first. */
export function parseStatus(text: string): Release[] {
  const releases: Release[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\* | {2})(\d{8}-\d{6}(-failed)?)\s*(\S*)\s*$/.exec(line);
    if (m) releases.push({ id: m[2]!, commit: m[4] ?? '', live: m[1] === '* ', failed: !!m[3] });
  }
  return releases;
}

/**
 * Throws a ToolError for a failure of ssh itself (connection, host key,
 * authentication, sudo password), with a next step. Returns normally when the
 * remote command ran, whatever its exit code.
 */
export function assertConnected(result: RunResult, alias: string, app?: string): void {
  if (result.startError || result.code === 255 || (result.timedOut && !result.stillRunning)) {
    const why = explainSshFailure(result, alias) ?? `ssh to "${alias}" failed.`;
    const said = result.stderr.trim().split('\n').slice(-2).join(' ');
    throw new ToolError(said ? `${why}\nssh said: ${said}` : why);
  }
  if (/sudo: (?:a password is required|a terminal is required)/.test(result.stderr)) {
    throw new ToolError(
      explainSshFailure({ ...result, code: 1 }, alias) ?? 'sudo asked for a password.',
    );
  }
  if (app) {
    const missing =
      result.code === 127 ||
      (/(?:No such file or directory|command not found)/.test(result.stderr) &&
        result.stderr.includes(releaseManager(app)));
    if (missing) {
      throw new ToolError(
        `There is no release manager at ${releaseManager(app)} on "${alias}". It is installed by server-setup.sh (phase 6).`,
      );
    }
    if (/No settings at \/etc\//.test(result.stdout + result.stderr)) {
      throw new ToolError(
        `The release manager on "${alias}" has no /etc/${app}/deploy.conf yet. Run server-setup.sh first.`,
      );
    }
  }
}

export const VERIFY_NOTE =
  'This reads the server only. A deploy or rollback counts as working once the live URL, checked from outside through Plesk, reports the expected commit.';
