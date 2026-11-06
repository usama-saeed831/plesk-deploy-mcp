#!/usr/bin/env node
// Checks that package.json, server.json and the .mcpb manifest agree, and,
// on a tag, that the tag is v<version>. Run in CI and before publishing.
import { readFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');
const manifest = read('mcpb/manifest.json');
const problems = [];
const expect = (ok, message) => ok || problems.push(message);

expect(
  pkg.mcpName === server.name,
  `package.json mcpName (${pkg.mcpName}) must equal server.json name (${server.name})`,
);
expect(
  server.version === pkg.version,
  `server.json version (${server.version}) must equal package.json (${pkg.version})`,
);
const npm = server.packages?.find((p) => p.registryType === 'npm');
expect(npm?.identifier === pkg.name, `server.json npm identifier must be ${pkg.name}`);
expect(npm?.version === pkg.version, `server.json npm package version must be ${pkg.version}`);
expect(
  server.description.length <= 100,
  `server.json description is ${server.description.length} characters; the registry allows 100`,
);
expect(
  manifest.version === pkg.version,
  `mcpb/manifest.json version (${manifest.version}) must equal package.json (${pkg.version})`,
);
expect(manifest.name === pkg.name, `mcpb/manifest.json name must be ${pkg.name}`);
expect(
  pkg.repository?.url?.includes('github.com/usama-saeed831/plesk-deploy-mcp'),
  'package.json repository.url must point at the GitHub repository (npm provenance checks it)',
);

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag) expect(tag === `v${pkg.version}`, `The tag ${tag} must be v${pkg.version}`);

if (problems.length) {
  console.error(`Release metadata problems:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.error(`Release metadata agrees: ${pkg.name} ${pkg.version}${tag ? ` (tag ${tag})` : ''}.`);
