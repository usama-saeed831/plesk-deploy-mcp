/**
 * Bounded, symlink-free access to a project folder.
 */
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Folders that never hold deployment facts (and are often huge). */
export const SKIPPED_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'tmp',
  'logs',
]);

/** Real env files: their names may be reported, their contents are never read. */
export function isRealEnvFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  if (base !== '.env' && !base.startsWith('.env.')) return false;
  return !/\.(example|sample|dist|template|defaults)$/i.test(base);
}

export function isEnvExampleFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  return (
    (base === '.env' || base.startsWith('.env.')) && /\.(example|sample|dist|template)$/i.test(base)
  );
}

export interface WalkResult {
  /** Relative POSIX paths of regular files. */
  files: string[];
  truncated: boolean;
}

export async function walkProject(
  root: string,
  { maxFiles = 5000, maxDepth = 8 }: { maxFiles?: number; maxDepth?: number } = {},
): Promise<WalkResult> {
  const files: string[] = [];
  let truncated = false;
  const queue: [string, number][] = [['', 0]];
  while (queue.length > 0) {
    const [dir, depth] = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || depth + 1 > maxDepth) continue;
        // Laravel's compiled views and caches.
        if (!rel.endsWith('storage/framework')) queue.push([rel, depth + 1]);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return { files, truncated };
        }
        files.push(rel);
      }
    }
  }
  return { files, truncated };
}

/**
 * Reads a small text file inside the root. Refuses symlinks, real env files,
 * files over the limit, and anything that resolves outside the root.
 */
export async function readSmall(
  root: string,
  rel: string,
  maxBytes = 512 * 1024,
): Promise<string | undefined> {
  if (isRealEnvFile(rel)) return undefined;
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return undefined;
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(full, 'utf8');
  } catch {
    return undefined;
  }
}

/** Resolves a project folder: absolute, existing, a directory, symlinks resolved. */
export async function resolveProjectDir(dir: string): Promise<string> {
  if (!path.isAbsolute(dir)) throw new Error(`project_dir must be an absolute path: ${dir}`);
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new Error(`There is no folder at ${dir}.`);
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`${dir} is not a folder.`);
  if (real === path.parse(real).root)
    throw new Error('project_dir cannot be the root of the file system.');
  return real;
}
