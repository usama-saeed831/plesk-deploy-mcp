import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Builds dist/ once, so tests can run the real binary. TypeScript 7 does it in well under a second. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '../..');
  const tsc = path.join(root, 'node_modules', 'typescript-7', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Build failed:\n${result.stdout}\n${result.stderr}`);
  }
}
