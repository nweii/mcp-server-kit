// Caller identity over HTTP: each way of authenticating reaches registerTools, tool handlers and the
// audit log as its own caller, and the static bearer token never borrows the configured client's id.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAuditLog, currentCaller, runAsCaller, STATIC_BEARER_CLIENT_ID, textResult } from '../src/index.js';
import type { Caller, RegisterTools } from '../src/index.js';
import { approve, closeAll, exchange, issueRegisteredToken, pkce, registerPublicClient, standup } from './helpers.js';

afterEach(closeAll);

// A server whose registerTools records the caller it was given, and whose one tool reports the
// caller its handler sees.
async function recordingServer(overrides: Parameters<typeof standup>[0] = {}) {
  const registered: (Caller | undefined)[] = [];
  const registerTools: RegisterTools = (server, caller) => {
    registered.push(caller);
    server.registerTool('whoami', { description: 'Reports the caller' }, async () => textResult(JSON.stringify(currentCaller() ?? null)));
  };
  const base = await standup(overrides, registerTools);
  return { base, registered };
}

async function callWhoami(base: string, token: string): Promise<Caller> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const rpc = JSON.parse(line ? line.slice(6) : text) as { result: { content: { text: string }[] } };
  return JSON.parse(rpc.result.content[0]!.text) as Caller;
}

async function staticClientToken(base: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const approval = await approve(base, challenge, { password: 'sekret' });
  const res = await exchange(base, approval.code!, verifier);
  return ((await res.json()) as { access_token: string }).access_token;
}

test('the configured client calls as a static caller in registration and in handlers', async () => {
  const { base, registered } = await recordingServer();
  const caller = await callWhoami(base, await staticClientToken(base));
  expect(caller).toEqual({ clientId: 'test-client', kind: 'static', scopes: [] });
  expect(registered.at(-1)).toEqual(caller);
});

test('a registered client calls under its own id and declared name', async () => {
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const { base } = await recordingServer({ dynamicClientRegistration: {} });
  const registration = await registerPublicClient(base, redirectUri);
  const token = await issueRegisteredToken(base, registration.body.client_id, redirectUri);
  expect(await callWhoami(base, token)).toEqual({
    clientId: registration.body.client_id,
    clientName: 'Native MCP client',
    kind: 'dynamic',
    scopes: [],
  });
});

test('the static bearer token is its own caller, distinct from the configured client', async () => {
  const { base } = await recordingServer({ staticBearerToken: 'static-abc' });
  const bearer = await callWhoami(base, 'static-abc');
  const oauth = await callWhoami(base, await staticClientToken(base));
  expect(bearer).toEqual({ clientId: STATIC_BEARER_CLIENT_ID, kind: 'bearer', scopes: [] });
  expect(bearer.clientId).not.toBe(oauth.clientId);
});

test('there is no caller outside a request', () => {
  expect(currentCaller()).toBeUndefined();
});

test('audit records name the caller when written during a request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-caller-log-'));
  const log = createAuditLog({ logDir: dir });
  log.logToolCall({ tool: 'outside', args: {}, ok: true, duration_ms: 1 });
  runAsCaller({ clientId: 'abc', clientName: 'ChatGPT', kind: 'dynamic', scopes: [] }, () => {
    log.logToolCall({ tool: 'inside', args: {}, ok: true, duration_ms: 1 });
    log.logFeedback({ goal: 'g', attempted: 'a', stuck_on: 's' });
  });
  const calls = readFileSync(join(dir, 'tool-calls.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  expect(calls[0].client).toBeUndefined();
  expect(calls[1]).toMatchObject({ client: 'abc', client_name: 'ChatGPT', tool: 'inside' });
  const [feedback] = readFileSync(join(dir, 'feedback.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  expect(feedback).toMatchObject({ client: 'abc', client_name: 'ChatGPT', goal: 'g' });
});
