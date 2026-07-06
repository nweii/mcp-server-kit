// Unit suite for the audit-logging module: argument summarization and field redaction, the JSONL
// record shapes written for tool calls and feedback, the enabled/suppress gates, and the
// registerLogged wrapper's timing + outcome capture around a tool handler.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAuditLog } from '../src/index.js';
import type { ToolResult } from '../src/index.js';

const REDACTED = ['content', 'value', 'template', 'find', 'fields'];
const dirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'kit-audit-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readJsonl(dir: string, file: string): Record<string, unknown>[] {
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('summarizeArgs', () => {
  const { summarizeArgs } = createAuditLog({ logDir: freshDir(), redactedFields: REDACTED });

  test('passes through short strings, numbers, booleans, null', () => {
    expect(summarizeArgs({ path: 'a/foo.md', limit: 50, exact: true, x: null })).toEqual({
      path: 'a/foo.md',
      limit: 50,
      exact: true,
      x: null,
    });
  });

  test('truncates long strings to a length marker', () => {
    const result = summarizeArgs({ query: 'a'.repeat(200) }) as Record<string, string>;
    expect(result.query).toBe('<str:200chars>');
  });

  test('redacts a configured field regardless of length', () => {
    const result = summarizeArgs({ path: 'foo.md', content: 'short body' }) as Record<string, string>;
    expect(result.path).toBe('foo.md');
    expect(result.content).toBe('<redacted:10chars>');
  });

  test('redacts non-string values as a typed marker', () => {
    const result = summarizeArgs({ value: { complex: 'object' } }) as Record<string, string>;
    expect(result.value).toBe('<redacted:object>');
  });

  test('recurses into arrays and nested objects, keeping siblings of redacted keys', () => {
    const result = summarizeArgs({
      updates: [{ path: 'a.md', fields: { status: 'private' } }],
    }) as { updates: Array<Record<string, string>> };
    expect(result.updates[0].path).toBe('a.md');
    expect(result.updates[0].fields).toBe('<redacted:object>');
  });

  test('redacts nothing when no redactedFields are configured', () => {
    const { summarizeArgs: plain } = createAuditLog({ logDir: freshDir() });
    expect(plain({ content: 'visible' })).toEqual({ content: 'visible' });
  });
});

describe('logToolCall / logFeedback records', () => {
  test('a tool-call record carries ts, tool, summarized args, ok, duration, and error', () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir, redactedFields: REDACTED });
    log.logToolCall({ tool: 'demo', args: { content: 'secret' }, ok: false, duration_ms: 7, error: 'nope' });
    const [rec] = readJsonl(dir, 'tool-calls.jsonl');
    expect(typeof rec.ts).toBe('string');
    expect(rec.tool).toBe('demo');
    expect(rec.args).toEqual({ content: '<redacted:6chars>' });
    expect(rec.ok).toBe(false);
    expect(rec.duration_ms).toBe(7);
    expect(rec.error).toBe('nope');
  });

  test('a successful tool call omits the error key', () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir });
    log.logToolCall({ tool: 'demo', args: {}, ok: true, duration_ms: 1 });
    const [rec] = readJsonl(dir, 'tool-calls.jsonl');
    expect('error' in rec).toBe(false);
  });

  test('feedback goes to feedback.jsonl with a timestamp', () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir });
    log.logFeedback({ goal: 'g', attempted: 'a', stuck_on: 's', suggested_tool: 't' });
    const [rec] = readJsonl(dir, 'feedback.jsonl');
    expect(rec).toMatchObject({ goal: 'g', attempted: 'a', stuck_on: 's', suggested_tool: 't' });
    expect(typeof rec.ts).toBe('string');
  });
});

describe('enabled / suppressWrites gates', () => {
  test('nothing is written when enabled() is false; isLoggingEnabled reflects it', () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir, enabled: () => false });
    expect(log.isLoggingEnabled()).toBe(false);
    log.logToolCall({ tool: 'demo', args: {}, ok: true, duration_ms: 1 });
    expect(existsSync(join(dir, 'tool-calls.jsonl'))).toBe(false);
  });

  test('nothing is written when suppressWrites() is true', () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir, suppressWrites: () => true });
    log.logToolCall({ tool: 'demo', args: {}, ok: true, duration_ms: 1 });
    expect(existsSync(join(dir, 'tool-calls.jsonl'))).toBe(false);
  });
});

describe('registerLogged', () => {
  // A minimal stand-in for McpServer.registerTool: captures the wrapped handler so the test can call it.
  function fakeServer() {
    let wrapped: ((args: unknown) => Promise<ToolResult>) | undefined;
    return {
      server: { registerTool: (_name: string, _def: unknown, handler: (args: unknown) => Promise<ToolResult>) => { wrapped = handler; } },
      call: (args: unknown) => wrapped!(args),
    };
  }

  test('records a successful call with its outcome and passes the result through', async () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir, redactedFields: REDACTED });
    const { server, call } = fakeServer();
    const result: ToolResult = { content: [{ type: 'text', text: 'ok' }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log.registerLogged(server as any, 'demo', {}, async () => result);
    expect(await call({ path: 'x.md', content: 'body' })).toBe(result);
    const [rec] = readJsonl(dir, 'tool-calls.jsonl');
    expect(rec.tool).toBe('demo');
    expect(rec.ok).toBe(true);
    expect(rec.args).toEqual({ path: 'x.md', content: '<redacted:4chars>' });
  });

  test('records an isError result with its suggestion text', async () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir });
    const { server, call } = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log.registerLogged(server as any, 'demo', {}, async () => ({ content: [{ type: 'text', text: 'try foo' }], isError: true }));
    await call({});
    const [rec] = readJsonl(dir, 'tool-calls.jsonl');
    expect(rec.ok).toBe(false);
    expect(rec.error).toBe('try foo');
  });

  test('records a thrown error and rethrows', async () => {
    const dir = freshDir();
    const log = createAuditLog({ logDir: dir });
    const { server, call } = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log.registerLogged(server as any, 'demo', {}, async () => { throw new Error('boom'); });
    await expect(call({})).rejects.toThrow('boom');
    const [rec] = readJsonl(dir, 'tool-calls.jsonl');
    expect(rec.ok).toBe(false);
    expect(rec.error).toBe('boom');
  });
});
