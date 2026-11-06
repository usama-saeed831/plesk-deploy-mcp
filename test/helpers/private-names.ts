import { createHash } from 'node:crypto';

/**
 * SHA-256 hashes of names that must never appear in this public repository
 * or its package (the private production system the skill was distilled
 * from). Only hashes are stored, so the check doesn't publish the names.
 * This prevents accidents; it isn't meant to keep the names secret.
 *
 * Add one with: printf '%s' <lowercase word> | shasum -a 256
 */
const DENIED = new Set(['c620110ec8885bb880996ac34646d337457018fbac08e7915a64483d4feb7635']);

const sha256 = (word: string) => createHash('sha256').update(word).digest('hex');

/** Words split on punctuation and camelCase, lowercased and de-duplicated. */
export function words(text: string): Set<string> {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return new Set(spaced.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** How many denied words the text contains (never which, to avoid echoing them). */
export function countDeniedWords(text: string): number {
  let count = 0;
  for (const word of words(text)) if (DENIED.has(sha256(word))) count++;
  return count;
}
