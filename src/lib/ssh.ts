/**
 * SSH through the user's own `ssh`, ~/.ssh/config alias, agent and
 * known_hosts. This module never accepts a key, a password or a host name
 * that isn't an allowlisted alias, and never runs a command it didn't build
 * from a fixed template.
 */
import { run, type RunResult } from './exec.js';
import { shJoin } from './quote.js';
import { hostAlias } from './validate.js';

/**
 * Options given on the command line take precedence over ~/.ssh/config, so
 * these hold whatever the user's config says:
 * - host keys are always checked against known_hosts, and never added;
 * - no password or passphrase prompt (the agent or an unencrypted key only);
 * - no agent, X11 or port forwarding, and no LocalCommand.
 */
export const SSH_OPTIONS: readonly string[] = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'RequestTTY=no',
  '-o',
  'LogLevel=ERROR',
];

export interface SshContext {
  /** The ssh program. */
  sshBin: string;
  /** Aliases the user allowed in PLESK_DEPLOY_SSH_HOSTS. */
  allowedHosts: readonly string[];
  /** The environment ssh runs with (see exec.minimalEnv). */
  env: NodeJS.ProcessEnv;
}

export class SshNotAllowedError extends Error {}

/** Throws unless the alias is well-formed and allowlisted. */
export function assertHostAllowed(ctx: SshContext, alias: string): void {
  if (!hostAlias.safeParse(alias).success) {
    throw new SshNotAllowedError(`"${alias}" is not a valid SSH host alias.`);
  }
  if (ctx.allowedHosts.length === 0) {
    throw new SshNotAllowedError(
      'The server tools are off. To turn them on for a host, set PLESK_DEPLOY_SSH_HOSTS to its ~/.ssh/config alias ' +
        '(for example PLESK_DEPLOY_SSH_HOSTS=myserver) in this MCP server’s configuration, then restart it.',
    );
  }
  if (!ctx.allowedHosts.includes(alias)) {
    throw new SshNotAllowedError(
      `"${alias}" is not in PLESK_DEPLOY_SSH_HOSTS (${ctx.allowedHosts.join(', ')}). Only listed aliases can be reached.`,
    );
  }
}

/** The complete argv for ssh: fixed options, "--", the alias, one quoted remote command. */
export function buildSshArgs(alias: string, remoteArgv: readonly string[]): string[] {
  if (!hostAlias.safeParse(alias).success)
    throw new SshNotAllowedError(`"${alias}" is not a valid SSH host alias.`);
  return [...SSH_OPTIONS, '--', alias, shJoin(remoteArgv)];
}

export interface RemoteRunOptions {
  timeoutMs: number;
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  detachOnTimeout?: boolean;
}

export async function runRemote(
  ctx: SshContext,
  alias: string,
  remoteArgv: readonly string[],
  options: RemoteRunOptions,
): Promise<RunResult> {
  assertHostAllowed(ctx, alias);
  return run(ctx.sshBin, buildSshArgs(alias, remoteArgv), { env: ctx.env, ...options });
}

/** A plain-language next step for the usual SSH failures, or undefined. */
export function explainSshFailure(result: RunResult, alias: string): string | undefined {
  if (result.startError) {
    return `${result.startError}. Install OpenSSH, or set PLESK_DEPLOY_SSH_BIN to the ssh program.`;
  }
  const err = result.stderr;
  if (
    /Host key verification failed|No .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      err,
    )
  ) {
    return (
      `The server's host key for "${alias}" isn't in your known_hosts, or it changed. ` +
      'This server never adds host keys. Connect once yourself (ssh ' +
      alias +
      '), compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server, and accept it only if they match.'
    );
  }
  if (/Permission denied \(publickey/i.test(err)) {
    return `The server refused the key for "${alias}". Check that your ssh-agent holds the key (ssh-add -l) and that ~/.ssh/config gives the right User and IdentityFile. Passphrase prompts are disabled here, so an encrypted key must be in the agent.`;
  }
  if (/Could not resolve hostname/i.test(err)) {
    return `"${alias}" doesn't resolve. Add a Host ${alias} entry with its HostName to ~/.ssh/config.`;
  }
  if (/Connection timed out|Operation timed out|Connection refused|No route to host/i.test(err)) {
    return `The server for "${alias}" didn't answer on its SSH port. Check the address, the port in ~/.ssh/config, and any firewall or IP allowlist.`;
  }
  if (/sudo: (?:a password is required|a terminal is required)/i.test(err)) {
    return 'sudo asked for a password, and this server never types one. Use an alias that signs in as the deploy user (its sudo rule allows the release manager without a password) or as root.';
  }
  if (result.timedOut) return `ssh to "${alias}" didn't finish in time.`;
  if (result.code === 255) return `ssh to "${alias}" failed before the command ran.`;
  return undefined;
}
