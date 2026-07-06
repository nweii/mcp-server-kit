// A minimal MCP server assembled entirely from the kit: a stub bearer-check standing in for the
// auth module, one trivial registered tool, and the app factory. Serves as the kit's own example
// and the target of its HTTP test suite.
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { createApp, startServer, jsonResult, errorResult } from '../src/index.js';

// Stub auth seam: accept a single static bearer. The real auth module plugs in here later.
export const FIXTURE_TOKEN = process.env.FIXTURE_TOKEN ?? 'fixture-token';

const stubBearer: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== FIXTURE_TOKEN) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

export function createFixtureApp() {
  return createApp({
    name: 'mcp-server-kit-fixture',
    version: '0.0.0',
    authMiddleware: stubBearer,
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
}

// Running the file directly starts a real listener (the quickstart entry point).
if (import.meta.main) {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  startServer({
    app: createFixtureApp(),
    port,
    onListen: () => console.log(`fixture MCP server listening on port ${port}`),
  });
}
