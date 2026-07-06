// HTTP contract pins for bearer-token persistence across a real server restart. Because the token
// store persists to a file, faithful persistence can only be observed across a genuine process
// boundary — so this suite spawns the fixture server entry point, exercises it over HTTP, restarts
// it against the same store file, and never imports any internals. The spawned processes run with
// auth test-mode OFF so the startup token load actually runs; that load is the behavior under test.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PRESEEDED = 'preseeded-token-fixture';
const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;

const dir = mkdtempSync(join(tmpdir(), 'kit-persist-'));
const storePath = join(dir, 'tokens.json');
const children: Subprocess[] = [];

// Seed a token into the store before any server starts, so the first process's startup load sees it.
writeFileSync(storePath, JSON.stringify({ [PRESEEDED]: farFuture }));

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

// Launch fixture/server.ts on `port` against the shared store, under the explicit-open approval gate
// so codes issue without a password. Auth test-mode is left OFF so tokens load at boot.
async function startServer(port: number): Promise<string> {
  const env = {
    ...process.env,
    PORT: String(port),
    TOKEN_STORE_PATH: storePath,
    FIXTURE_CLIENT_ID: 'test-client',
    MCP_BASE_URL: `http://localhost:${port}`,
    FIXTURE_APPROVAL_OPEN: '1',
    FIXTURE_TEST_MODE: '1', // quiet request logging only
  };
  delete (env as Record<string, string | undefined>).FIXTURE_AUTH_TEST_MODE;
  const child = Bun.spawn(['bun', 'run', 'fixture/server.ts'], { cwd: process.cwd(), env, stdout: 'ignore', stderr: 'ignore' });
  children.push(child);

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      if (res.status === 200) return base;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not become ready`);
}

async function stop(child: Subprocess) {
  child.kill('SIGTERM');
  await child.exited;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function issueToken(base: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const authRes = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
  const tokRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'test-client',
      redirect_uri: REDIRECT,
    }),
  });
  return ((await tokRes.json()) as { access_token: string }).access_token;
}

let firstBase: string;

beforeAll(async () => {
  firstBase = await startServer(await freePort());
});

afterAll(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a token from the on-disk store is accepted at startup', async () => {
  const res = await fetch(`${firstBase}/mcp`, { headers: { Authorization: `Bearer ${PRESEEDED}` } });
  expect(res.status).toBe(405); // reaches the POST-only handler, so the persisted token was honored
});

test('a freshly issued token is written to the store and survives a restart', async () => {
  const token = await issueToken(firstBase);

  // Written to disk alongside the preseeded token.
  const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, number>;
  expect(persisted[token]).toBeGreaterThan(Date.now());
  expect(persisted[PRESEEDED]).toBe(farFuture);

  // Stop the first process and start a fresh one against the same store.
  await stop(children[0]!);
  const secondBase = await startServer(await freePort());

  // The new process, loading only from disk, still honors the token issued by the old process.
  const res = await fetch(`${secondBase}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(405);
});
