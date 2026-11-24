// ABOUTME: createAccessAuth over HTTP: a request carrying a valid Access JWT runs as an 'access' caller,
// and a missing, forged, expired, wrong-audience, or identity-less JWT is refused before /mcp.
import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { createAccessAuth, createApp, currentCaller, textResult } from '../src/index.js';
import type { AccessAuthConfig, Caller } from '../src/index.js';
import { freePort } from './helpers.js';

const AUDIENCE = 'aud-tag-123';
const servers: Array<Server> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(app: express.Express, port: number): Promise<void> {
  return new Promise((resolve) => {
    servers.push(app.listen(port, '127.0.0.1', () => resolve()));
  });
}

// A stand-in Access team: serves its signing keys and mints JWTs the way Access does.
async function fakeTeam() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let certFetches = 0;
  const team = express();
  team.get('/cdn-cgi/access/certs', (_req, res) => {
    certFetches += 1;
    res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  });
  const port = await freePort();
  await listen(team, port);
  const issuer = `http://127.0.0.1:${port}`;

  function mint(claims: Record<string, unknown> = {}, key: KeyObject = privateKey, kid = 'k1'): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: issuer, aud: [AUDIENCE], email: 'person@example.com', sub: 'user-1', iat: now, nbf: now, exp: now + 900, ...claims }),
    ).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  return { issuer, mint, certFetches: () => certFetches };
}

async function protectedServer(teamDomain: string, extra: Partial<AccessAuthConfig> = {}): Promise<string> {
  const registered: Array<Caller | undefined> = [];
  const app = createApp({
    name: 'access-fixture',
    version: '0.0.0',
    testMode: true,
    authMiddleware: createAccessAuth({ teamDomain, audience: AUDIENCE, ...extra }),
    registerTools(server, caller) {
      registered.push(caller);
      server.registerTool('whoami', { description: 'Returns the caller.' }, async () => textResult(JSON.stringify(currentCaller())));
    },
  });
  const port = await freePort();
  await listen(app, port);
  return `http://127.0.0.1:${port}`;
}

function callWhoami(base: string, jwt?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
}

async function callerOf(res: Response): Promise<Caller> {
  expect(res.status).toBe(200);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const rpc = JSON.parse(line ? line.slice(6) : text) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(rpc.result.content[0].text) as Caller;
}

test('a Managed OAuth request runs as its connection, carrying the signed-in user', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer, { scopes: ['notes:write'] });
  const jwt = team.mint({ oauth: { client_id: 'client-9', client_redirect_uri: 'https://claude.ai/api/mcp/auth_callback' } });
  expect(await callerOf(await callWhoami(base, jwt))).toEqual({
    clientId: 'client-9',
    kind: 'access',
    email: 'person@example.com',
    userId: 'user-1',
    scopes: ['notes:write'],
  });
});

test('a request without an OAuth client is named by the user', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer);
  expect(await callerOf(await callWhoami(base, team.mint()))).toEqual({
    clientId: 'person@example.com',
    kind: 'access',
    email: 'person@example.com',
    userId: 'user-1',
    scopes: [],
  });
});

test('signing keys are fetched once and reused', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer);
  await callerOf(await callWhoami(base, team.mint()));
  await callerOf(await callWhoami(base, team.mint()));
  expect(team.certFetches()).toBe(1);
});

test('requests that did not come through Access are refused', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer);
  const { privateKey: stranger } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const refused = [
    undefined,
    'not-a-jwt',
    team.mint({}, stranger),
    team.mint({ aud: ['another-app'] }),
    team.mint({ iss: 'https://other.cloudflareaccess.com' }),
    team.mint({ exp: now - 600 }),
    team.mint({ nbf: now + 600 }),
    team.mint({ email: undefined }),
    team.mint({}, undefined, 'unknown-kid'),
  ];
  for (const jwt of refused) {
    const res = await callWhoami(base, jwt);
    expect(res.status).toBe(403);
  }
});

test('requests arriving while keys are being fetched share the fetch', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer);
  const responses = await Promise.all([1, 2, 3].map(() => callWhoami(base, team.mint())));
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(team.certFetches()).toBe(1);
});

test('unknown key ids do not refetch keys within a minute of the last fetch', async () => {
  const team = await fakeTeam();
  const base = await protectedServer(team.issuer);
  await callerOf(await callWhoami(base, team.mint()));
  for (let i = 0; i < 5; i++) await callWhoami(base, team.mint({}, undefined, `rotated-${i}`));
  expect(team.certFetches()).toBe(1);
});

test('createAccessAuth refuses an empty audience or team domain', () => {
  expect(() => createAccessAuth({ teamDomain: 'team.cloudflareaccess.com', audience: ' ' })).toThrow();
  expect(() => createAccessAuth({ teamDomain: '', audience: AUDIENCE })).toThrow();
});
