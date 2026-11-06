/**
 * POSIX shell quoting. ssh always hands the remote command to a shell as one
 * string, so argument arrays can't be passed through intact. Every value is
 * validated by a strict schema first (lib/validate.ts) and then quoted here,
 * as defence in depth.
 */

// No "=" (a first word like A=b would be read as an assignment) and no "~".
const SAFE_WORD = /^[A-Za-z0-9_@%+:,./-]+$/;

/** Quote one word for a POSIX shell. */
export function shQuote(word: string): string {
  if (word.includes('\0')) throw new Error('A shell word cannot contain a NUL byte');
  if (word !== '' && SAFE_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Quote every word and join them into one command line. */
export function shJoin(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('An empty command');
  return argv.map(shQuote).join(' ');
}
