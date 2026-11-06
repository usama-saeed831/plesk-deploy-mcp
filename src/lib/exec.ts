/**
 * Runs a program with an argument array (never a shell), a hard timeout, an
 * output cap and an explicit environment.
 */
import { spawn } from 'node:child_process';

export interface RunOptions {
  /** The complete environment for the child. Nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  timeoutMs: number;
  /** Bytes kept per stream; the rest is read and dropped. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * Leave the child running when the timeout fires or the caller aborts, and
   * resolve with `stillRunning: true`. Used for a rollback, which must not be
   * interrupted halfway. The output is still drained, so the child never
   * blocks on a full pipe.
   */
  detachOnTimeout?: boolean;
}

export interface RunResult {
  /** Exit code, or null when the process was killed, detached or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stillRunning: boolean;
  truncated: boolean;
  /** Set when the program could not be started (for example ENOENT). */
  startError?: string;
  durationMs: number;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const KILL_GRACE_MS = 2000;

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const size = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const collect = (chunks: Buffer[], key: 'out' | 'err') => (chunk: Buffer) => {
      const room = max - size[key];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      chunks.push(kept);
      size[key] += kept.length;
    };
    child.stdout.on('data', collect(stdout, 'out'));
    child.stderr.on('data', collect(stderr, 'err'));

    const finish = (partial: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        aborted,
        stillRunning: false,
        truncated,
        durationMs: Date.now() - started,
        ...partial,
      });
    };

    const stop = () => {
      if (options.detachOnTimeout) {
        finish({ stillRunning: true });
        return;
      }
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ startError: error.code === 'ENOENT' ? `${command} was not found` : error.message });
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      finish({ code, signal });
    });

    child.stdin.on('error', () => {
      /* the child exited before reading its input */
    });
    child.stdin.end(options.input ?? '');
  });
}

/**
 * The environment a child gets: only what it needs to find programs, the
 * user's home (for ~/.ssh) and the SSH agent. Tokens in the server's own
 * environment never reach ssh, so a `SendEnv` line can't leak them.
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SSH_AUTH_SOCK',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    // Windows
    'SystemRoot',
    'SYSTEMROOT',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'PATHEXT',
    'TEMP',
    'TMP',
    'ComSpec',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
