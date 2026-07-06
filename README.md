# mcp-server-kit

Shared scaffolding for building a remote [MCP](https://modelcontextprotocol.io) server on Bun, Express, and the MCP TypeScript SDK. It assembles the plumbing every such server needs — CORS, request logging, a bearer-gated health endpoint, and the stateless streamable-HTTP `/mcp` mount — around your own tool-registration function and auth middleware. It also ships tool-result helpers and process entry/shutdown helpers.

Authentication is deliberately not included. The app factory exposes an auth-middleware seam; you supply the check (a real OAuth bearer middleware, a static-token check, or a stub in tests).

## Install

The kit is distributed as a git dependency. With Bun:

```bash
bun add git+https://github.com/nweii/mcp-server-kit.git
```

If the repository is private and the git install cannot authenticate in your environment, clone it and install from a local path instead:

```bash
git clone https://github.com/nweii/mcp-server-kit.git
bun add ./mcp-server-kit
```

The package requires `express` and `@modelcontextprotocol/sdk` as peers; a consuming Bun project on the same stack already has them.

## Quickstart

Assemble a server from the factory, register your tools, and start it. The example below is the fixture server shipped in this repo (`fixture/server.ts`).

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { createApp, startServer, jsonResult, errorResult } from 'mcp-server-kit';

// Your auth seam. This stub accepts a single static bearer; swap in a real check.
const bearer: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== process.env.TOKEN) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

const app = createApp({
  name: 'my-mcp',
  version: '1.0.0',
  authMiddleware: bearer,
  healthToken: process.env.HEALTH_TOKEN, // omit to leave /health returning 404
  registerTools(server) {
    server.registerTool(
      'echo',
      { title: 'Echo', description: 'Returns its input.', inputSchema: { message: z.string() } },
      async ({ message }) =>
        message === 'boom' ? errorResult(new Error('boom')) : jsonResult({ echoed: message }),
    );
  },
});

startServer({ app, port: 3000 });
```

Run the fixture directly:

```bash
bun run fixture/server.ts
```

## What the factory gives you

`createApp(options)` returns an Express app with:

- **CORS** — allows any origin by default; pass `corsOrigins: ['https://…']` to restrict. A disallowed cross-origin preflight is rejected with 403.
- **Request logging** — one line per request with client IP, method, path, status, and duration. Suppressed when `testMode: true`.
- **`GET /health`** — returns `404` when no `healthToken` is configured, `401` on a missing or wrong bearer, and `200 { ok, version, uptime_seconds }` on a valid one. Pass an optional `healthProbe` (an async liveness check); if it throws, health responds `503 { ok: false, … }`.
- **`/mcp`** — `POST` mounts a stateless `StreamableHTTPServerTransport` around a fresh `McpServer` built from your `registerTools`, guarded by your `authMiddleware`. `GET` and `DELETE` return `405` (no standalone SSE, no session to delete in stateless mode).

### Options

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | MCP server display name. |
| `version` | `string` | Reported in MCP server info and the health body. |
| `registerTools` | `(server) => void \| Promise<void>` | Registers tools onto each per-request `McpServer`. |
| `authMiddleware` | `express.RequestHandler` | Guards `/mcp`. Auth lives outside the kit. |
| `healthToken` | `string?` | Bearer for `/health`; omit to return `404`. |
| `corsOrigins` | `string[] \| null?` | Allowed origins; omit or `null` for `*`. |
| `healthProbe` | `() => void \| Promise<void>?` | Optional liveness check; throwing yields `503`. |
| `testMode` | `boolean?` | Suppresses per-request console logging. |

## Result helpers

Tool handlers return one of three shapes so the MCP `CallToolResult` is built once:

- `textResult(text)` — a single text block.
- `jsonResult(data, { structured? })` — pretty-printed JSON as text, plus `structuredContent` by default (arrays wrapped as `{ items }`, primitives omitted). Pass `{ structured: false }` for text only.
- `errorResult(err)` — an `isError: true` result carrying `err.message` (or `String(err)`).

## Process helpers

`startServer({ app, port, host?, onListen?, onShutdown? })` starts listening and registers `SIGTERM`/`SIGINT` handlers that run `onShutdown` (persist state here) before exiting, so a container restart doesn't drop in-memory data.

## Development

```bash
bun install
bun test
```

The suite assembles the fixture server and exercises it over HTTP: the health contract, `/mcp` method gating and tool listing, CORS behavior, and the result-helper shapes observable through the fixture's `echo` tool.
