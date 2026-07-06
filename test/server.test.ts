// HTTP-level suite exercising the kit through an assembled server: the health contract, /mcp
// method gating and tool listing, CORS behavior, and the result-helper shapes observable through
// the fixture's echo tool. Tests speak HTTP only — no imports of kit internals.
import { afterEach, expect, test } from 'bun:test';
import type { Express } from 'express';
import type { Server } from 'http';
import { createApp } from '../src/index.js';
import { createFixtureApp, FIXTURE_TOKEN } from '../fixture/server.js';

const open: Server[] = [];

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function listen(app: Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      open.push(server);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// A permissive stub middleware for the health-only apps (health is gated by its own token).
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

function healthApp(opts: { healthToken?: string; healthProbe?: () => void | Promise<void> }): Express {
  return createApp({
    name: 'health-fixture',
    version: '9.9.9',
    authMiddleware: passThrough as never,
    registerTools: () => {},
    testMode: true,
    healthToken: opts.healthToken,
    healthProbe: opts.healthProbe,
  });
}

async function mcp(base: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// Streamable-HTTP responses come back as JSON or SSE-wrapped JSON; parse either.
function parseRpc(text: string): { result?: any; error?: { message: string } } {
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

// --- Health contract ---------------------------------------------------------

test('health is 404 when no token is configured', async () => {
  const base = await listen(healthApp({}));
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(404);
});

test('health is 401 without or with a wrong bearer', async () => {
  const base = await listen(healthApp({ healthToken: 'secret' }));
  expect((await fetch(`${base}/health`)).status).toBe(401);
  const bad = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer nope' } });
  expect(bad.status).toBe(401);
});

test('health is 200 with the right bearer and reports ok/version/uptime', async () => {
  const base = await listen(healthApp({ healthToken: 'secret' }));
  const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer secret' } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; version: string; uptime_seconds: number };
  expect(body.ok).toBe(true);
  expect(body.version).toBe('9.9.9');
  expect(typeof body.uptime_seconds).toBe('number');
});

test('health is 503 when the liveness probe throws', async () => {
  const base = await listen(
    healthApp({
      healthToken: 'secret',
      healthProbe: () => {
        throw new Error('mount gone');
      },
    }),
  );
  const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer secret' } });
  expect(res.status).toBe(503);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
});

// --- /mcp method gating ------------------------------------------------------

test('GET /mcp without a token is 401 (auth seam runs first)', async () => {
  const base = await listen(createFixtureApp().app);
  expect((await fetch(`${base}/mcp`)).status).toBe(401);
});

test('GET /mcp with a valid token is 405 and advertises POST', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` } });
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('POST');
});

test('DELETE /mcp with a valid token is 405', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
  });
  expect(res.status).toBe(405);
});

test('POST /mcp without a token is 401', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await mcp(base, null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  expect(res.status).toBe(401);
});

// --- Tool listing and result-helper shapes -----------------------------------

test('POST /mcp initialize returns the configured server name', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await mcp(base, FIXTURE_TOKEN, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  expect(res.status).toBe(200);
  const body = parseRpc(await res.text());
  expect(body.result.serverInfo.name).toBe('mcp-server-kit-fixture');
});

test('tools/list advertises the registered echo tool', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await mcp(base, FIXTURE_TOKEN, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const body = parseRpc(await res.text());
  const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
  expect(names).toContain('echo');
});

test('jsonResult surfaces both a text block and structuredContent', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await mcp(base, FIXTURE_TOKEN, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo', arguments: { message: 'hi' } },
  });
  const body = parseRpc(await res.text());
  expect(body.result.isError).toBeFalsy();
  expect(body.result.content[0].text).toContain('"echoed": "hi"');
  expect(body.result.structuredContent).toEqual({ echoed: 'hi' });
});

test('errorResult comes back as isError with the message text', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await mcp(base, FIXTURE_TOKEN, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'echo', arguments: { message: 'boom' } },
  });
  const body = parseRpc(await res.text());
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toContain('boom requested');
});

// --- CORS --------------------------------------------------------------------

test('default CORS allows any origin', async () => {
  const base = await listen(createFixtureApp().app);
  const res = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: 'https://a.example' } });
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
});

test('restricted CORS reflects an allowed origin and rejects others', async () => {
  const app = createApp({
    name: 'cors-fixture',
    version: '1.0.0',
    authMiddleware: passThrough as never,
    registerTools: () => {},
    testMode: true,
    corsOrigins: ['https://ok.example'],
  });
  const base = await listen(app);

  const ok = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: 'https://ok.example' } });
  expect(ok.status).toBe(204);
  expect(ok.headers.get('access-control-allow-origin')).toBe('https://ok.example');

  const bad = await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  expect(bad.status).toBe(403);
});
