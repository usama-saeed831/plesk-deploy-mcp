import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The vendored plesk-deploy skill: SKILL.md, references/, templates/ and
 * scripts/. It ships in the npm package beside dist/, so the same relative
 * path works from src/ (tests) and from dist/ (installed).
 */
export const KIT_ROOT = fileURLToPath(new URL('../kit/', import.meta.url));

export function kitPath(...segments: string[]): string {
  const resolved = path.resolve(KIT_ROOT, ...segments);
  if (
    resolved !== path.resolve(KIT_ROOT) &&
    !resolved.startsWith(path.resolve(KIT_ROOT) + path.sep)
  ) {
    throw new Error(`Path escapes the kit: ${segments.join('/')}`);
  }
  return resolved;
}

export const RELEASE_MANAGER_TEMPLATE = kitPath('templates', 'server', 'app-deploy');
export const RELEASE_MANAGER_TESTS = kitPath('scripts', 'test-release-manager.sh');
