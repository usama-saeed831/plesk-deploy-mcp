import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const BIN = path.resolve(import.meta.dirname, '../dist/index.js');

function start(env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [BIN], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id: number, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const line = stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id?: number })
        .find((m) => m.id === id);
      if (line) return line;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`No response ${id}. stderr: ${stderr}`);
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, send, waitFor, exited, out: () => stdout, err: () => stderr };
}

describe('the stdio binary', () => {
  it('prints its version and help on stdout without starting the server', () => {
    const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(v.stdout.trim()).toBe(VERSION);
    const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(h.stdout).toMatch(/PLESK_DEPLOY_SSH_HOSTS/);
  });

  it('writes only JSON-RPC messages to stdout, logs to stderr, and exits when stdin closes', async () => {
    const s = start({ PLESK_DEPLOY_SSH_HOSTS: 'prod, bad alias!' });
    s.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    const init = (await s.waitFor(1)) as { result?: { serverInfo?: { name: string } } };
    expect(init.result?.serverInfo?.name).toBe('plesk-deploy-mcp');
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
    const list = (await s.waitFor(2)) as { result?: { resources: unknown[] } };
    expect(list.result?.resources).toHaveLength(23);

    s.child.stdin.end();
    expect(await s.exited).toBe(0);

    for (const line of s.out().split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe('2.0');
    }
    expect(s.err()).toMatch(/running on stdio/);
    expect(s.err()).toMatch(/SSH tools enabled for: prod\./);
    expect(s.err()).toMatch(/Ignored invalid entries/);
  });
});
