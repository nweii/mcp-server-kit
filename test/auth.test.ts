// HTTP-level suite for the auth module's full OAuth contract: discovery documents, the PKCE
// authorize→token flow, all three approval-gate configurations, the static-bearer fallback, bearer
// middleware error shapes, and the startup refusal when /authorize would be unguarded. Assertions
// pin the exact observable surface (paths, status codes, error bodies, headers, TTLs) so the wire
// contract is fixed against accidental change. Tests speak HTTP only, except the direct createAuth
// calls that check construction-time behavior (guard refusal, test-mode seeding).
import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
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

async function listen(app: ReturnType<typeof createApp>): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      open.push(server);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, server });
    });
  });
}

// Stand up an app + auth with `overrides`, listen, and return the live base URL. The auth module's
// baseUrl getter is wired to the resolved URL so discovery documents report the real port.
async function standup(overrides: Partial<AuthConfig> = {}): Promise<string> {
  let base = 'http://localhost:0';
  const auth = createAuth({
    baseUrl: () => base,
    clientId: 'test-client',
    displayName: 'kit-auth-fixture',
    tokenStorePath: storePath(),
    approvalPassword: 'sekret',
    ...overrides,
  });
  const app = createApp({ name: 'kit-auth-fixture', version: '0.0.0', auth, testMode: true, registerTools: () => {} });
  const { base: resolved } = await listen(app);
  base = resolved;
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
  return fetch(`${base}/oauth/token`, {
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

// --- Discovery ---------------------------------------------------------------

test('authorization-server metadata reports the pinned OAuth capabilities', async () => {
  const base = await standup();
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.issuer).toBe(base);
  expect(body.authorization_endpoint).toBe(`${base}/authorize`);
  expect(body.token_endpoint).toBe(`${base}/oauth/token`);
  expect(body.response_types_supported).toEqual(['code']);
  expect(body.grant_types_supported).toEqual(['authorization_code']);
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none']);
});

test('a configured client secret drops the "none" auth method from discovery', async () => {
  const base = await standup({ approvalPassword: undefined, clientSecret: 'shh' });
  const body = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
});

test('protected-resource metadata points at this server as its own auth server', async () => {
  const base = await standup();
  const body = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
  expect(body.resource).toBe(base);
  expect(body.authorization_servers).toEqual([base]);
});

// --- GET /authorize validation -----------------------------------------------

test('GET /authorize renders the approval page for valid params', async () => {
  const base = await standup();
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Approve');
});

test('GET /authorize rejects each invalid parameter with its pinned 400 body', async () => {
  const base = await standup();
  const { challenge } = pkce();

  const badType = await fetch(
    `${base}/authorize?response_type=token&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(badType.status).toBe(400);
  expect(await badType.text()).toBe('Unsupported response_type');

  const badClient = await fetch(
    `${base}/authorize?response_type=code&client_id=someone-else&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(badClient.status).toBe(400);
  expect(await badClient.text()).toBe('Unknown client_id');

  const badRedirect = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(badRedirect.status).toBe(400);
  expect(await badRedirect.text()).toBe('redirect_uri not allowed');

  const noPkce = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}`,
  );
  expect(noPkce.status).toBe(400);
  expect(await noPkce.text()).toBe('PKCE with S256 is required');
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

test('full PKCE flow: approve → exchange → token accepted on /mcp, with the pinned token body', async () => {
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

test('token exchange fails with a bad PKCE verifier', async () => {
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

// --- Token endpoint error shapes ---------------------------------------------

test('token endpoint pins its request-error bodies', async () => {
  const base = await standup();

  const badGrant = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  expect(badGrant.status).toBe(400);
  expect(((await badGrant.json()) as { error?: string }).error).toBe('unsupported_grant_type');

  const noCode = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code' }),
  });
  expect(noCode.status).toBe(400);
  const noCodeBody = (await noCode.json()) as { error?: string; error_description?: string };
  expect(noCodeBody.error).toBe('invalid_request');
  expect(noCodeBody.error_description).toBe('code is required');

  const unknownCode = await exchange(base, 'no-such-code', 'whatever');
  expect(unknownCode.status).toBe(400);
  expect(((await unknownCode.json()) as { error?: string }).error).toBe('invalid_grant');
});

// --- Approval gate: client secret --------------------------------------------

test('client-secret gate: click-to-approve issues a code, token exchange requires the secret', async () => {
  const base = await standup({ approvalPassword: undefined, clientSecret: 'shh' });
  const { verifier, challenge } = pkce();

  // No password field on the approval page under the client-secret gate.
  const page = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(await page.text()).not.toContain('type="password"');

  const r = await approve(base, challenge); // no password posted
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();

  const withoutSecret = await exchange(base, r.code!, verifier);
  expect(withoutSecret.status).toBe(401);
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

// --- Bearer middleware error shapes ------------------------------------------

test('bearer middleware pins its 401 bodies and WWW-Authenticate headers', async () => {
  const base = await standup();

  const noHeader = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(noHeader.status).toBe(401);
  expect(await noHeader.json()).toEqual({ error: 'unauthorized' });
  expect(noHeader.headers.get('www-authenticate')).toContain('resource_metadata=');

  const badToken = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    body: '{}',
  });
  expect(badToken.status).toBe(401);
  expect(await badToken.json()).toEqual({ error: 'invalid_token' });
  expect(badToken.headers.get('www-authenticate')).toContain('error="invalid_token"');
});

// --- Construction-time behavior ----------------------------------------------

test('createAuth refuses to construct when /authorize would be unguarded', () => {
  expect(() =>
    createAuth({
      baseUrl: 'http://localhost:0',
      clientId: 'test-client',
      displayName: 'x',
      tokenStorePath: storePath(),
      // no password, no client secret, no open flag
    }),
  ).toThrow(/Refusing to start/);
});

test('seedTestToken throws unless testMode is set, and seeds a token accepted on /mcp', async () => {
  const guarded: AuthConfig = {
    baseUrl: 'http://localhost:0',
    clientId: 'test-client',
    displayName: 'x',
    tokenStorePath: storePath(),
    approvalOpen: true,
  };
  expect(() => createAuth(guarded).seedTestToken()).toThrow(/testMode/);

  let base = 'http://localhost:0';
  const auth = createAuth({ ...guarded, baseUrl: () => base, testMode: true });
  const app = createApp({ name: 'x', version: '0', auth, testMode: true, registerTools: () => {} });
  const { base: resolved } = await listen(app);
  base = resolved;
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
  );
  expect(rejected.status).toBe(400);

  const accepted = await fetch(
    `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://only.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expect(accepted.status).toBe(200);
});
