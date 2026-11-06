import { describe, expect, it } from 'vitest';
import * as v from '../../src/lib/validate.js';
import { INJECTION_CORPUS } from '../fixtures/injection.js';

const ok = (schema: { safeParse: (x: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

/** Schemas whose values reach a command line, a remote shell, a path or a file. */
const STRICT = {
  hostAlias: v.hostAlias,
  appName: v.appName,
  domain: v.domain,
  systemUser: v.systemUser,
  pm2Name: v.pm2Name,
  unitName: v.unitName,
  remotePath: v.remotePath,
  relPath: v.relPath,
  httpUrl: v.httpUrl,
  httpsUrl: v.httpsUrl,
  repoSlug: v.repoSlug,
  workflowFile: v.workflowFile,
  envName: v.envName,
  gitBranch: v.gitBranch,
};

describe('every strict schema rejects the injection corpus', () => {
  for (const [name, schema] of Object.entries(STRICT)) {
    it(name, () => {
      const accepted = INJECTION_CORPUS.filter((s) => ok(schema, s));
      expect(accepted).toEqual([]);
    });
  }
});

describe('accepts what real projects use', () => {
  const cases: [keyof typeof STRICT, string[], string[]][] = [
    [
      'hostAlias',
      ['prod', 'plesk-prod', 'my.server_1'],
      ['-prod', 'user@host', 'host:22', 'a'.repeat(64)],
    ],
    [
      'appName',
      ['myapp', 'acme-shop', 'a', 'app2'],
      ['MyApp', '2app', 'app-', 'a'.repeat(25), 'my_app'],
    ],
    [
      'domain',
      ['example.com', 'api.example.co.uk', 'xn--caf-dma.example'],
      ['localhost', 'Example.com', '-a.com', 'a..com', 'example.com.'],
    ],
    [
      'systemUser',
      ['root', 'psacln', 'example_sys', 'www-data'],
      ['Root', '1user', 'a'.repeat(33)],
    ],
    ['pm2Name', ['myapp-api', 'web.1', 'API_worker'], ['-x', '.hidden']],
    ['unitName', ['myapp-api', 'plesk-php83-fpm', 'app@1.service'], ['-x']],
    [
      'remotePath',
      [
        '/var/www/myapp-app',
        '/etc/myapp/app.env',
        '/opt/plesk/node/24/bin',
        '/home/myapp-deploy/incoming/',
      ],
      ['relative/path', '/var/www/../etc', '/var/./www', '/', '//etc', '/var/www my'],
    ],
    [
      'relPath',
      ['api/.env', 'dist/main.js', '.next/BUILD_ID', 'storage'],
      ['/abs', 'a/../b', './a', 'a//b', '-x', '--help'],
    ],
    [
      'httpUrl',
      [
        'http://127.0.0.1:3001/health/ready',
        'https://example.com/version.json',
        'https://api.example.com/health?full=1',
      ],
      [
        'ftp://example.com',
        'https://user:pw@example.com',
        'file:///etc/passwd',
        'https://exa mple.com',
        "https://a.com/'",
      ],
    ],
    ['httpsUrl', ['https://example.com/'], ['http://example.com/']],
    [
      'repoSlug',
      ['usama-saeed831/plesk-deploy-mcp', 'octo/hello.world'],
      ['owner', 'owner/..', '-owner/repo', 'a/b/c'],
    ],
    ['workflowFile', ['deploy-plesk.yml', 'ci.yaml'], ['deploy.txt', '../ci.yml', 'a/b.yml']],
    ['envName', ['DATABASE_URL', 'NEXT_PUBLIC_API_URL', '_X'], ['lower', '1X', 'A-B']],
    [
      'gitBranch',
      ['main', 'release/1.2', 'feature_x'],
      ['-main', 'a..b', 'a//b', 'main.lock', 'main/'],
    ],
  ];
  for (const [name, good, bad] of cases) {
    it(name, () => {
      for (const g of good) expect(ok(STRICT[name], g), `${name} should accept ${g}`).toBe(true);
      for (const b of bad) expect(ok(STRICT[name], b), `${name} should reject ${b}`).toBe(false);
    });
  }
});

describe('looser schemas', () => {
  it('healthText allows JSON fragments but not shell or list syntax', () => {
    expect(ok(v.healthText, '"status":"ready"')).toBe(true);
    expect(ok(v.healthText, 'ok')).toBe(true);
    for (const bad of ['a b', 'a|b', "a'b", 'a\\b', '$(id)', '`id`', '', 'a\nb']) {
      expect(ok(v.healthText, bad), bad).toBe(false);
    }
  });

  it('shellCommand is one printable line (it is only ever written to a file)', () => {
    expect(ok(v.shellCommand, 'cd api && NODE_ENV=production node dist/migrate.js')).toBe(true);
    for (const bad of ['', 'a\nb', 'a\rb', 'a\u0000b', 'x'.repeat(1001)]) {
      expect(ok(v.shellCommand, bad)).toBe(false);
    }
  });

  it('localDir needs an absolute path without control characters', () => {
    expect(ok(v.localDir, '/Users/me/My Projects/shop')).toBe(true);
    for (const bad of ['relative', '', '/a\nb', '/a\u0000b'])
      expect(ok(v.localDir, bad)).toBe(false);
  });

  it('port is an integer from 1 to 65535', () => {
    expect(ok(v.port, 3000)).toBe(true);
    for (const bad of [0, 65536, 3.5, '3000']) expect(ok(v.port, bad)).toBe(false);
  });

  it('parseOrThrow names what was invalid without echoing a secret-looking value', () => {
    expect(() => v.parseOrThrow(v.appName, 'Bad App', 'app name')).toThrow(/^Invalid app name: /);
  });
});
