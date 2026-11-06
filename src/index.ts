#!/usr/bin/env node
/**
 * plesk-deploy-mcp: an MCP server on stdio. stdout carries only MCP
 * messages; everything else goes to stderr.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { PACKAGE_NAME, VERSION } from './version.js';

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === '--help' || arg === '-h') {
  process.stdout.write(
    `${PACKAGE_NAME} ${VERSION}: an MCP server for safe deployments to Plesk servers.

Run it from an MCP client (Claude Code, Claude Desktop, Cursor, VS Code); it speaks MCP on stdio.
Environment:
  PLESK_DEPLOY_SSH_HOSTS     comma-separated ~/.ssh/config aliases the SSH tools may reach (off when unset)
  PLESK_DEPLOY_GITHUB_TOKEN  optional read-only token for github_deploy_runs on private repositories
  PLESK_DEPLOY_SSH_BIN       optional path to ssh
Docs: https://github.com/usama-saeed831/plesk-deploy-mcp
`,
  );
  process.exit(0);
}

const config = loadConfig();
const log = (message: string) => console.error(`[${PACKAGE_NAME}] ${message}`);

serveStdio(() => createServer(config), { onerror: (error) => log(`error: ${error.message}`) });

log(`${VERSION} running on stdio.`);
log(
  config.allowedHosts.length > 0
    ? `SSH tools enabled for: ${config.allowedHosts.join(', ')}.`
    : 'SSH tools are off (set PLESK_DEPLOY_SSH_HOSTS to enable them).',
);
if (config.ignoredHosts.length > 0) {
  log(`Ignored invalid entries in PLESK_DEPLOY_SSH_HOSTS: ${config.ignoredHosts.length}.`);
}
