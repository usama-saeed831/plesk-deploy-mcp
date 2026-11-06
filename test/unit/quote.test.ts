import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shJoin, shQuote } from '../../src/lib/quote.js';
import { INJECTION_CORPUS } from '../fixtures/injection.js';

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

/** What a POSIX shell turns the joined command line back into. */
function throughShell(words: string[]): string[] {
  // "--" stops node reading a word such as "-oProxyCommand=…" as its own option.
  const line = shJoin([process.execPath, '-e', ECHO_ARGV, '--', ...words]);
  const sh = spawnSync('/bin/sh', ['-c', line], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  expect(sh.status, sh.stderr).toBe(0);
  return JSON.parse(sh.stdout) as string[];
}

describe('shQuote', () => {
  it('leaves plain words alone and quotes everything else', () => {
    expect(shQuote('/usr/local/bin/myapp-deploy')).toBe('/usr/local/bin/myapp-deploy');
    expect(shQuote('--status')).toBe('--status');
    expect(shQuote('a b')).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote('')).toBe("''");
    expect(shQuote('A=b')).toBe("'A=b'");
    expect(shQuote('~root')).toBe("'~root'");
  });

  it('refuses NUL bytes and empty commands', () => {
    expect(() => shQuote('a\u0000b')).toThrow(/NUL/);
    expect(() => shJoin([])).toThrow(/empty/);
  });
});

describe.skipIf(process.platform === 'win32')('a POSIX shell gets back exactly the words', () => {
  const words = INJECTION_CORPUS.filter((s) => !s.includes('\u0000'));
  it('for the whole injection corpus at once', () => {
    expect(throughShell([...words])).toEqual(words);
  });
  it('for each word on its own', () => {
    for (const w of words) expect(throughShell([w])).toEqual([w]);
  });
});
