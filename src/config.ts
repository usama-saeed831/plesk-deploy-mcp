/**
 * Configuration comes from the environment only, set by the user in their MCP
 * client's configuration. No tool can change it.
 */
import path from 'node:path';
import { minimalEnv } from './lib/exec.js';
import type { SshContext } from './lib/ssh.js';
import { hostAlias } from './lib/validate.js';

export interface Config {
  /** Aliases from PLESK_DEPLOY_SSH_HOSTS that are well-formed. Empty: the SSH tools are off. */
  allowedHosts: string[];
  /** Entries of PLESK_DEPLOY_SSH_HOSTS that were ignored because they aren't valid aliases. */
  ignoredHosts: string[];
  sshBin: string;
  /** The environment ssh and local helper programs run with. */
  childEnv: NodeJS.ProcessEnv;
  /** Read-only GitHub token for github_deploy_runs (PLESK_DEPLOY_GITHUB_TOKEN). */
  githubToken?: string;
  /** Default project folder for the local tools (Claude Code sets CLAUDE_PROJECT_DIR). */
  defaultProjectDir?: string;
  /** Injected in tests; the real fetch otherwise. Only api.github.com is ever called. */
  fetch: typeof fetch;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Commas only: a malformed entry such as "bad alias!" is ignored whole,
  // never split into a different alias that the user didn't mean to allow.
  const entries = (env.PLESK_DEPLOY_SSH_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedHosts = [...new Set(entries.filter((e) => hostAlias.safeParse(e).success))];
  const ignoredHosts = entries.filter((e) => !hostAlias.safeParse(e).success);

  const projectDir = env.CLAUDE_PROJECT_DIR;
  const token = env.PLESK_DEPLOY_GITHUB_TOKEN?.trim();

  return {
    allowedHosts,
    ignoredHosts,
    sshBin: env.PLESK_DEPLOY_SSH_BIN?.trim() || 'ssh',
    childEnv: minimalEnv(env),
    githubToken: token ? token : undefined,
    defaultProjectDir: projectDir && path.isAbsolute(projectDir) ? projectDir : undefined,
    fetch: globalThis.fetch,
  };
}

export function sshContext(config: Config): SshContext {
  return { sshBin: config.sshBin, allowedHosts: config.allowedHosts, env: config.childEnv };
}
