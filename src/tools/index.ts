import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { registerGenerateDeployKit } from './generate-deploy-kit.js';
import { registerInspectProject } from './inspect-project.js';
import { registerServerDiscoveryCommands } from './server-discovery-commands.js';
import { registerValidateDeployKit } from './validate-deploy-kit.js';

/** A tool module registers one tool on the server. */
export type ToolModule = (server: McpServer, config: Config) => void;

export const TOOLS: readonly ToolModule[] = [
  registerInspectProject,
  registerServerDiscoveryCommands,
  registerGenerateDeployKit,
  registerValidateDeployKit,
];

export function registerTools(server: McpServer, config: Config): void {
  for (const register of TOOLS) register(server, config);
}
