import { describe, expect, it } from 'vitest';
import { redact, redactDeep } from '../../src/lib/redact.js';

// Fake secrets, built at run time so no scanner mistakes this file for a leak.
const fake = (prefix: string, n: number, alphabet = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY') =>
  prefix + Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');

const GH = fake('ghp_', 36);
const NPM = fake('npm_', 36);
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${fake('', 20)}`;
const HIGH = fake('', 40);

function expectRedacted(input: string, secret: string, kind?: string) {
  const out = redact(input);
  expect(out.text, input).not.toContain(secret);
  expect(out.count).toBeGreaterThan(0);
  if (kind) expect(out.kinds[kind], JSON.stringify(out.kinds)).toBeGreaterThan(0);
  return out;
}

function expectUnchanged(input: string) {
  const out = redact(input);
  expect(out.text).toBe(input);
  expect(out.count).toBe(0);
}

describe('redact', () => {
  it('private-key blocks, complete or cut off', () => {
    const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ';
    expectRedacted(
      `x\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\ny`,
      body,
      'private-key',
    );
    expectRedacted(`-----BEGIN RSA PRIVATE KEY-----\n${body}`, body, 'private-key');
    expectRedacted(
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${body}\n-----END PGP PRIVATE KEY BLOCK-----`,
      body,
    );
  });

  it('secret-named assignments in env, shell, YAML, JSON and prose', () => {
    expectRedacted('DB_PASSWORD=hunter2', 'hunter2', 'assignment');
    expectRedacted('export JWT_SECRET="a b c"', 'a b c');
    expectRedacted('  STRIPE_SECRET_KEY: sk_x_123', 'sk_x_123');
    expectRedacted('{"apiKey": "abc123", "name": "shop"}', 'abc123');
    expectRedacted('*/5 * * * * DB_PASS=s3cr3t node /var/www/app/cron.js', 's3cr3t');
    expectRedacted('FTP password: pa55word', 'pa55word');
    expectRedacted('APP_KEY=base64:Zm9vYmFy', 'base64:Zm9vYmFy');
    expectRedacted("MIGRATE_CMD='DB_PASSWORD=hunter2 npm run migrate'", 'hunter2');
    expectRedacted('run "API_TOKEN=abc123 node x"', 'abc123');
    expectRedacted('DATABASE_URL=postgres://app:pw@127.0.0.1/app', 'pw@');
  });

  it('URL passwords, query tokens and Authorization headers', () => {
    expectRedacted('git remote: https://deploy:tok3n@github.com/o/r.git', 'tok3n', 'url-password');
    expectRedacted('curl https://hooks.example.com/run?token=abc123&x=1', 'abc123');
    expectRedacted(
      'proxy_set_header Authorization "Bearer abc.def.ghi";',
      'abc.def.ghi',
      'authorization',
    );
    expectRedacted('-H "Authorization: Basic dXNlcjpwYXNz"', 'dXNlcjpwYXNz');
  });

  it('known token formats anywhere in a line', () => {
    expectRedacted(`token is ${GH} here`, GH, 'github-token');
    expectRedacted(`//registry.npmjs.org/:_authToken=${NPM}`, NPM);
    expectRedacted(`aws ${AWS}`, AWS, 'aws-key');
    expectRedacted(`Bearer-less ${JWT}`, JWT, 'jwt');
    expectRedacted(`key ${fake('sk-ant-', 30)}`, fake('sk-ant-', 30), 'api-key');
    expectRedacted(`stripe ${fake('sk_live_', 24)}`, fake('sk_live_', 24), 'stripe-key');
  });

  it('long random strings', () => {
    expectRedacted(`blob ${HIGH} end`, HIGH, 'high-entropy');
  });

  it('leaves deployment facts readable', () => {
    for (const s of [
      'commit=3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
      'Release 20261106-101500 (3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345) is live.',
      '* 20261106-101500        3f9c2a1b',
      'NODE_ENV=production',
      'PORT=3000',
      'BASE=/var/www/myapp-app',
      'DB_PASSWORD=<set>',
      'JWT_SECRET=',
      'PLESK_SSH_KEY: ${{ secrets.PLESK_SSH_KEY }}',
      'SSH_KEY: $PLESK_SSH_KEY',
      '    PGPASSWORD=$(value DB_PASSWORD) pg_dump -Fc --no-owner \\',
      'MYSQL_PWD=$(value DB_PASSWORD) mysqldump --single-transaction',
      'HEALTH_CHECKS=\'http://127.0.0.1:3001/health/ready|"status":"ready"\'',
      'exec cwd │ /var/www/vhosts/example.com/httpdocs/backend',
      '/var/www/vhosts/system/example.com/conf/vhost_nginx.conf',
      'uuid 123e4567-e89b-12d3-a456-426614174000',
      'myapp-3f9c2a1-20261106-101500.tgz',
      'NEXT_PUBLIC_API_URL_FOR_THE_PRODUCTION_FRONTEND_BUILD',
      'The deploy token is required.',
      'Authorization required for this endpoint',
      'proxy_set_header Authorization $http_authorization;',
      'tcp LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=1234,fd=20))',
    ]) {
      expectUnchanged(s);
    }
  });

  it('counts by kind and never includes the value in the counts', () => {
    const out = redact('A_TOKEN=one\nB_SECRET=two');
    expect(out.count).toBe(2);
    expect(JSON.stringify(out.kinds)).not.toMatch(/one|two/);
  });
});

describe('redactDeep', () => {
  it('redacts strings at any depth and keeps the shape', () => {
    const input = { a: ['x', { b: `DB_PASSWORD=pw1` }], n: 3, ok: true, nil: null };
    const out = redactDeep(input);
    expect(out.value).toEqual({
      a: ['x', { b: 'DB_PASSWORD=[REDACTED:assignment]' }],
      n: 3,
      ok: true,
      nil: null,
    });
    expect(out.count).toBe(1);
  });
});
