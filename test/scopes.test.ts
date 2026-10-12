// Scopes chosen on the approval page: which boxes appear and start ticked, what a connection is
// granted when a box is left unticked, how grants persist, and the static bearer's configured set.
import { afterEach, expect, test } from 'bun:test';
import { createAuth } from '../src/index.js';
import type { ScopeDefinition } from '../src/index.js';
import { REDIRECT, callWhoami, closeAll, exchange, pkce, recordingServer, storePath } from './helpers.js';

afterEach(closeAll);

const SCOPES: ScopeDefinition[] = [
  { id: 'notes:write', label: 'Edit notes', hint: 'Create, edit and delete notes.' },
  { id: 'app:control', label: 'Control the app', hint: 'Run app commands.' },
];

async function approvalPage(base: string, query: Record<string, string> = {}): Promise<string> {
  const { challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code', client_id: 'test-client', redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', ...query,
  });
  const res = await fetch(`${base}/authorize?${params}`);
  expect(res.status).toBe(200);
  return res.text();
}

// The scopes a checkbox list renders as ticked, in page order.
function ticked(html: string): string[] {
  return [...html.matchAll(/name="grant" value="([^"]+)"( checked)?/g)].filter((m) => m[2]).map((m) => m[1]!);
}

// Approves with the given boxes ticked and returns the issued token and the token response's scope.
async function connect(base: string, grants: string[]) {
  const { verifier, challenge } = pkce();
  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['response_type', 'code'], ['client_id', 'test-client'], ['redirect_uri', REDIRECT],
      ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['password', 'sekret'],
      ...grants.map((g) => ['grant', g]),
    ]),
  });
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const token = await exchange(base, code, verifier);
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; scope?: string };
}

test('each offered scope is a ticked checkbox under the prompt, with its hint', async () => {
  const { base } = await recordingServer({ scopes: SCOPES, scopesPrompt: 'Reading is always allowed. Also allow:' });
  const html = await approvalPage(base);
  expect(html).toContain('Reading is always allowed. Also allow:');
  expect(html).toContain('Edit notes<small>Create, edit and delete notes.</small>');
  expect(ticked(html)).toEqual(['notes:write', 'app:control']);
});

test('a scope that is not offered right now has no checkbox', async () => {
  const { base } = await recordingServer({ scopes: [SCOPES[0]!, { ...SCOPES[1]!, offered: async () => false }] });
  const html = await approvalPage(base);
  expect(html).toContain('value="notes:write"');
  expect(html).not.toContain('value="app:control"');
});

test('discovery metadata lists the declared scopes, and omits the list when none are declared', async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  for (const doc of ['oauth-authorization-server', 'oauth-protected-resource']) {
    const meta = (await (await fetch(`${base}/.well-known/${doc}`)).json()) as { scopes_supported?: string[] };
    expect(meta.scopes_supported).toEqual(['notes:write', 'app:control']);
  }
  const { base: plain } = await recordingServer();
  const meta = (await (await fetch(`${plain}/.well-known/oauth-authorization-server`)).json()) as { scopes_supported?: string[] };
  expect(meta.scopes_supported).toBeUndefined();
});

test('the page has no access section when no scopes are declared', async () => {
  const { base } = await recordingServer();
  expect(await approvalPage(base)).not.toContain('class="access"');
});

test("a client's request for declared scopes sets the starting ticks; other requests are ignored", async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  expect(ticked(await approvalPage(base, { scope: 'app:control' }))).toEqual(['app:control']);
  expect(ticked(await approvalPage(base, { scope: 'openid profile' }))).toEqual(['notes:write', 'app:control']);
});

test('an unticked scope is withheld from the connection, and the token response says so', async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  const token = await connect(base, ['app:control']);
  expect(token.scope).toBe('app:control');
  expect((await callWhoami(base, token.access_token)).scopes).toEqual(['app:control']);
});

test('ticking every box grants every scope', async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  const token = await connect(base, ['notes:write', 'app:control']);
  expect((await callWhoami(base, token.access_token)).scopes).toEqual(['notes:write', 'app:control']);
});

test('a posted scope that was not declared is never granted', async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  const token = await connect(base, ['admin']);
  expect((await callWhoami(base, token.access_token)).scopes).toEqual([]);
});

test('a scope that was not offered at approval counts as granted', async () => {
  let offered = false;
  const scopes = [SCOPES[0]!, { ...SCOPES[1]!, offered: () => offered }];
  const { base } = await recordingServer({ scopes });
  const token = await connect(base, []);
  offered = true;
  expect((await callWhoami(base, token.access_token)).scopes).toEqual(['app:control']);
});

test('a wrong password re-renders the page with the boxes as they were ticked', async () => {
  const { base } = await recordingServer({ scopes: SCOPES });
  const { challenge } = pkce();
  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code', client_id: 'test-client', redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256', password: 'wrong', grant: 'app:control',
    }),
  });
  expect(res.status).toBe(401);
  expect(ticked(await res.text())).toEqual(['app:control']);
});

test('withheld scopes survive a restart, and tokens issued before scopes were declared keep every scope', async () => {
  const tokenStorePath = storePath();
  const before = await recordingServer({ tokenStorePath, testMode: false });
  const legacy = await connect(before.base, []);
  const after = await recordingServer({ tokenStorePath, testMode: false, scopes: SCOPES });
  const narrowed = await connect(after.base, ['app:control']);
  const restarted = await recordingServer({ tokenStorePath, testMode: false, scopes: SCOPES });
  expect((await callWhoami(restarted.base, legacy.access_token)).scopes).toEqual(['notes:write', 'app:control']);
  expect((await callWhoami(restarted.base, narrowed.access_token)).scopes).toEqual(['app:control']);
});

test('the static bearer gets every scope by default, or the configured set', async () => {
  const all = await recordingServer({ scopes: SCOPES, staticBearerToken: 'static-abc' });
  expect((await callWhoami(all.base, 'static-abc')).scopes).toEqual(['notes:write', 'app:control']);
  const some = await recordingServer({ scopes: SCOPES, staticBearerToken: 'static-abc', staticBearerScopes: ['app:control'] });
  expect((await callWhoami(some.base, 'static-abc')).scopes).toEqual(['app:control']);
  const none = await recordingServer({ scopes: SCOPES, staticBearerToken: 'static-abc', staticBearerScopes: [] });
  expect((await callWhoami(none.base, 'static-abc')).scopes).toEqual([]);
});

test('scope config errors stop the server at construction', () => {
  const base = { baseUrl: 'http://localhost:1', clientId: 'c', displayName: 'd', tokenStorePath: storePath(), approvalPassword: 'p', testMode: true };
  expect(() => createAuth({ ...base, scopes: SCOPES, staticBearerScopes: ['nope'] })).toThrow(/not a declared scope/);
  expect(() => createAuth({ ...base, scopes: [SCOPES[0]!, SCOPES[0]!] })).toThrow(/unique/);
  expect(() => createAuth({ ...base, scopes: [{ id: 'has space', label: 'x' }] })).toThrow(/scope token/);
});
