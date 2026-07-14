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

`createAuth(config)` returns an OAuth 2.1 authorization server for an MCP server: discovery documents, an authorization-code flow with PKCE, file-persisted opaque token issuance, and the bearer middleware that guards `/mcp`. It accepts one pre-registered client by default. Pass the result to `createApp` as `auth`; the factory mounts its routes and wires its middleware.

### ChatGPT compatibility

This module accepts one configured `clientId`. It does not implement Client ID Metadata Documents. It can serve a client whose predefined OAuth client matches that configuration, but it is not a turnkey OAuth layer for hosted ChatGPT connectors. The [Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth) describes the registration modes those connectors expect.

For the local ChatGPT desktop app and Codex, document a `staticBearerToken` setup for your server and use an `Authorization: Bearer …` header in the client. The desktop app's bearer-token environment field expects a variable name, not a token value.

The module wraps the official MCP SDK's authorization server (`mcpAuthRouter` and `requireBearerAuth`) around a small custom provider, so it tracks the SDK's OAuth implementation and spec compliance for the wire surface (discovery documents, endpoint paths, error and `WWW-Authenticate` shapes). The kit's provider supplies only the three behaviors the SDK leaves to the server: a password-gated approval page, a static-bearer fallback, and a file-persisted token store. Each `createAuth` call is self-contained: its token store, code store, and configuration are per-instance, with no module-level singleton state.

The OAuth endpoints are those the SDK emits — notably the token endpoint is `/token` (not `/oauth/token`), and discovery is served at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.

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

### Dynamic client registration

Dynamic Client Registration (DCR) is disabled by default. Enable it only when you need an MCP client to create a public OAuth client at runtime, and provide the redirect URIs that server will accept. DCR requires `approvalPassword`; it cannot rely on a configured static-client secret or `approvalOpen` because registered clients are public.

```ts
const auth = createAuth({
  baseUrl: 'https://mcp.example.com',
  clientId: 'existing-client',
  displayName: 'my-mcp',
  tokenStorePath: './tokens.json',
  approvalPassword: process.env.APPROVAL_PASSWORD,
  dynamicClientRegistration: {
    allowedRedirectUris: [
      'com.example.mcp:/oauth/callback',
      'http://127.0.0.1/oauth/callback',
    ],
  },
});
```

When enabled, the SDK publishes `/register` in authorization-server metadata. It accepts only public clients (`token_endpoint_auth_method: 'none'`) using the authorization-code grant and `code` response type. Every registered redirect URI must match the allowlist. A loopback redirect may use any port so native clients can choose an ephemeral port.

Registration creates client metadata only. It never issues an authorization code or access token. A registered client still goes through the same approval page and password gate, and its client metadata and issued-token binding are stored beside the existing `token → expiry` entries in `tokenStorePath`.

### Managing registered clients

`createAuth` returns management methods for use behind your own administration surface. The kit does not expose an HTTP administration route. `listDynamicClients()` returns the registered public clients. `revokeDynamicClient(clientId)` permanently removes one registration and every access token issued to it. `clearDynamicClients()` permanently removes every DCR registration and their bound tokens. The revocation results include the number of registrations and tokens removed. If the token store cannot be updated, either revocation method throws and leaves the in-memory registration and tokens intact.

```ts
const clients = auth.listDynamicClients();

const result = auth.revokeDynamicClient(clients[0].client_id);
// { removed: true, revokedTokenCount: 3 }

const cleared = auth.clearDynamicClients();
// { removedClientCount: 4, revokedTokenCount: 12 }
```

Disabling `dynamicClientRegistration` rejects DCR registrations and their existing credentials while the setting is off. It does not delete the stored registrations, and these management methods remain available so an administrator can inspect or permanently revoke them. Re-enable DCR to accept those still-registered clients again. Use revocation when access must stay removed.

### The approval guard

`/authorize` is always reachable, so `createAuth` refuses to construct unless one of three guards is configured, and throws otherwise. Pick the one that matches your deployment:

| Configuration | Set | Behavior |
| --- | --- | --- |
| Password gate | `approvalPassword` | The approval page shows a password field; a code is issued only when the correct password is posted. |
| Client-secret guard | `clientSecret` (no password) | The approval page is click-to-approve, but token exchange requires the secret via `client_secret_post`, so a code alone is useless. |
| Explicit open | `approvalOpen: true` | Click-to-approve with no password or secret; declares that an external gateway (reverse proxy, zero-trust layer) already guards `/authorize`. |

### SDK behaviors to know

Two spots where the SDK's authorization-server metadata is fixed and the kit compensates in the provider:

- **Client secret vs. advertised auth methods.** When `clientSecret` is set, the token endpoint enforces it (a code cannot be exchanged without the matching secret). The SDK's discovery document still advertises `token_endpoint_auth_methods_supported: ['client_secret_post', 'none']` — the `none` method cannot be removed via configuration in this SDK version. Clients that read discovery and try `none` are rejected at the token endpoint with `invalid_client`. This mismatch is cosmetic (discovery over-advertises), not a security gap.
- **Refresh tokens.** The SDK's discovery always lists `refresh_token` in `grant_types_supported`. This server does not issue or accept refresh tokens (tokens live 30 days; clients re-authorize). A refresh-token request is rejected cleanly with `400 invalid_grant` rather than failing as a server error.

### Config

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Public base URL, baked into the discovery documents and the `WWW-Authenticate` hint at construction (the SDK resolves it once, not live per request). |
| `clientId` | `string` | The single OAuth `client_id` accepted. |
| `displayName` | `string` | Shown on the approval page ("Authorize \<displayName>") and as the protected-resource name. |
| `tokenStorePath` | `string` | File the issued tokens persist to; read at construction (unless `testMode`) and rewritten on each issuance and `saveTokens()`. |
| `clientSecret` | `string?` | Enables the client-secret guard (see above). |
| `allowedRedirectUris` | `string[]?` | Redirect-URI allowlist; defaults to `DEFAULT_ALLOWED_REDIRECT_URIS` (Claude, ChatGPT connectors, Cursor, Poke). |
| `dynamicClientRegistration` | `{ allowedRedirectUris: string[] }?` | Enables public-client DCR at `/register`; requires `approvalPassword`. Every registered redirect URI must match this separate allowlist; loopback ports may vary. |
| `staticBearerToken` | `string?` | A fixed bearer accepted on `/mcp` in addition to issued tokens, for clients that send a static `Authorization` header. |
| `approvalPassword` | `string?` | Enables the password gate. |
| `approvalOpen` | `boolean?` | Declares `/authorize` externally guarded. |
| `approvalPrompt` | `string?` | Body text on the approval page. |
| `testMode` | `boolean?` | Skips the disk load at construction and enables `seedTestToken()`. |
| `disableRateLimit` | `boolean?` | Turns off the SDK's per-endpoint rate limiting (on by default). |

The returned `Auth` exposes `authMiddleware`, `routes`, `saveTokens()`, `listDynamicClients()`, `revokeDynamicClient()`, `clearDynamicClients()`, and `seedTestToken()` (test-mode only).

## Audit logging

`createAuditLog(config)` returns an opt-in audit logger: an append-only JSONL trail of tool calls and feedback, plus a `registerLogged` wrapper that times each tool handler and records its outcome. It writes two files under `logDir` — `tool-calls.jsonl` (one line per call: timestamp, tool name, a summarized args object, ok/error, duration, and any error text) and `feedback.jsonl`. The kit holds no environment coupling: you supply the log directory, which argument names to redact, and the enable/suppress gates.

```ts
import { createAuditLog } from 'mcp-server-kit';

const { registerLogged, logFeedback, isLoggingEnabled } = createAuditLog({
  logDir: process.env.LOG_DIR ?? './logs',
  // Argument names whose values may carry user content; redacted at any depth, keeping the shape.
  redactedFields: ['content', 'value'],
  enabled: () => process.env.LOG_ENABLED !== 'false',
  suppressWrites: () => process.env.NODE_ENV === 'test',
});

// In your registerTools function, register a tool through the wrapper instead of server.registerTool:
registerLogged(server, 'my_tool', def, async (args) => jsonResult(await doWork(args)));
```

Argument summarization keeps logs small and content-free: strings over 80 characters become a `<str:Nchars>` marker, and any field named in `redactedFields` becomes `<redacted:…>` regardless of type or depth, so a record retains which tool ran and what argument keys it received without recording the values themselves.

### Config

| Field | Type | Notes |
| --- | --- | --- |
| `logDir` | `string` | Directory the JSONL files are written to; created lazily on the first write. |
| `redactedFields` | `Iterable<string>?` | Argument names whose values are always redacted, matched by exact key at any depth. Default: redact nothing. |
| `toolCallsFile` | `string?` | Filename for tool-call records. Default `tool-calls.jsonl`. |
| `feedbackFile` | `string?` | Filename for feedback records. Default `feedback.jsonl`. |
| `enabled` | `() => boolean?` | Evaluated live on each call; when it returns false nothing is written and `isLoggingEnabled()` reports false. Default: on. |
| `suppressWrites` | `() => boolean?` | Evaluated live; when true, records are summarized but never written (for test runs). Default: off. |

The returned `AuditLogger` exposes `registerLogged`, `logToolCall`, `logFeedback`, `summarizeArgs`, and `isLoggingEnabled`.

## Process helpers

`startServer({ app, port, host?, onListen?, onShutdown? })` starts listening and registers `SIGTERM`/`SIGINT` handlers that run `onShutdown` (persist state here) before exiting, so a container restart doesn't drop in-memory data.

## Development

```bash
bun install
bun test
```

The suite assembles the fixture server and exercises it over HTTP: the health contract, `/mcp` method gating and tool listing, CORS behavior, the result-helper shapes observable through the fixture's `echo` tool, the full auth contract (discovery, the PKCE flow, all three approval-gate configurations, static bearer, and error shapes), token persistence across a spawned-process restart, and the audit-logging module's summarization, record shapes, gates, and `registerLogged` wrapper.
