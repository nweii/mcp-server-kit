// A minimal MCP server assembled entirely from the kit: the real auth module (OAuth + bearer gate),
// one trivial registered tool, and the app factory. Serves as the kit's own example and the target
// of its HTTP test suite. Running the file directly starts a real listener, which the token-
// persistence test spawns as a subprocess so persistence is exercised across a true process boundary.
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { createApp, createAuth, startServer, jsonResult, errorResult } from '../src/index.js';
import type { AuthConfig } from '../src/index.js';

export const FIXTURE_CLIENT_ID = process.env.FIXTURE_CLIENT_ID ?? 'test-client';
export const FIXTURE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
// A static bearer the default fixture always accepts, so tests that only need a valid /mcp token
// don't have to run the full OAuth flow first.
export const FIXTURE_TOKEN = process.env.FIXTURE_STATIC_BEARER ?? 'fixture-token';

// Build an auth config from the environment, so the same fixture can be spawned as a real server
// under whatever gate configuration a test wants. Defaults to the explicit-open gate so a bare
// `bun run fixture/server.ts` boots without extra env; tests override to exercise the other gates.
export function authConfigFromEnv(port: number): AuthConfig {
  const password = process.env.FIXTURE_APPROVAL_PASSWORD || undefined;
  const clientSecret = process.env.FIXTURE_CLIENT_SECRET || undefined;
  const open = process.env.FIXTURE_APPROVAL_OPEN === '1';
  // At least one guard must be present. When the caller sets none, fall back to open so the fixture
  // still boots; the guard-refusal path is exercised by constructing createAuth directly in tests.
  const approvalOpen = open || (!password && !clientSecret);

  return {
    baseUrl: process.env.MCP_BASE_URL ?? `http://localhost:${port}`,
    clientId: FIXTURE_CLIENT_ID,
    displayName: process.env.FIXTURE_DISPLAY_NAME ?? 'mcp-server-kit-fixture',
    tokenStorePath: process.env.TOKEN_STORE_PATH ?? join(tmpdir(), `kit-fixture-tokens-${process.pid}.json`),
    clientSecret,
    staticBearerToken: FIXTURE_TOKEN,
    approvalPassword: password,
    approvalOpen,
    approvalPrompt: 'Allow this client to call the fixture MCP tools?',
    testMode: process.env.FIXTURE_AUTH_TEST_MODE === '1',
  };
}

export function createFixtureApp(port = 0) {
  const auth = createAuth(authConfigFromEnv(port));
  const app = createApp({
    name: 'mcp-server-kit-fixture',
    version: '0.0.0',
    auth,
    healthToken: process.env.FIXTURE_HEALTH_TOKEN,
    testMode: process.env.FIXTURE_TEST_MODE === '1',
    registerTools(server) {
      // One trivial tool that exercises the result helpers: echoes its input back through
      // jsonResult (so structuredContent is observable) and errors on a sentinel value.
      server.registerTool(
        'echo',
        {
          title: 'Echo',
          description: 'Returns the message it was given.',
          inputSchema: { message: z.string() },
        },
        async ({ message }: { message: string }) => {
          if (message === 'boom') return errorResult(new Error('boom requested'));
          return jsonResult({ echoed: message });
        },
      );
    },
  });
  return { app, auth };
}

// Running the file directly starts a real listener (the quickstart entry point and the target of
// the spawned-process persistence test).
if (import.meta.main) {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const { app, auth } = createFixtureApp(port);
  startServer({
    app,
    port,
    onListen: () => console.log(`fixture MCP server listening on port ${port}`),
    onShutdown: () => auth.saveTokens(),
  });
}
