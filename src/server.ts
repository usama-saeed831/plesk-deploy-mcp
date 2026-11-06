import { McpServer } from '@modelcontextprotocol/server';
import { type Config, loadConfig } from './config.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';
import { PACKAGE_NAME, VERSION } from './version.js';

export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: VERSION,
      title: 'Plesk Deploy',
      description:
        'Set up and operate safe, approval-gated deployments to Plesk servers with GitHub Actions and a release manager that rolls back by itself.',
      websiteUrl: 'https://github.com/usama-saeed831/plesk-deploy-mcp',
    },
    { instructions: INSTRUCTIONS },
  );
  registerResources(server);
  registerPrompts(server);
  registerTools(server, config);
  return server;
}
