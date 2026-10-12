// Shared OAuth test helpers: a live kit server on a free port, the PKCE approve→exchange steps, and
// dynamic client registration. Each test file closes the servers in `open` after every test.
import { expect } from 'bun:test';
import type { Server } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp, createAuth } from '../src/index.js';
import type { AuthConfig, RegisterTools } from '../src/index.js';

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
export const open: Server[] = [];

export function closeAll(): void {
  for (const s of open.splice(0)) s.close();
}

export function storePath(): string {
  return join(tmpdir(), `kit-auth-${randomUUID()}.json`);
}

export function storeDirectory(): { directory: string; path: string } {
  const directory = join(tmpdir(), `kit-auth-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  return { directory, path: join(directory, 'tokens.json') };
}

export function freePort(): Promise<number> {
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
export async function standup(overrides: Partial<AuthConfig> = {}, registerTools: RegisterTools = () => {}): Promise<string> {
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
  const app = createApp({ name: 'kit-auth-fixture', version: '0.0.0', auth, testMode: true, registerTools });
  await new Promise<void>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      open.push(server);
      resolve();
    });
  });
  return base;
}

export async function standupAt(port: number, config: AuthConfig): Promise<{ base: string; server: Server; auth: ReturnType<typeof createAuth> }> {
  const auth = createAuth(config);
  const app = createApp({ name: 'kit-auth-fixture', version: '0.0.0', auth, testMode: true, registerTools: () => {} });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  });
  open.push(server);
  return { base: `http://localhost:${port}`, server, auth };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function approve(base: string, challenge: string, extra: Record<string, string> = {}) {
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

export async function exchange(base: string, code: string, verifier: string, extra: Record<string, string> = {}) {
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

export type RegisteredClient = { client_id: string; client_secret?: string; redirect_uris: string[]; token_endpoint_auth_method?: string };

export async function registerPublicClient(base: string, redirectUri = 'com.example.mcp:/oauth/callback') {
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

export async function approveRegistered(
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

export async function issueRegisteredToken(base: string, clientId: string, redirectUri: string): Promise<string> {
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
