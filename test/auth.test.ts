// HTTP-level suite for the auth module's OAuth contract as the MCP SDK's auth server emits it:
// discovery documents, the PKCE authorize→token flow through the SDK endpoints, all three
// approval-gate configurations, the static-bearer fallback, the SDK bearer-middleware error shapes,
// and the startup refusal when /authorize would be unguarded. Assertions pin the SDK-shaped surface
// (token endpoint at /token, spec-shaped redirect/JSON authorize errors, SDK 401 bodies) at the
// feature level, exercising each behavior end to end over HTTP.
import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp, createAuth } from '../src/index.js';
import type { AuthConfig } from '../src/index.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const open: Server[] = [];

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function storePath(): string {
  return join(tmpdir(), `kit-auth-${randomUUID()}.json`);
}

function storeDirectory(): { directory: string; path: string } {
  const directory = join(tmpdir(), `kit-auth-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, path: join(directory, 'tokens.json') };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Grab a free port, build auth + app with baseUrl pinned to it (so discovery reports the real URL),
// then listen on that exact port. Returns the live base URL.
async function standup(overrides: Partial<AuthConfig> = {}): Promise<string> {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const auth = createAuth({
    baseUrl: base,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: storePath(),
    approvalPassword: 'sekret',
    disableRateLimit: true,
    ...overrides,
  });
  const app = createApp({ name: 'kit-auth-fixture', version: '0.0.0', auth, testMode: true, registerTools: () => {} });
  await new Promise<void>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      open.push(server);
      resolve();
    });
  });
  return base;
}

async function standupAt(port: number, config: AuthConfig): Promise<{ base: string; server: Server; auth: ReturnType<typeof createAuth> }> {
  const auth = createAuth(config);
  const app = createApp({ name: 'kit-auth-fixture', version: '0.0.0', auth, testMode: true, registerTools: () => {} });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  });
  open.push(server);
  return { base: `http://localhost:${port}`, server, auth };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function approve(base: string, challenge: string, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    }),
  });
  const location = res.headers.get('location') ?? undefined;
  const code = location ? (new URL(location).searchParams.get('code') ?? undefined) : undefined;
  return { status: res.status, code, location };
}

async function exchange(base: string, code: string, verifier: string, extra: Record<string, string> = {}) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'test-client',
      redirect_uri: REDIRECT,
      ...extra,
    }),
  });
}

type RegisteredClient = { client_id: string; client_secret?: string; redirect_uris: string[]; token_endpoint_auth_method?: string };

async function registerPublicClient(base: string, redirectUri = 'com.example.mcp:/oauth/callback') {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Native MCP client',
    }),
  });
  return { res, body: (await res.json()) as RegisteredClient & { error?: string } };
}

async function approveRegistered(
  base: string,
  clientId: string,
  redirectUri: string,
  challenge: string,
  extra: Record<string, string> = {},
) {
  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    }),
  });
  const location = res.headers.get('location') ?? undefined;
  return { status: res.status, code: location ? new URL(location).searchParams.get('code') ?? undefined : undefined };
}

async function issueRegisteredToken(base: string, clientId: string, redirectUri: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const approval = await approveRegistered(base, clientId, redirectUri, challenge, { password: 'sekret' });
  expect(approval.code).toBeTruthy();
  const token = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: approval.code!,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

// --- Discovery (SDK-emitted) -------------------------------------------------

test('authorization-server metadata is the SDK-emitted document', async () => {
  const base = await standup();
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.issuer).toBe(`${base}/`); // URL.href normalizes with a trailing slash
  expect(body.authorization_endpoint).toBe(`${base}/authorize`);
  expect(body.token_endpoint).toBe(`${base}/token`); // SDK path, not /oauth/token
  expect(body.response_types_supported).toEqual(['code']);
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  // The SDK fixes these two; a configured client secret does not reshape them (see the secret test).
  expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none']);
});

test('protected-resource metadata points at this server', async () => {
  const base = await standup();
  const body = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
  expect(body.resource).toBe(`${base}/`);
  expect(body.authorization_servers).toEqual([`${base}/`]);
});

test('dynamic client registration is disabled by default', async () => {
  const base = await standup();
  const metadata = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(metadata.registration_endpoint).toBeUndefined();

  const registration = await fetch(`${base}/register`, { method: 'POST' });
  expect(registration.status).toBe(404);
});

test('a registered public client completes the password-gated PKCE flow', async () => {
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const base = await standup({ dynamicClientRegistration: { allowedRedirectUris: [redirectUri] } });
  const metadata = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(metadata.registration_endpoint).toBe(`${base}/register`);

  const registration = await registerPublicClient(base, redirectUri);
  expect(registration.res.status).toBe(201);
  expect(registration.body.client_id).toBeTruthy();
  expect(registration.body.client_secret).toBeUndefined();
  expect(registration.body.token_endpoint_auth_method).toBe('none');

  const { verifier, challenge } = pkce();
  const approval = await approveRegistered(base, registration.body.client_id, redirectUri, challenge, { password: 'sekret' });
  expect(approval.status).toBe(302);
  expect(approval.code).toBeTruthy();

  const token = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: approval.code!,
      code_verifier: verifier,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
    }),
  });
  expect(token.status).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(405);
});

test('dynamic registration rejects confidential clients and redirects outside its allowlist', async () => {
  const base = await standup({ dynamicClientRegistration: { allowedRedirectUris: ['com.example.mcp:/oauth/callback'] } });

  const confidential = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['com.example.mcp:/oauth/callback'], token_endpoint_auth_method: 'client_secret_post' }),
  });
  expect(confidential.status).toBe(400);
  expect(((await confidential.json()) as { error?: string }).error).toBe('invalid_client_metadata');

  const redirect = await registerPublicClient(base, 'https://evil.example/callback');
  expect(redirect.res.status).toBe(400);
  expect(redirect.body.error).toBe('invalid_client_metadata');

  const externalAllowlist = await standup({
    dynamicClientRegistration: { allowedRedirectUris: ['https://trusted.example/oauth/callback'] },
  });
  const loopbackBypass = await registerPublicClient(externalAllowlist, 'https://localhost/oauth/callback');
  expect(loopbackBypass.res.status).toBe(400);
  expect(loopbackBypass.body.error).toBe('invalid_client_metadata');
});

test('dynamic registration permits a different port for an allowlisted loopback redirect', async () => {
  const base = await standup({
    dynamicClientRegistration: { allowedRedirectUris: ['http://127.0.0.1/oauth/callback'] },
  });
  expect((await registerPublicClient(base, 'http://127.0.0.1:43123/oauth/callback')).res.status).toBe(201);
});

test('disableRateLimit also controls dynamic registration', async () => {
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const limited = await standup({
    disableRateLimit: false,
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
  });
  for (let i = 0; i < 20; i++) expect((await registerPublicClient(limited, redirectUri)).res.status).toBe(201);
  expect((await registerPublicClient(limited, redirectUri)).res.status).toBe(429);

  const unlimited = await standup({ dynamicClientRegistration: { allowedRedirectUris: [redirectUri] } });
  for (let i = 0; i < 21; i++) expect((await registerPublicClient(unlimited, redirectUri)).res.status).toBe(201);
});

test('dynamic registration requires the password gate, even when the static client has a secret', () => {
  expect(() =>
    createAuth({
      baseUrl: 'http://localhost:3000',
      clientId: 'test-client',
      displayName: 'kit-auth-fixture',
      tokenStorePath: storePath(),
      clientSecret: 'static-client-secret',
      dynamicClientRegistration: { allowedRedirectUris: ['com.example.mcp:/oauth/callback'] },
    }),
  ).toThrow(/requires approvalPassword/);
});

test('registered clients and their tokens survive a restart without replacing legacy token entries', async () => {
  const path = storePath();
  const legacyToken = 'legacy-token';
  const legacyExpiry = Date.now() + 60_000;
  await Bun.write(path, JSON.stringify({ [legacyToken]: legacyExpiry }));
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const config = (baseUrl: string, dynamicClientRegistration = true): AuthConfig => ({
    baseUrl,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    ...(dynamicClientRegistration ? { dynamicClientRegistration: { allowedRedirectUris: [redirectUri] } } : {}),
    disableRateLimit: true,
  });

  const firstPort = await freePort();
  const first = await standupAt(firstPort, config(`http://localhost:${firstPort}`));
  const registration = await registerPublicClient(first.base, redirectUri);
  const { verifier, challenge } = pkce();
  const approval = await approveRegistered(first.base, registration.body.client_id, redirectUri, challenge, { password: 'sekret' });
  const issued = await fetch(`${first.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: approval.code!, code_verifier: verifier,
      client_id: registration.body.client_id, redirect_uri: redirectUri,
    }),
  });
  const { access_token } = (await issued.json()) as { access_token: string };
  await new Promise<void>((resolve) => first.server.close(() => resolve()));
  open.splice(open.indexOf(first.server), 1);

  const secondPort = await freePort();
  const second = await standupAt(secondPort, config(`http://localhost:${secondPort}`));
  expect((await fetch(`${second.base}/mcp`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status).toBe(405);
  expect((await fetch(`${second.base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(405);

  const postRestart = await approveRegistered(second.base, registration.body.client_id, redirectUri, pkce().challenge, { password: 'sekret' });
  expect(postRestart.status).toBe(302);

  await new Promise<void>((resolve) => second.server.close(() => resolve()));
  open.splice(open.indexOf(second.server), 1);
  const thirdPort = await freePort();
  const withoutDcr = await standupAt(thirdPort, config(`http://localhost:${thirdPort}`, false));
  expect((await fetch(`${withoutDcr.base}/mcp`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status).toBe(405);
  expect((await fetch(`${withoutDcr.base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(401);
  expect(withoutDcr.auth.listDynamicClients().map((client) => client.client_id)).toEqual([registration.body.client_id]);
  withoutDcr.auth.saveTokens();
  await new Promise<void>((resolve) => withoutDcr.server.close(() => resolve()));
  open.splice(open.indexOf(withoutDcr.server), 1);

  const fourthPort = await freePort();
  const restoredDcr = await standupAt(fourthPort, config(`http://localhost:${fourthPort}`));
  expect(restoredDcr.auth.listDynamicClients().map((client) => client.client_id)).toEqual([registration.body.client_id]);
  expect((await fetch(`${restoredDcr.base}/mcp`, { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(405);
});

test('revokeDynamicClient permanently removes one client and only its tokens', async () => {
  const path = storePath();
  const legacyToken = 'legacy-token';
  await Bun.write(path, JSON.stringify({ [legacyToken]: Date.now() + 60_000 }));
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const port = await freePort();
  const { base, auth } = await standupAt(port, {
    baseUrl: `http://localhost:${port}`,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    staticBearerToken: 'static-abc',
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
    disableRateLimit: true,
  });
  const first = await registerPublicClient(base, redirectUri);
  const second = await registerPublicClient(base, redirectUri);
  const firstToken = await issueRegisteredToken(base, first.body.client_id, redirectUri);
  const secondToken = await issueRegisteredToken(base, second.body.client_id, redirectUri);
  const { verifier, challenge } = pkce();
  const approval = await approve(base, challenge, { password: 'sekret' });
  const staticToken = (await (await exchange(base, approval.code!, verifier)).json() as { access_token: string }).access_token;

  expect(auth.listDynamicClients().map((client) => client.client_id).sort()).toEqual([first.body.client_id, second.body.client_id].sort());
  expect(auth.revokeDynamicClient(first.body.client_id)).toEqual({ removed: true, revokedTokenCount: 1 });
  expect(auth.revokeDynamicClient(first.body.client_id)).toEqual({ removed: false, revokedTokenCount: 0 });
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${firstToken}` } })).status).toBe(401);
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${secondToken}` } })).status).toBe(405);
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${staticToken}` } })).status).toBe(405);
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status).toBe(405);
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer static-abc' } })).status).toBe(405);
});

test('clearDynamicClients persists permanent removal across a restart', async () => {
  const path = storePath();
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const config = (baseUrl: string): AuthConfig => ({
    baseUrl,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
    disableRateLimit: true,
  });
  const firstPort = await freePort();
  const first = await standupAt(firstPort, config(`http://localhost:${firstPort}`));
  const one = await registerPublicClient(first.base, redirectUri);
  const two = await registerPublicClient(first.base, redirectUri);
  const oneToken = await issueRegisteredToken(first.base, one.body.client_id, redirectUri);
  const twoToken = await issueRegisteredToken(first.base, two.body.client_id, redirectUri);

  expect(first.auth.clearDynamicClients()).toEqual({ removedClientCount: 2, revokedTokenCount: 2 });
  expect(first.auth.listDynamicClients()).toEqual([]);
  expect((await fetch(`${first.base}/mcp`, { headers: { Authorization: `Bearer ${oneToken}` } })).status).toBe(401);
  expect((await fetch(`${first.base}/mcp`, { headers: { Authorization: `Bearer ${twoToken}` } })).status).toBe(401);
  await new Promise<void>((resolve) => first.server.close(() => resolve()));
  open.splice(open.indexOf(first.server), 1);

  const secondPort = await freePort();
  const second = await standupAt(secondPort, config(`http://localhost:${secondPort}`));
  expect(second.auth.listDynamicClients()).toEqual([]);
  expect((await fetch(`${second.base}/mcp`, { headers: { Authorization: `Bearer ${oneToken}` } })).status).toBe(401);
  expect(second.auth.clearDynamicClients()).toEqual({ removedClientCount: 0, revokedTokenCount: 0 });
});

test('revokeDynamicClient reports a persistence failure and restores access', async () => {
  const { directory, path } = storeDirectory();
  const legacyToken = 'legacy-token';
  await Bun.write(path, JSON.stringify({ [legacyToken]: Date.now() + 60_000 }));
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const port = await freePort();
  const { base, auth } = await standupAt(port, {
    baseUrl: `http://localhost:${port}`,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    staticBearerToken: 'static-abc',
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
    disableRateLimit: true,
  });
  const registration = await registerPublicClient(base, redirectUri);
  const token = await issueRegisteredToken(base, registration.body.client_id, redirectUri);
  const persistedBefore = readFileSync(path, 'utf-8');

  chmodSync(directory, 0o500);
  try {
    expect(() => auth.revokeDynamicClient(registration.body.client_id)).toThrow(/Failed to persist dynamic client revocation/);
    expect(auth.listDynamicClients().map((client) => client.client_id)).toEqual([registration.body.client_id]);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer static-abc' } })).status).toBe(405);
    expect(readFileSync(path, 'utf-8')).toBe(persistedBefore);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test('dynamic registration fails without returning a client when the store cannot be replaced', async () => {
  const { directory, path } = storeDirectory();
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const port = await freePort();
  const { base, auth } = await standupAt(port, {
    baseUrl: `http://localhost:${port}`,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
    disableRateLimit: true,
  });

  chmodSync(directory, 0o500);
  try {
    const registration = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
    });
    expect(registration.status).not.toBe(201);
    expect(auth.listDynamicClients()).toEqual([]);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test('token issuance fails without returning a token when the store cannot be replaced', async () => {
  const { directory, path } = storeDirectory();
  const redirectUri = 'com.example.mcp:/oauth/callback';
  const port = await freePort();
  const { base, auth } = await standupAt(port, {
    baseUrl: `http://localhost:${port}`,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: path,
    approvalPassword: 'sekret',
    dynamicClientRegistration: { allowedRedirectUris: [redirectUri] },
    disableRateLimit: true,
  });
  const registration = await registerPublicClient(base, redirectUri);
  const { verifier, challenge } = pkce();
  const approval = await approveRegistered(base, registration.body.client_id, redirectUri, challenge, { password: 'sekret' });
  const persistedBefore = readFileSync(path, 'utf-8');

  chmodSync(directory, 0o500);
  try {
    const issuance = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: approval.code!, code_verifier: verifier,
        client_id: registration.body.client_id, redirect_uri: redirectUri,
      }),
    });
    expect(issuance.status).not.toBe(200);
    expect(auth.listDynamicClients().map((client) => client.client_id)).toEqual([registration.body.client_id]);
    expect(readFileSync(path, 'utf-8')).toBe(persistedBefore);
  } finally {
    chmodSync(directory, 0o700);
  }
});

// --- GET /authorize validation (SDK phases) ----------------------------------

test('GET /authorize renders the approval page for valid params', async () => {
  const base = await standup();
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Approve');
});

test('phase-1 errors are direct 400 JSON (unknown client, unregistered redirect)', async () => {
  const base = await standup();
  const { challenge } = pkce();

  const badClient = await fetch(
    `${base}/authorize?response_type=code&client_id=someone-else&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' },
  );
  expect(badClient.status).toBe(400);
  expect(((await badClient.json()) as { error?: string }).error).toBe('invalid_client');

  const badRedirect = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' },
  );
  expect(badRedirect.status).toBe(400);
  expect(((await badRedirect.json()) as { error?: string }).error).toBe('invalid_request');
});

test('phase-2 errors redirect to the client with error params (bad response_type, missing PKCE)', async () => {
  const base = await standup();
  const { challenge } = pkce();

  const badType = await fetch(
    `${base}/authorize?response_type=token&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' },
  );
  expect(badType.status).toBe(302);
  expect(new URL(badType.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

  const noPkce = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    { redirect: 'manual' },
  );
  expect(noPkce.status).toBe(302);
  expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
});

// --- Approval gate: password -------------------------------------------------

test('password gate: a wrong password issues no code and re-renders with an error', async () => {
  const base = await standup();
  const { challenge } = pkce();
  const r = await approve(base, challenge, { password: 'wrong' });
  expect(r.status).toBe(401);
  expect(r.code).toBeUndefined();

  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      password: 'wrong',
    }),
  });
  const html = await res.text();
  expect(html).toContain('Incorrect password.');
  expect(html).toContain('Approve');
});

test('password gate: the approval redirect preserves the state parameter', async () => {
  const base = await standup();
  const { challenge } = pkce();
  const r = await approve(base, challenge, { password: 'sekret', state: 'opaque-state-123' });
  expect(r.status).toBe(302);
  const loc = new URL(r.location!);
  expect(loc.searchParams.get('state')).toBe('opaque-state-123');
  expect(loc.searchParams.get('code')).toBeTruthy();
});

// --- Full PKCE flow ----------------------------------------------------------

test('full PKCE flow: approve → exchange → token accepted on /mcp, with the SDK token body', async () => {
  const base = await standup();
  const { verifier, challenge } = pkce();
  const r = await approve(base, challenge, { password: 'sekret' });
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();

  const tok = await exchange(base, r.code!, verifier);
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as { access_token?: string; token_type?: string; expires_in?: number };
  expect(body.access_token).toBeTruthy();
  expect(body.token_type).toBe('bearer');
  expect(body.expires_in).toBe(2592000);

  const mcp = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  expect(mcp.status).toBe(405); // a valid token reaches the POST-only handler
});

test('token exchange fails with a bad PKCE verifier (SDK local validation)', async () => {
  const base = await standup();
  const { challenge } = pkce();
  const r = await approve(base, challenge, { password: 'sekret' });
  const tok = await exchange(base, r.code!, 'not-the-verifier');
  expect(tok.status).toBe(400);
  expect(((await tok.json()) as { error?: string }).error).toBe('invalid_grant');
});

test('an authorization code is single-use', async () => {
  const base = await standup();
  const { verifier, challenge } = pkce();
  const r = await approve(base, challenge, { password: 'sekret' });
  const first = await exchange(base, r.code!, verifier);
  expect(first.status).toBe(200);
  const second = await exchange(base, r.code!, verifier);
  expect(second.status).toBe(400);
  expect(((await second.json()) as { error?: string }).error).toBe('invalid_grant');
});

// --- Token endpoint error shapes (SDK) ---------------------------------------

test('token endpoint reports SDK error bodies for unsupported grant and unknown code', async () => {
  const base = await standup();

  const badGrant = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'test-client' }),
  });
  expect(badGrant.status).toBe(400);
  expect(((await badGrant.json()) as { error?: string }).error).toBe('unsupported_grant_type');

  const unknownCode = await exchange(base, 'no-such-code', 'whatever');
  expect(unknownCode.status).toBe(400);
  expect(((await unknownCode.json()) as { error?: string }).error).toBe('invalid_grant');
});

test('the refresh_token grant is advertised but rejected cleanly (400, not 500)', async () => {
  const base = await standup();
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'anything', client_id: 'test-client' }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
});

// --- Approval gate: client secret --------------------------------------------

test('client-secret gate: enforced server-side even though discovery still advertises "none"', async () => {
  const base = await standup({ approvalPassword: undefined, clientSecret: 'shh' });
  const { verifier, challenge } = pkce();

  // Metadata still advertises the "none" method (SDK-fixed), but the secret is enforced anyway.
  const disc = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(disc.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none']);

  // No password field on the approval page under the client-secret gate.
  const page = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(await page.text()).not.toContain('type="password"');

  const r = await approve(base, challenge); // click-to-approve, no password posted
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();

  const withoutSecret = await exchange(base, r.code!, verifier);
  expect(withoutSecret.status).toBe(400);
  expect(((await withoutSecret.json()) as { error?: string }).error).toBe('invalid_client');
});

test('client-secret gate: the correct secret completes the exchange', async () => {
  const base = await standup({ approvalPassword: undefined, clientSecret: 'shh' });
  const { verifier, challenge } = pkce();
  const r = await approve(base, challenge);
  const tok = await exchange(base, r.code!, verifier, { client_secret: 'shh' });
  expect(tok.status).toBe(200);
  expect(((await tok.json()) as { access_token?: string }).access_token).toBeTruthy();
});

// --- Approval gate: explicit open --------------------------------------------

test('open gate: click-to-approve issues a code with no password and no secret', async () => {
  const base = await standup({ approvalPassword: undefined, approvalOpen: true });
  const { verifier, challenge } = pkce();
  const page = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(await page.text()).not.toContain('type="password"');

  const r = await approve(base, challenge);
  expect(r.status).toBe(302);
  const tok = await exchange(base, r.code!, verifier);
  expect(tok.status).toBe(200);
});

// --- Static bearer -----------------------------------------------------------

test('static bearer: the configured token is accepted on /mcp', async () => {
  const base = await standup({ staticBearerToken: 'static-abc' });
  const res = await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer static-abc' } });
  expect(res.status).toBe(405);
});

// --- Bearer middleware error shapes (SDK) ------------------------------------

test('bearer middleware reports SDK 401 bodies and WWW-Authenticate headers', async () => {
  const base = await standup();

  const noHeader = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(noHeader.status).toBe(401);
  expect(((await noHeader.json()) as { error?: string }).error).toBe('invalid_token');
  expect(noHeader.headers.get('www-authenticate')).toContain('error="invalid_token"');
  expect(noHeader.headers.get('www-authenticate')).toContain('resource_metadata=');

  const badToken = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    body: '{}',
  });
  expect(badToken.status).toBe(401);
  expect(((await badToken.json()) as { error?: string }).error).toBe('invalid_token');
});

// --- Construction-time behavior ----------------------------------------------

test('createAuth refuses to construct when /authorize would be unguarded', () => {
  expect(() =>
    createAuth({
      baseUrl: 'http://localhost:3000',
      clientId: 'test-client',
      displayName: 'x',
      tokenStorePath: storePath(),
      // no password, no client secret, no open flag
    }),
  ).toThrow(/Refusing to start/);
});

test('seedTestToken throws unless testMode is set, and seeds a token accepted on /mcp', async () => {
  const guarded: AuthConfig = {
    baseUrl: 'http://localhost:3000',
    clientId: 'test-client',
    displayName: 'x',
    tokenStorePath: storePath(),
    approvalOpen: true,
    disableRateLimit: true,
  };
  expect(() => createAuth(guarded).seedTestToken()).toThrow(/testMode/);

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const auth = createAuth({ ...guarded, baseUrl: base, testMode: true });
  const app = createApp({ name: 'x', version: '0', auth, testMode: true, registerTools: () => {} });
  await new Promise<void>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      open.push(server);
      resolve();
    });
  });
  const token = auth.seedTestToken();
  const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(405);
});

// --- Redirect-URI allowlist injection ----------------------------------------

test('a custom redirect-URI allowlist replaces the default set', async () => {
  const base = await standup({ allowedRedirectUris: ['https://only.example/cb'] });
  const { challenge } = pkce();

  const rejected = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' },
  );
  expect(rejected.status).toBe(400);

  const accepted = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://only.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(accepted.status).toBe(200);
});
