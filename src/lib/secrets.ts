/**
 * Finds values that look like secrets in a file, by line, without returning
 * the values. Used to refuse writing a kit that contains one, and by
 * validate_deploy_kit.
 */
import { redact } from './redact.js';

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
}

export function findSecrets(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split('\n').forEach((line, i) => {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(line)) {
      findings.push({ file, line: i + 1, kind: 'private-key' });
      return;
    }
    for (const kind of Object.keys(redact(line).kinds)) findings.push({ file, line: i + 1, kind });
  });
  return findings;
}
