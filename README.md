# mcp-server-kit

Build a remote [MCP](https://modelcontextprotocol.io) server on Bun, Express, and the MCP TypeScript SDK. The kit provides CORS, request logging, a bearer-gated health endpoint, and a stateless streamable-HTTP `/mcp` route around your own tool-registration function. It also includes OAuth, result, audit-log, and shutdown helpers.

Use `createApp` with your own `authMiddleware` when you already have an authentication layer. Use `createAuth` when this server should issue and verify OAuth access tokens itself.

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

The package includes `express` and `@modelcontextprotocol/sdk`. The quickstart uses `zod`; add it to your application if it is not already installed.

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

- **CORS** — allows any origin by default; pass `corsOrigins: ['https://…']` to restrict. A disallowed browser preflight is rejected with 403. CORS does not authenticate remote MCP clients.
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

`createAuth(config)` creates an OAuth 2.1 authorization server for an MCP server. It provides discovery documents, an authorization-code flow with PKCE, file-persisted opaque access tokens, and bearer middleware for `/mcp`. Pass the returned value to `createApp` as `auth`; the factory mounts its routes and uses its middleware.

The module wraps the MCP TypeScript SDK's `mcpAuthRouter` and `requireBearerAuth`. The SDK handles the OAuth wire surface; the kit supplies the approval page, client policy, and persisted token store. Each `createAuth` call has its own configuration and state.

### Choose a client model

| Client model | Configure | Use when |
| --- | --- | --- |
| Pre-registered OAuth client | `clientId` and `allowedRedirectUris` | You know the MCP client identifier and callback URI ahead of time. |
| Dynamic Client Registration (DCR) | `dynamicClientRegistration` | The client can register its own public OAuth client, such as ChatGPT desktop or Codex. |
| Static bearer | `staticBearerToken` | A client can send a shared `Authorization` header but cannot use OAuth. |

You can enable the first two together. A request is accepted when its bearer token came from a valid OAuth flow or matches `staticBearerToken`.

### Start with a pre-registered client

Use this path when a client lets you supply its OAuth client ID and redirect URI. `clientId` and `allowedRedirectUris` describe that one known client.

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

const app = createApp({
  name: 'my-mcp',
  version: '1.0.0',
  auth,
  registerTools() {
    // Register MCP tools here.
  },
});

// Persist issued tokens on clean shutdown so clients survive a restart.
startServer({ app, port, onShutdown: () => auth.saveTokens() });
```

The kit takes resolved values, not env-var names. Map your own environment at the call site.

### Use dynamic client registration when the client chooses its own ID

Dynamic Client Registration (DCR) lets an MCP client create its own public OAuth client at runtime, so a client you never configured — ChatGPT desktop, Codex — can connect with no per-client server change. It is disabled by default. Enable it by passing `dynamicClientRegistration`; pass `{}` for standard open registration.

DCR requires `approvalPassword`. With open registration that password is the gate: it is what stops a self-registered public client from gaining access. A static client secret cannot substitute (public clients do not present one), and `approvalOpen` is not enough either (it delegates the gate to a proxy the self-registering client may not pass through).

```ts
const auth = createAuth({
  baseUrl: 'https://mcp.example.com',
  clientId: 'existing-client',
  displayName: 'my-mcp',
  tokenStorePath: './tokens.json',
  approvalPassword: process.env.APPROVAL_PASSWORD,
  dynamicClientRegistration: {}, // open registration; the approval password is the gate
});
```

When enabled, the SDK publishes `/register` in authorization-server metadata. It accepts only public clients (`token_endpoint_auth_method: 'none'`) using the authorization-code grant and `code` response type. By default a client's own declared redirect URIs are accepted (plaintext `http` is refused except on loopback), and the SDK matches them exactly against that client at `/authorize` — the per-client validation OAuth 2.1 requires. This is how DCR is meant to work: the operator does not maintain a list of clients' callback URLs.

Optionally, restrict which redirects may register with `allowedRedirectUris`. Each entry is an exact redirect URI, a loopback URI (any port may vary, for native clients), or a host-scoped `https://host/*` pattern that accepts any path on that origin — useful when a provider's callback path is ephemeral (e.g. ChatGPT mints a per-connector id). Prefer host-scoping over exact paths for such providers; a bare exact URI would need updating whenever the client re-registers.

```ts
// Optional hardening — only if you want a closed server:
dynamicClientRegistration: {
  allowedRedirectUris: ['https://chatgpt.com/*', 'com.example.mcp:/oauth/callback'],
}
```

Registration creates client metadata only. It never issues an authorization code or access token. A registered client still goes through the same approval page and password gate, and its client metadata and issued-token binding are stored beside the existing `token → expiry` entries in `tokenStorePath`.

ChatGPT desktop and Codex can use this route because they can discover `/register` and complete OAuth. Hosted connectors can have separate registration requirements; this kit supports pre-registered OAuth and DCR, not Client ID Metadata Documents. See the [Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth) when you are configuring a hosted connector.

### Use static bearer only for a client without OAuth

`staticBearerToken` accepts one fixed bearer token on `/mcp` in addition to tokens issued by OAuth. It is useful for a client that can send an `Authorization` header but cannot complete OAuth. Treat it like a password: keep it out of source control, store it in the client and server's secret storage, and rotate it when that client loses access.

Static bearer does not replace the approval guard. OAuth-capable clients should use the OAuth flow instead, especially when DCR is available.

### Managing registered clients

`createAuth` returns management methods for use behind your own administration surface. The kit does not expose an HTTP administration route. `listDynamicClients()` returns registered public clients. `revokeDynamicClient(clientId)` permanently removes one registration and every access token issued to it. `clearDynamicClients()` does the same for every DCR registration. If the token store cannot be updated, either revocation method throws and leaves the in-memory registration and tokens intact.

```ts
const clients = auth.listDynamicClients();

const result = auth.revokeDynamicClient(clients[0].client_id);
// { removed: true, revokedTokenCount: 3 }

const cleared = auth.clearDynamicClients();
// { removedClientCount: 4, revokedTokenCount: 12 }
```

Disabling `dynamicClientRegistration` rejects DCR registrations and their existing credentials without deleting them. Re-enable it to accept still-registered clients again. Use revocation when access must stay removed; management methods remain available while DCR is disabled.

### The approval guard

`/authorize` is always reachable, so `createAuth` refuses to construct unless one of three guards is configured, and throws otherwise. Pick the one that matches your deployment:

| Configuration | Set | Behavior |
| --- | --- | --- |
| Password gate | `approvalPassword` | The approval page shows a password field; a code is issued only when the correct password is posted. |
| Client-secret guard | `clientSecret` (no password) | The approval page is click-to-approve, but token exchange requires the secret via `client_secret_post`, so a code alone is useless. |
| Explicit open | `approvalOpen: true` | Click-to-approve with no password or secret; declares that an external gateway (reverse proxy, zero-trust layer) already guards `/authorize`. |

### OAuth details to know

The SDK sets the OAuth endpoint paths. The token endpoint is `/token`, not `/oauth/token`; discovery is served at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.

Two SDK metadata details are fixed upstream:

- **Client secret vs. advertised auth methods.** When `clientSecret` is set, the token endpoint enforces it (a code cannot be exchanged without the matching secret). The SDK's discovery document still advertises `token_endpoint_auth_methods_supported: ['client_secret_post', 'none']` — the `none` method cannot be removed via configuration in this SDK version. Clients that read discovery and try `none` are rejected at the token endpoint with `invalid_client`. This mismatch is cosmetic (discovery over-advertises), not a security gap.
- **Refresh tokens.** The SDK's discovery always lists `refresh_token` in `grant_types_supported`. This server does not issue or accept refresh tokens (tokens live 30 days; clients re-authorize). A refresh-token request is rejected cleanly with `400 invalid_grant` rather than failing as a server error.

### Config

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Public base URL, baked into the discovery documents and the `WWW-Authenticate` hint at construction (the SDK resolves it once, not live per request). |
| `clientId` | `string` | The single pre-registered OAuth client ID. Required even when DCR is enabled. |
| `displayName` | `string` | Shown on the approval page ("Authorize \<displayName>") and as the protected-resource name. |
| `tokenStorePath` | `string` | File the issued tokens persist to; read at construction (unless `testMode`) and rewritten on each issuance and `saveTokens()`. |
| `clientSecret` | `string?` | Enables the client-secret guard (see above). |
| `allowedRedirectUris` | `string[]?` | Redirect URIs for the pre-registered client only. Defaults to `DEFAULT_ALLOWED_REDIRECT_URIS`. |
| `dynamicClientRegistration` | `{ allowedRedirectUris?: string[] }?` | Enables public-client DCR at `/register`; requires `approvalPassword`. Pass `{}` for open registration (clients' own declared redirects, matched per-client at `/authorize`). Set `allowedRedirectUris` only to restrict which redirects may register — exact, loopback (any port), or host-scoped `https://host/*`. |
| `staticBearerToken` | `string?` | A fixed bearer accepted on `/mcp` in addition to issued OAuth tokens. Use only for clients that cannot use OAuth. |
| `approvalPassword` | `string?` | Enables the password gate. |
| `approvalOpen` | `boolean?` | Declares `/authorize` externally guarded. |
| `approvalPrompt` | `string?` | Body text on the approval page. |
| `testMode` | `boolean?` | Skips the disk load at construction and enables `seedTestToken()`. |
| `disableRateLimit` | `boolean?` | Turns off the SDK's per-endpoint rate limiting (on by default). |

The returned `Auth` exposes `authMiddleware`, `routes`, `saveTokens()`, `listDynamicClients()`, `revokeDynamicClient()`, `clearDynamicClients()`, and `seedTestToken()` (test-mode only).

## Audit logging

`createAuditLog(config)` returns an opt-in JSONL audit trail for tool calls and feedback. Its `registerLogged` wrapper times each tool handler and records its outcome. It writes `tool-calls.jsonl` (timestamp, tool name, summarized arguments, outcome, duration, and error text) and `feedback.jsonl` under `logDir`.

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

Argument summarization keeps logs small. Strings over 80 characters become a `<str:Nchars>` marker. Any field named in `redactedFields` becomes `<redacted:…>` regardless of type or depth. Short strings are retained unless their field name is redacted, so include every argument name that can carry user content or a secret.

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
