// HTTP-level suite for the auth module's OAuth contract as the MCP SDK's auth server emits it:
// discovery documents, the PKCE authorize→token flow through the SDK endpoints, all three
// approval-gate configurations, the static-bearer fallback, the SDK bearer-middleware error shapes,
// and the startup refusal when /authorize would be unguarded. Assertions pin the SDK-shaped surface
// (token endpoint at /token, spec-shaped redirect/JSON authorize errors, SDK 401 bodies) at the
// feature level, exercising each behavior end to end over HTTP.
import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
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
