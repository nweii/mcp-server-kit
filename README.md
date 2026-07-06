# mcp-server-kit

Shared scaffolding for building a remote [MCP](https://modelcontextprotocol.io) server on Bun, Express, and the MCP TypeScript SDK. It assembles the plumbing every such server needs — CORS, request logging, a bearer-gated health endpoint, and the stateless streamable-HTTP `/mcp` mount — around your own tool-registration function. It also ships an OAuth auth module, tool-result helpers, and process entry/shutdown helpers.

Two ways to guard `/mcp`: pass the built-in auth module (`createAuth`, below) for a full Claude-facing OAuth surface, or pass a bare `authMiddleware` when you only need a custom check (a static-token gate, or a stub in tests).

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
| `auth` | `Auth?` | The auth module from `createAuth`; mounts its OAuth routes and guards `/mcp`. Provide this or `authMiddleware`. |
| `authMiddleware` | `express.RequestHandler?` | A bare middleware guarding `/mcp`, as an alternative to `auth`. Ignored when `auth` is set. |
| `healthToken` | `string?` | Bearer for `/health`; omit to return `404`. |
| `corsOrigins` | `string[] \| null?` | Allowed origins; omit or `null` for `*`. |
| `healthProbe` | `() => void \| Promise<void>?` | Optional liveness check; throwing yields `503`. |
| `testMode` | `boolean?` | Suppresses per-request console logging. |

## Result helpers

Tool handlers return one of three shapes so the MCP `CallToolResult` is built once:

- `textResult(text)` — a single text block.
- `jsonResult(data, { structured? })` — pretty-printed JSON as text, plus `structuredContent` by default (arrays wrapped as `{ items }`, primitives omitted). Pass `{ structured: false }` for text only.
- `errorResult(err)` — an `isError: true` result carrying `err.message` (or `String(err)`).

## Auth module

`createAuth(config)` returns an OAuth 2.1 authorization server for the Claude-facing side of your MCP server: discovery documents, an authorization-code flow with PKCE, file-persisted opaque token issuance, and the bearer middleware that guards `/mcp`. Pass the result to `createApp` as `auth`; the factory mounts its routes and wires its middleware.

The module carries its own OAuth implementation rather than delegating to the SDK's auth router, so the exact HTTP surface — endpoint paths (`/oauth/token`, the `.well-known` documents), error bodies, `WWW-Authenticate` headers, and token/code TTLs — stays fully under your control. Each `createAuth` call is self-contained: its token store, code store, and configuration are per-instance, with no module-level singleton state.

```ts
import { createApp, createAuth, startServer } from 'mcp-server-kit';

const port = parseInt(process.env.PORT ?? '3000', 10);

const auth = createAuth({
  baseUrl: process.env.MCP_BASE_URL ?? `http://localhost:${port}`,
  clientId: process.env.MCP_CLIENT_ID!,
  displayName: 'my-mcp',
  tokenStorePath: process.env.TOKEN_STORE_PATH ?? './tokens.json',
  approvalPassword: process.env.APPROVAL_PASSWORD, // enables the password gate
});

const app = createApp({ name: 'my-mcp', version: '1.0.0', auth, registerTools /* … */ });

// Persist issued tokens on clean shutdown so clients survive a restart.
startServer({ app, port, onShutdown: () => auth.saveTokens() });
```

The kit takes resolved values, not env-var names — map your own environment at the call site.

### The approval guard

`/authorize` is always reachable, so `createAuth` refuses to construct unless one of three guards is configured, and throws otherwise. Pick the one that matches your deployment:

| Configuration | Set | Behavior |
| --- | --- | --- |
| Password gate | `approvalPassword` | The approval page shows a password field; a code is issued only when the correct password is posted. |
| Client-secret guard | `clientSecret` (no password) | The approval page is click-to-approve, but token exchange requires the secret via `client_secret_post`, so a code alone is useless. Discovery drops the `none` auth method. |
| Explicit open | `approvalOpen: true` | Click-to-approve with no password or secret; declares that an external gateway (reverse proxy, zero-trust layer) already guards `/authorize`. |

### Config

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string \| (() => string)` | Public base URL, used in discovery and the `WWW-Authenticate` hint. Pass a getter to resolve live (e.g. when the port is known only after binding). |
| `clientId` | `string` | The single OAuth `client_id` accepted. |
| `displayName` | `string` | Shown on the approval page ("Authorize \<displayName>"). |
| `tokenStorePath` | `string` | File the issued tokens persist to; read at construction (unless `testMode`) and rewritten on each issuance and `saveTokens()`. |
| `clientSecret` | `string?` | Enables the client-secret guard (see above). |
| `allowedRedirectUris` | `string[]?` | Redirect-URI allowlist; defaults to `DEFAULT_ALLOWED_REDIRECT_URIS` (Claude, ChatGPT connectors, Cursor, Poke). |
| `staticBearerToken` | `string?` | A fixed bearer accepted on `/mcp` in addition to issued tokens, for clients that send a static `Authorization` header. |
| `approvalPassword` | `string?` | Enables the password gate. |
| `approvalOpen` | `boolean?` | Declares `/authorize` externally guarded. |
| `approvalPrompt` | `string?` | Body text on the approval page. |
| `testMode` | `boolean?` | Skips the disk load at construction and enables `seedTestToken()`. |

The returned `Auth` exposes `authMiddleware`, `routes`, `saveTokens()`, and `seedTestToken()` (test-mode only).

## Process helpers

`startServer({ app, port, host?, onListen?, onShutdown? })` starts listening and registers `SIGTERM`/`SIGINT` handlers that run `onShutdown` (persist state here) before exiting, so a container restart doesn't drop in-memory data.

## Development

```bash
bun install
bun test
```

The suite assembles the fixture server and exercises it over HTTP: the health contract, `/mcp` method gating and tool listing, CORS behavior, the result-helper shapes observable through the fixture's `echo` tool, the full auth contract (discovery, the PKCE flow, all three approval-gate configurations, static bearer, and error shapes), and token persistence across a spawned-process restart.
