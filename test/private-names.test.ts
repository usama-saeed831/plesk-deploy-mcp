import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countDeniedWords, words } from './helpers/private-names.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function trackedFiles(): string[] {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status !== 0) return [];
  return git.stdout.split('\0').filter(Boolean);
}

describe('private names', () => {
  it('splits words on punctuation and camelCase', () => {
    expect([...words('reference-implementation-fooBar.md')]).toEqual([
      'reference',
      'implementation',
      'foo',
      'bar',
      'md',
    ]);
  });

  const files = trackedFiles();

  it.skipIf(files.length === 0)('appear in no tracked file of this repository', () => {
    const offending = files.filter((file) => {
      const buffer = readFileSync(path.join(ROOT, file));
      if (buffer.includes(0)) return false; // binary
      return countDeniedWords(buffer.toString('utf8')) > 0;
    });
    expect(offending).toEqual([]);
  });
});
