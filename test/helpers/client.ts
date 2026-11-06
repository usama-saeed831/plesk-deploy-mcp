import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Config, loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

/** A config for tests: nothing from the developer's real environment leaks in. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ PATH: process.env.PATH, HOME: process.env.HOME }),
    fetch: () => Promise.reject(new Error('No network in tests')),
    ...overrides,
  };
}

/**
 * A client connected to a fresh server through serveStdio (the production
 * entry point), over an in-memory transport.
 */
export async function connect(config: Config = testConfig()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(config), { transport: serverTransport });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}
