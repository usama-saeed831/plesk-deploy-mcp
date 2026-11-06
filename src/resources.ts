import type { McpServer } from '@modelcontextprotocol/server';
import { KIT_RESOURCES, readKitResource } from './catalog.js';

export function registerResources(server: McpServer): void {
  for (const resource of KIT_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: readKitResource(resource) }],
      }),
    );
  }
}
