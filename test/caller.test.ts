// Caller identity over HTTP: each way of authenticating reaches registerTools, tool handlers and the
// audit log as its own caller, and the static bearer token never borrows the configured client's id.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAuditLog, currentCaller, runAsCaller, STATIC_BEARER_CLIENT_ID } from '../src/index.js';
import { callWhoami, closeAll, issueRegisteredToken, recordingServer, registerPublicClient, staticClientToken } from './helpers.js';

afterEach(closeAll);

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

test('running as no caller inside another caller leaves no caller', () => {
  runAsCaller({ clientId: 'outer', kind: 'static', scopes: [] }, () => {
    runAsCaller(undefined, () => expect(currentCaller()).toBeUndefined());
    expect(currentCaller()?.clientId).toBe('outer');
  });
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
