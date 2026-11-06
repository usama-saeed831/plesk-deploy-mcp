/**
 * Strict input validation. Every value that reaches a file, a command line or
 * a remote shell passes one of these schemas first. Anything outside the
 * allowed characters is rejected, never escaped into acceptance.
 */
import path from 'node:path';
import * as z from 'zod';

// Matching control characters is the point: they are rejected.
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

const segmentsAreSafe = (p: string) =>
  p
    .split('/')
    .filter(Boolean)
    .every((s) => s !== '.' && s !== '..');

/** An alias from the user's ~/.ssh/config. No leading "-", no spaces, no "@" or ":". */
export const hostAlias = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'An SSH host alias: letters, digits, ".", "_", "-"')
  .describe('A Host alias from your ~/.ssh/config, listed in PLESK_DEPLOY_SSH_HOSTS');

/** The app's name: picks /usr/local/bin/<app>-deploy and /etc/<app>/. ≤ 24 so <app>-deploy fits a Linux user name. */
export const appName = z
  .string()
  .regex(
    /^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
    'Lowercase letters, digits and "-", starting with a letter, at most 24 characters',
  )
  .describe('The app name used by the release manager (<app>-deploy, /etc/<app>/)');

export const domain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'A lowercase domain name such as example.com (IDN in punycode)',
  )
  .describe('The site domain, e.g. example.com');

export const systemUser = z
  .string()
  .regex(/^[a-z_][a-z0-9_.-]{0,31}$/, 'A Linux user or group name')
  .describe('A Linux user or group name');

export const pm2Name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'A PM2 process name')
  .describe('A PM2 process name');

export const unitName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/, 'A systemd unit name')
  .describe('A systemd unit name, e.g. myapp-api or plesk-php83-fpm');

/** An absolute path on the server. Conservative characters only. */
export const remotePath = z
  .string()
  .max(255)
  .regex(
    /^(?:\/[A-Za-z0-9._@+-]+)+\/?$/,
    'An absolute path with letters, digits and . _ @ + - only (no spaces)',
  )
  .refine(segmentsAreSafe, 'No "." or ".." segments')
  .describe('An absolute path on the server');

/** A path relative to a release, a project or the kit. */
export const relPath = z
  .string()
  .max(255)
  .regex(
    // No leading "-": a path must never be mistaken for a command-line option.
    /^[A-Za-z0-9._@+][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9._@+-]+)*$/,
    'A relative path with letters, digits and . _ @ + - only',
  )
  .refine(segmentsAreSafe, 'No "." or ".." segments')
  .describe('A relative path');

/** An absolute path on this machine (a project folder). */
export const localDir = z
  .string()
  .min(1)
  .max(4096)
  .regex(NO_CONTROL_CHARS, 'No control characters')
  .refine((p) => path.isAbsolute(p), 'An absolute path')
  .describe('An absolute path to a folder on this machine');

/** URL characters that are safe inside single quotes and YAML; no spaces, quotes, "|" or "$". */
const URL_CHARS = /^[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/;

function urlWith(protocols: string[]) {
  return z
    .string()
    .max(2048)
    .regex(URL_CHARS, 'A URL without spaces, quotes, "|", "$" or backslashes')
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return protocols.includes(url.protocol) && !url.username && !url.password && !!url.host;
        } catch {
          return false;
        }
      },
      `A ${protocols.map((p) => p.replace(':', '')).join(' or ')} URL with no credentials`,
    );
}

export const httpUrl = urlWith(['http:', 'https:']).describe('An http(s) URL');
export const httpsUrl = urlWith(['https:']).describe('An https URL');

/** Text a health check must contain: no whitespace, "|" or single quotes (HEALTH_CHECKS format). */
export const healthText = z
  .string()
  .min(1)
  .max(200)
  .regex(
    // eslint-disable-next-line no-control-regex -- control characters are rejected
    /^[^\s|'\\`$\u0000-\u001f\u007f]+$/,
    'No spaces, "|", single quotes, backslashes, "$" or backticks',
  )
  .describe('Text the response must contain, e.g. "status":"ready"');

export const repoSlug = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    'A GitHub repository as owner/name',
  )
  .refine((s) => !['.', '..'].includes(s.split('/')[1] ?? ''), 'Not a repository name')
  .describe('A GitHub repository, owner/name');

export const workflowFile = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\.ya?ml$/, 'A workflow file name such as deploy-plesk.yml')
  .describe('A workflow file name in .github/workflows/');

export const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'An UPPER_CASE environment variable name')
  .describe('An environment variable name (never its value)');

export const gitBranch = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._/-]+$/, 'A branch name')
  .refine(
    (b) =>
      !b.startsWith('-') &&
      !b.startsWith('/') &&
      !b.endsWith('/') &&
      !b.endsWith('.lock') &&
      !b.includes('..') &&
      !b.includes('//'),
    'A valid git branch name',
  )
  .describe('A git branch name');

/**
 * A command that is WRITTEN into a settings file (MIGRATE_CMD and the like),
 * never run by this server. One printable line; it's written single-quoted.
 */
export const shellCommand = z
  .string()
  .min(1)
  .max(1000)
  .regex(NO_CONTROL_CHARS, 'One line, with no control characters')
  .describe('A shell command written into deploy.conf (this server never runs it)');

export const port = z.number().int().min(1).max(65535).describe('A TCP port');

/** Exact, typed parsing for use outside zod-validated tool inputs. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? 'invalid';
    throw new Error(`Invalid ${what}: ${reason}`);
  }
  return result.data;
}
