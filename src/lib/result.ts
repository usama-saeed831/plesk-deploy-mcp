/**
 * Every tool result passes through here: errors become isError results with a
 * useful message, every string is redacted, and text is capped so it fits a
 * client's context.
 */
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { redact, redactDeep } from './redact.js';

/** Claude Code saves results over 50,000 characters to a file; stay below that. */
export const MAX_TEXT_CHARS = 45_000;

export class ToolError extends Error {}

export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): CallToolResult {
  return structuredContent
    ? { content: [{ type: 'text', text }], structuredContent }
    : { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function cap(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.length - MAX_TEXT_CHARS;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… ${cut} more characters cut. Narrow the request to see them.]`;
}

export function redactResult(result: CallToolResult): CallToolResult {
  let redactions = 0;
  const content = result.content.map((item) => {
    if (item.type !== 'text') return item;
    const r = redact(item.text);
    redactions += r.count;
    return { ...item, text: cap(r.text) };
  });
  let structuredContent = result.structuredContent;
  if (structuredContent) {
    const r = redactDeep(structuredContent);
    structuredContent = r.value;
    redactions = Math.max(redactions, r.count);
  }
  const first = content[0];
  if (redactions > 0 && first?.type === 'text') {
    content[0] = {
      ...first,
      text: `${first.text}\n\n(${redactions} value${redactions === 1 ? '' : 's'} that looked like ${redactions === 1 ? 'a secret was' : 'secrets were'} redacted.)`,
    };
  }
  return { ...result, content, ...(structuredContent ? { structuredContent } : {}) };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wraps a tool handler: thrown errors become isError results, and every
 * result is redacted and capped. The handler receives the request's abort
 * signal.
 */
export function guarded<A>(
  handler: (args: A, signal: AbortSignal) => Promise<CallToolResult>,
): (args: A, ctx: ServerContext) => Promise<CallToolResult> {
  return async (args, ctx) => {
    let result: CallToolResult;
    try {
      result = await handler(args, ctx.mcpReq.signal);
    } catch (error) {
      result = errorResult(messageOf(error));
    }
    return redactResult(result);
  };
}
