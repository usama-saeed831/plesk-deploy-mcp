import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';

/** A tool module registers one tool on the server. */
export type ToolModule = (server: McpServer, config: Config) => void;

export const TOOLS: readonly ToolModule[] = [];

export function registerTools(server: McpServer, config: Config): void {
  for (const register of TOOLS) register(server, config);
}
