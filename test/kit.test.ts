import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIT_ROOT, kitPath } from '../src/kit.js';
import { countDeniedWords } from './helpers/private-names.js';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(KIT_ROOT).map((f) => path.relative(KIT_ROOT, f).split(path.sep).join('/'));

describe('vendored kit', () => {
  it('has the workflow, the references, the templates and the test script', () => {
    expect(files).toContain('SKILL.md');
    expect(files).toContain('scripts/test-release-manager.sh');
    expect(files.filter((f) => f.startsWith('references/'))).toHaveLength(10);
    expect(files.filter((f) => f.startsWith('templates/'))).toHaveLength(12);
    expect(files).toContain('references/worked-example.md');
  });

  it('never ships the private reference implementation', () => {
    expect(files.some((f) => /reference-implementation/i.test(f))).toBe(false);
    for (const f of files) {
      expect(countDeniedWords(readFileSync(kitPath(f), 'utf8')), f).toBe(0);
    }
  });

  it('keeps every rule that is never relaxed', () => {
    const skill = readFileSync(kitPath('SKILL.md'), 'utf8');
    expect(skill).toContain('## Rules that are never relaxed');
    for (let rule = 1; rule <= 10; rule++)
      expect(skill).toMatch(new RegExp(`^${rule}\\. \\*\\*`, 'm'));
  });

  it('refuses paths that escape the kit', () => {
    expect(() => kitPath('..', 'package.json')).toThrow(/escapes/);
  });
});
