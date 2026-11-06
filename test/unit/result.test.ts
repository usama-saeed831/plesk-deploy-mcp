import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_CHARS,
  errorResult,
  guarded,
  redactResult,
  textResult,
} from '../../src/lib/result.js';

const ctx = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext;
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content[0]?.text ?? '';

describe('redactResult', () => {
  it('redacts text and structured content, and says how many values it hid', () => {
    const r = redactResult(textResult('DB_PASSWORD=pw1', { line: 'API_TOKEN=tk2', n: 1 }));
    expect(textOf(r)).toContain('DB_PASSWORD=[REDACTED:assignment]');
    expect(textOf(r)).toMatch(/\(1 value that looked like a secret was redacted\.\)/);
    expect(JSON.stringify(r)).not.toMatch(/pw1|tk2/);
    expect(r.structuredContent).toEqual({ line: 'API_TOKEN=[REDACTED:assignment]', n: 1 });
  });

  it('leaves clean results exactly as they were', () => {
    const r = textResult('all good', { ok: true });
    expect(redactResult(r)).toEqual(r);
  });

  it('caps very long text', () => {
    const r = redactResult(textResult('x'.repeat(MAX_TEXT_CHARS + 500)));
    expect(textOf(r).length).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(textOf(r)).toMatch(/500 more characters cut/);
  });
});

describe('guarded', () => {
  it('turns a thrown error into an isError result, redacted', async () => {
    const handler = guarded(async () => {
      throw new Error('could not read SECRET_KEY=abc123');
    });
    const r = await handler({}, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('SECRET_KEY=[REDACTED:assignment]');
  });

  it('passes the request abort signal to the handler', async () => {
    let seen: AbortSignal | undefined;
    await guarded(async (_args: object, signal) => {
      seen = signal;
      return errorResult('x');
    })({}, ctx);
    expect(seen).toBe(ctx.mcpReq.signal);
  });
});
