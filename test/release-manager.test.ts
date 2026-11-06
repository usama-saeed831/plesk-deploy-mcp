import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RELEASE_MANAGER_TEMPLATE, RELEASE_MANAGER_TESTS } from '../src/kit.js';

// The release manager is bash; its suite needs bash, tar and curl (file:// URLs).
const hasBash = process.platform !== 'win32';

describe('release manager (kit/templates/server/app-deploy)', () => {
  it.skipIf(!hasBash)(
    'passes its own suite with 0 failures',
    () => {
      const run = spawnSync('bash', [RELEASE_MANAGER_TESTS, RELEASE_MANAGER_TEMPLATE], {
        encoding: 'utf8',
        timeout: 180_000,
      });
      const output = `${run.stdout}\n${run.stderr}`;
      const summary = /(\d+) passed, (\d+) failed\./.exec(output);
      expect(summary, output).not.toBeNull();
      const [, passed, failed] = summary!;
      expect(Number(failed), output).toBe(0);
      expect(Number(passed)).toBeGreaterThanOrEqual(51);
      expect(run.status).toBe(0);
    },
    200_000,
  );
});
