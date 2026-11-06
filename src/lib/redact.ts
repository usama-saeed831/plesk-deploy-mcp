/**
 * Redacts values that look like secrets from every tool result. It is a
 * heuristic second line of defence: tools are designed never to read secrets
 * in the first place (env files are listed by name only, for example).
 *
 * A redacted value becomes "[REDACTED:<kind>]". The value itself is never
 * logged, counted by content or echoed anywhere.
 */

export interface RedactionResult {
  text: string;
  count: number;
  kinds: Record<string, number>;
}

type Rule = {
  kind: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
};

const R = (kind: string) => `[REDACTED:${kind}]`;

/** Names whose values are secrets: DB_PASSWORD, GITHUB_TOKEN, STRIPE_SECRET_KEY, ... */
const SECRET_NAME =
  /(pass(?:word|wd|phrase)?|pwd|secret|token|api[_.-]?key|apikey|access[_.-]?key|private[_.-]?key|client[_.-]?secret|credential|salt|cookie|signing|dsn|encryption[_.-]?key|(?:^|[_.-])key$|(?:^|[_.-])auth(?:$|[_.-])|database[_.-]?url|redis[_.-]?url|mongo(?:db)?[_.-]?ur[il]|amqp[_.-]?url|^sig$|^signature$)/i;

/** Values that are not secrets themselves: empty, <set>, ${{ secrets.X }}, $VAR, ***, already redacted. */
const PLACEHOLDER =
  /^(?:|<[^<>]*>|\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\*+|\[REDACTED:[a-z-]+\]|x{3,}|changeme|null|none|true|false)$/i;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

const isSecretValue = (name: string, value: string) =>
  SECRET_NAME.test(name) && !PLACEHOLDER.test(unquote(value));

const RULES: Rule[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => R('private-key'),
  },
  {
    kind: 'url-password',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"]+):([^\s@/'"]+)@/gi,
    replace: (_m, scheme: string, user: string, pass: string) =>
      PLACEHOLDER.test(pass) ? _m : `${scheme}${user}:${R('url-password')}@`,
  },
  {
    // Authorization: Bearer x / authorization=x (the scheme is optional after ":" or "=").
    kind: 'authorization',
    pattern:
      /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest)\s+)?([^\s"',;]+)/gi,
    replace: (m, head: string, scheme: string | undefined, value: string) =>
      PLACEHOLDER.test(value) ? m : `${head}${scheme ?? ''}${R('authorization')}`,
  },
  {
    // nginx: proxy_set_header Authorization "Bearer x"; (needs the scheme, so prose is left alone).
    kind: 'authorization',
    pattern: /\b((?:proxy-)?authorization\s+["']?)((?:bearer|basic|token|digest)\s+)([^\s"',;]+)/gi,
    replace: (m, head: string, scheme: string, value: string) =>
      PLACEHOLDER.test(value) ? m : `${head}${scheme}${R('authorization')}`,
  },
  // Known token formats, wherever they appear.
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    replace: () => R('github-token'),
  },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => R('npm-token') },
  {
    kind: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => R('slack-token'),
  },
  { kind: 'aws-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: () => R('aws-key') },
  {
    kind: 'stripe-key',
    pattern: /\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,})\b/g,
    replace: () => R('stripe-key'),
  },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => R('google-key') },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => R('jwt'),
  },
  {
    kind: 'api-key',
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => R('api-key'),
  },
  {
    kind: 'sendgrid-key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    replace: () => R('sendgrid-key'),
  },
  // NAME=value at the start of a line (env files, shell, deploy.conf).
  {
    kind: 'assignment',
    pattern: /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*?)[ \t]*$/gm,
    replace: (m, lead: string, name: string, eq: string, value: string) =>
      isSecretValue(name, value) ? `${lead}${name}${eq}${R('assignment')}` : m,
  },
  // name: value (YAML, config files, `key: value` output).
  {
    kind: 'assignment',
    pattern: /^(\s*(?:-\s+)?["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*:[ \t]+)(\S.*?)[ \t]*$/gm,
    replace: (m, lead: string, name: string, colon: string, value: string) =>
      isSecretValue(name, value) ? `${lead}${name}${colon}${R('assignment')}` : m,
  },
  // "name": "value" (JSON).
  {
    kind: 'assignment',
    pattern: /("([A-Za-z_][A-Za-z0-9_.-]*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    replace: (m, head: string, name: string, value: string) =>
      isSecretValue(name, value) ? `${head}"${R('assignment')}"` : m,
  },
  // name=value inside a line (cron commands, query strings).
  {
    kind: 'assignment',
    pattern: /(^|[\s?&;,(])([A-Za-z_][A-Za-z0-9_.-]*)=([^\s&;'"]+)/g,
    replace: (m, lead: string, name: string, value: string) =>
      isSecretValue(name, value) ? `${lead}${name}=${R('assignment')}` : m,
  },
  // Prose such as "FTP password: s3cret".
  {
    kind: 'assignment',
    pattern: /\b(password|passwd|passphrase|secret|token)(\s*[:=]\s*)(["']?)([^\s"']+)\3/gi,
    replace: (m, name: string, sep: string, q: string, value: string) =>
      PLACEHOLDER.test(value) ? m : `${name}${sep}${q}${R('assignment')}${q}`,
  },
];

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Long random-looking strings. Pure hex (commit SHAs, UUIDs) is left alone. */
const HIGH_ENTROPY: Rule = {
  kind: 'high-entropy',
  pattern: /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_=-])/g,
  replace: (m) => {
    const core = m.replace(/=+$/, '');
    if (/^[0-9a-f-]+$/i.test(core)) return m;
    if (!/[a-z]/.test(core) || !/[A-Z]/.test(core) || !/[0-9]/.test(core)) return m;
    return shannonEntropy(core) >= 4.2 ? R('high-entropy') : m;
  },
};

export function redact(input: string): RedactionResult {
  let text = input;
  const kinds: Record<string, number> = {};
  for (const rule of [...RULES, HIGH_ENTROPY]) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const groups = args.slice(0, -2).map((g) => (g === undefined ? undefined : String(g)));
      const [match, ...rest] = groups as [string, ...string[]];
      const out = rule.replace(match, ...rest);
      if (out !== match) kinds[rule.kind] = (kinds[rule.kind] ?? 0) + 1;
      return out;
    });
  }
  const count = Object.values(kinds).reduce((a, b) => a + b, 0);
  return { text, count, kinds };
}

/** Redacts every string inside a JSON-like value, returning a copy. */
export function redactDeep<T>(value: T): {
  value: T;
  count: number;
  kinds: Record<string, number>;
} {
  const kinds: Record<string, number> = {};
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      for (const [k, n] of Object.entries(r.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: out, count: Object.values(kinds).reduce((a, b) => a + b, 0), kinds };
}
