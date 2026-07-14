// Claude-facing OAuth 2.1 for a remote MCP server, built on the MCP SDK's auth server: the SDK's
// mcpAuthRouter and requireBearerAuth wrap a custom OAuthServerProvider that carries the three
// behaviors the kit owns — a password-gated approval page interposed at /authorize, a static-bearer
// fallback on /mcp, and a file-persisted opaque token store. Each createAuth call is self-contained:
// its token store, code store, and configuration are per-instance, with no module-level singleton
// state. Leaning on the SDK means the OAuth wire surface (discovery, endpoint paths, error shapes)
// is whatever the SDK emits; the kit adds only the interposed behaviors.
import type { RequestHandler, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Verified OAuth callback URIs for common MCP clients, used when a caller does not supply its own
// allowlist. Passing `allowedRedirectUris` replaces this list wholesale.
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback', // Claude.ai / Anthropic
  'https://chatgpt.com/connector_platform_oauth_redirect', // ChatGPT connectors (OpenAI)
  'cursor://anysphere.cursor-mcp/oauth/callback', // Cursor
  'https://poke.com/api/v1/mcp/callback', // Poke
];

export interface AuthConfig {
  // Public base URL of this server. Used as the SDK's issuer/base URL, so it is baked into the
  // discovery documents at construction (the SDK does not resolve it live per request).
  baseUrl: string;
  // The single OAuth client_id this server accepts.
  clientId: string;
  // Shown in the approval page title and heading ("Authorize <displayName>").
  displayName: string;
  // File the issued tokens persist to, so they survive a restart. Read at construction (unless
  // testMode) and rewritten on every issuance and on saveTokens().
  tokenStorePath: string;
  // Optional client secret. When set, the SDK's token endpoint enforces it (a code alone cannot be
  // exchanged). See the README on the discovery-metadata mismatch this creates.
  clientSecret?: string;
  // Allowed OAuth redirect URIs. Defaults to DEFAULT_ALLOWED_REDIRECT_URIS.
  allowedRedirectUris?: string[];
  // Opt-in dynamic client registration: opens /register so clients that can't be pre-configured (e.g.
  // ChatGPT) can register themselves, no per-client server config. Trust rests on the approval gate,
  // PKCE, and the SDK's per-client exact redirect match at /authorize — so this requires
  // approvalPassword. Pass {} for standard open registration; set allowedRedirectUris only to
  // additionally restrict which redirects may register. Omit entirely to keep /register unavailable.
  dynamicClientRegistration?: DynamicClientRegistrationConfig;
  // Optional long-lived bearer accepted on /mcp in addition to issued tokens, for clients that send
  // a fixed Authorization header. Not part of the OAuth flow.
  staticBearerToken?: string;
  // Enables the password gate: the approval page grows a password field and issues a code only when
  // the correct password is posted. Satisfies the approval guard.
  approvalPassword?: string;
  // Explicitly declares /authorize acceptably guarded by an external gateway. Satisfies the guard
  // without a password or client secret.
  approvalOpen?: boolean;
  // Body text on the approval page ("Allow this client to …?"). Defaults to a generic prompt.
  approvalPrompt?: string;
  // When true, skips loading the persisted token store at construction and enables seedTestToken.
  testMode?: boolean;
  // When true, disables the SDK's per-endpoint rate limiting (useful under test load).
  disableRateLimit?: boolean;
}

export interface DynamicClientRegistrationConfig {
  // Optional operator hardening. Omit (or leave empty) for standard open registration: each client's
  // own declared redirect URIs are accepted, then matched exactly at /authorize by the SDK. When set,
  // registrations are additionally restricted to these entries — each is an exact redirect URI, a
  // loopback URI (any port may vary), or a host-scoped "https://host/*" pattern accepting any path on
  // that origin (useful when a provider's callback path is ephemeral, e.g. ChatGPT's connector id).
  allowedRedirectUris?: string[];
}

// The instance returned by createAuth. `routes` is the SDK auth router (discovery + /authorize +
// /token); `authMiddleware` is the SDK bearer gate for /mcp; `saveTokens` is for shutdown persistence.
export interface Auth {
  authMiddleware: RequestHandler;
  routes: RequestHandler;
  saveTokens(): void;
  // Returns registered public DCR clients. This remains available while DCR is disabled so an
  // administrator can inspect or permanently revoke credentials that are temporarily rejected.
  listDynamicClients(): OAuthClientInformationFull[];
  // Permanently removes one DCR registration and all access tokens issued to it. `removed` is
  // false when clientId does not name a dynamically registered client. Throws without changing
  // memory when the deletion cannot be persisted.
  revokeDynamicClient(clientId: string): { removed: boolean; revokedTokenCount: number };
  // Permanently removes every DCR registration and all access tokens issued to them. Throws
  // without changing memory when the deletion cannot be persisted.
  clearDynamicClients(): { removedClientCount: number; revokedTokenCount: number };
  // Inserts a valid opaque token and returns it. Throws unless testMode is set.
  seedTestToken(): string;
}

interface PendingCode {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

interface TokenRecord {
  expiry: number;
  clientId?: string;
}

interface PersistedAuthMetadata {
  clients?: Record<string, OAuthClientInformationFull>;
  tokenClientIds?: Record<string, string>;
}

const PERSISTED_METADATA_KEY = '__mcp_server_kit_auth_metadata__';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Per-instance token and authorization-code store. Tokens persist to disk; codes are in-memory only.
// Instantiated once per createAuth call — there is deliberately no module-level singleton, so tests
// (and multiple servers in one process) never share state through import side effects.
class TokenStore {
  private tokens = new Map<string, TokenRecord>(); // token → expiry and issuing client
  private codes = new Map<string, PendingCode>(); // code → pending auth
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor(
    private readonly storePath: string,
    load: boolean,
  ) {
    if (load) this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Record<string, unknown>;
      const metadata = data[PERSISTED_METADATA_KEY] as PersistedAuthMetadata | undefined;
      const tokenClientIds = metadata?.tokenClientIds ?? {};
      const now = Date.now();
      for (const [token, expiry] of Object.entries(data)) {
        if (typeof expiry === 'number' && expiry > now) {
          this.tokens.set(token, { expiry, clientId: tokenClientIds[token] });
        }
      }
      if (metadata?.clients) {
        for (const [clientId, client] of Object.entries(metadata.clients)) {
          if (isPersistedPublicClient(clientId, client)) this.clients.set(clientId, client);
        }
      }
      console.log(`[auth] loaded ${this.tokens.size} token(s) from ${this.storePath}`);
    } catch {
      // no store yet — start fresh
    }
  }

  save(): boolean {
    const temporaryPath = join(dirname(this.storePath), `.${basename(this.storePath)}.${randomUUID()}.tmp`);
    try {
      const data: Record<string, unknown> = {};
      const tokenClientIds: Record<string, string> = {};
      for (const [token, { expiry, clientId }] of this.tokens) {
        data[token] = expiry;
        if (clientId) tokenClientIds[token] = clientId;
      }
      if (this.clients.size || Object.keys(tokenClientIds).length) {
        data[PERSISTED_METADATA_KEY] = {
          ...(this.clients.size ? { clients: Object.fromEntries(this.clients) } : {}),
          ...(Object.keys(tokenClientIds).length ? { tokenClientIds } : {}),
        } satisfies PersistedAuthMetadata;
      }
      writeFileSync(temporaryPath, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporaryPath, this.storePath);
      return true;
    } catch (err) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file either was never created or cannot be removed after the write error.
      }
      console.error('[auth] failed to save token store:', err);
      return false;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.tokens) if (now > v.expiry) this.tokens.delete(k);
    for (const [k, v] of this.codes) if (now > v.expiresAt) this.codes.delete(k);
  }

  putCode(code: string, pending: PendingCode): void {
    this.codes.set(code, pending);
  }

  peekCode(code: string): PendingCode | undefined {
    this.prune();
    return this.codes.get(code);
  }

  takeCode(code: string): PendingCode | undefined {
    this.prune();
    const p = this.codes.get(code);
    if (p) this.codes.delete(code);
    return p;
  }

  issueToken(clientId: string, staticClientId: string): string {
    this.prune();
    const token = randomUUID();
    const previous = this.tokens.get(token);
    this.tokens.set(token, { expiry: Date.now() + TOKEN_TTL_MS, ...(clientId === staticClientId ? {} : { clientId }) });
    if (!this.save()) {
      if (previous) this.tokens.set(token, previous);
      else this.tokens.delete(token);
      throw new Error('Failed to persist access token; token was not issued');
    }
    return token;
  }

  // Adds a token without persisting to disk; for test seeding only.
  seed(): string {
    this.prune();
    const token = randomUUID();
    this.tokens.set(token, { expiry: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  // Returns the token's record if valid, else undefined.
  tokenRecord(token: string): TokenRecord | undefined {
    this.prune();
    const record = this.tokens.get(token);
    return record !== undefined && Date.now() <= record.expiry ? record : undefined;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    const previous = this.clients.get(client.client_id);
    this.clients.set(client.client_id, client);
    if (!this.save()) {
      if (previous) this.clients.set(client.client_id, previous);
      else this.clients.delete(client.client_id);
      throw new Error('Failed to persist dynamic client registration; registration was not created');
    }
    return client;
  }

  listClients(): OAuthClientInformationFull[] {
    return [...this.clients.values()].map((client) => structuredClone(client));
  }

  revokeClient(clientId: string): { removed: boolean; revokedTokenCount: number } {
    if (!this.clients.has(clientId)) return { removed: false, revokedTokenCount: 0 };
    const clients = new Map(this.clients);
    const tokens = new Map(this.tokens);
    this.clients.delete(clientId);
    let revokedTokenCount = 0;
    for (const [token, record] of this.tokens) {
      if (record.clientId === clientId) {
        this.tokens.delete(token);
        revokedTokenCount++;
      }
    }
    if (!this.save()) {
      this.clients = clients;
      this.tokens = tokens;
      throw new Error('Failed to persist dynamic client revocation; no client or token was removed');
    }
    return { removed: true, revokedTokenCount };
  }

  clearClients(): { removedClientCount: number; revokedTokenCount: number } {
    const clientIds = new Set(this.clients.keys());
    if (!clientIds.size) return { removedClientCount: 0, revokedTokenCount: 0 };
    const clients = new Map(this.clients);
    const tokens = new Map(this.tokens);
    let revokedTokenCount = 0;
    for (const [token, record] of this.tokens) {
      if (record.clientId && clientIds.has(record.clientId)) {
        this.tokens.delete(token);
        revokedTokenCount++;
      }
    }
    this.clients.clear();
    if (!this.save()) {
      this.clients = clients;
      this.tokens = tokens;
      throw new Error('Failed to persist dynamic client revocation; no client or token was removed');
    }
    return { removedClientCount: clientIds.size, revokedTokenCount };
  }
}

function isPersistedPublicClient(clientId: string, client: unknown): client is OAuthClientInformationFull {
  if (!client || typeof client !== 'object') return false;
  const record = client as Partial<OAuthClientInformationFull>;
  return record.client_id === clientId && Array.isArray(record.redirect_uris) && record.redirect_uris.every((uri) => typeof uri === 'string');
}

function isLoopbackRedirectMatch(requested: string, allowed: string): boolean {
  try {
    const requestUrl = new URL(requested);
    const allowedUrl = new URL(allowed);
    return (
      LOOPBACK_HOSTS.has(requestUrl.hostname) &&
      LOOPBACK_HOSTS.has(allowedUrl.hostname) &&
      requestUrl.protocol === allowedUrl.protocol &&
      requestUrl.hostname === allowedUrl.hostname &&
      requestUrl.pathname === allowedUrl.pathname &&
      requestUrl.search === allowedUrl.search
    );
  } catch {
    return false;
  }
}

// Matches a requested redirect against one operator-allowlist entry: exact string, a loopback URI on
// any port, or a host-scoped "https://host/*" (or "https://host/prefix/*") pattern that accepts any
// path under that exact origin. The wildcard exists because some providers mint an ephemeral last path
// segment per connector, so an exact path can't be pinned ahead of time.
function redirectMatchesAllowed(requested: string, allowed: string): boolean {
  if (requested === allowed) return true;
  if (isLoopbackRedirectMatch(requested, allowed)) return true;
  return isHostScopedMatch(requested, allowed);
}

function isHostScopedMatch(requested: string, allowed: string): boolean {
  if (!allowed.endsWith('/*')) return false;
  try {
    const allowedUrl = new URL(allowed.slice(0, -1)); // drop the '*', keep the path prefix
    const requestUrl = new URL(requested);
    return (
      requestUrl.protocol === allowedUrl.protocol &&
      requestUrl.host === allowedUrl.host &&
      requestUrl.pathname.startsWith(allowedUrl.pathname)
    );
  } catch {
    return false;
  }
}

// True only for plaintext http on a non-loopback host — the one redirect shape open registration
// declines. https, loopback http, and native custom-scheme redirects (e.g. com.example:/cb) are fine.
function isInsecureHttpRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// Human-readable label for the consent page: the client's declared name and/or the host it will send
// the user back to, so an unexpected approval is visible. Undefined when neither is available.
function describeRequester(client: OAuthClientInformationFull, redirectUri: string | undefined): string | undefined {
  let host: string | undefined;
  try {
    host = redirectUri ? new URL(redirectUri).host || undefined : undefined;
  } catch {
    host = undefined;
  }
  const name = (client as { client_name?: string }).client_name?.trim() || undefined;
  if (name && host) return `${name} (${host})`;
  return name ?? host;
}

// Constant-time string comparison. A length mismatch returns early (so length can be inferred from
// timing), but equal-length inputs are compared without a content-dependent timing signal.
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createAuth(config: AuthConfig): Auth {
  const allowedRedirectUris = config.allowedRedirectUris ?? DEFAULT_ALLOWED_REDIRECT_URIS;
  const dynamicRegistration = config.dynamicClientRegistration;
  const dynamicRedirectUris = dynamicRegistration?.allowedRedirectUris;
  const clientSecret = config.clientSecret?.trim() || undefined;
  const staticBearer = config.staticBearerToken?.trim() || undefined;
  const approvalPassword = config.approvalPassword || undefined;
  const passwordGate = approvalPassword !== undefined;
  const approvalPrompt = config.approvalPrompt ?? 'Allow this client to access the MCP server?';
  const testMode = config.testMode === true;

  // Refuse to construct with /authorize unguarded: a stranger who reached it could otherwise approve
  // their own client and gain access. Any one guard satisfies it — an approval password, a client
  // secret (which blocks token exchange), or the explicit open flag for a gateway-fronted deployment.
  if (!approvalPassword && !clientSecret && config.approvalOpen !== true) {
    throw new Error(
      'Refusing to start: the OAuth approval page has no guard, so anyone who reaches /authorize could ' +
        'approve their own client and gain access. Set an approval password, set a client secret, or set ' +
        'approvalOpen to true if a reverse proxy or zero-trust gateway already guards /authorize.',
    );
  }

  // Loud warning when the app itself is not gating /authorize. approvalOpen delegates the gate to an
  // external proxy this process cannot see or verify; if that proxy is missing, misconfigured, or
  // scoped to the wrong path, anyone who reaches /authorize can approve a client and gain access. The
  // boot guard above is satisfied, so this can only warn — but it makes the reliance impossible to
  // forget. (DCR cannot reach this state: it requires approvalPassword.)
  if (config.approvalOpen === true && !approvalPassword) {
    console.warn(
      '[mcp-server-kit] SECURITY: approvalOpen=true with no approvalPassword — this server does NOT ' +
        'guard /authorize itself. Confirm an external gateway (e.g. Cloudflare Access) actually fronts ' +
        '/authorize; otherwise anyone who reaches it can approve a client and gain access. Set an ' +
        'approvalPassword to gate it in the app instead.',
    );
  }

  // An operator allowlist is optional — open registration is the default. If one is provided, every
  // entry must be a valid URL (a "https://host/*" host-scoped pattern parses too); a malformed
  // allowlist is a config error, not a silent no-op that would quietly reject every real client.
  if (dynamicRegistration && dynamicRedirectUris?.some((uri) => !URL.canParse(uri))) {
    throw new Error('dynamicClientRegistration.allowedRedirectUris entries must all be valid URLs');
  }
  // DCR still requires the approval password: with open registration, that password is the gate that
  // stops a self-registered client from gaining access. A client secret can't substitute — public
  // clients don't present it — and neither can approvalOpen, since it delegates the gate to a proxy
  // that a self-registering client may not actually pass through.
  if (dynamicRegistration && !approvalPassword) {
    throw new Error('dynamicClientRegistration requires approvalPassword: it is the gate that stops a self-registered public client from gaining access');
  }

  // Always retain persisted DCR registrations, even while DCR is disabled. The provider still
  // rejects them in that mode, but loading them prevents a routine save from erasing registrations
  // and lets a server owner revoke them deliberately through the Auth API.
  const store = new TokenStore(config.tokenStorePath, !testMode);
  const staticClient: OAuthClientInformationFull = {
    client_id: config.clientId,
    client_secret: clientSecret,
    redirect_uris: allowedRedirectUris,
    token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  } as OAuthClientInformationFull;

  function unsafeDynamicClientReason(client: OAuthClientInformationFull): string | undefined {
    if (!dynamicRegistration) return 'Dynamic registration is disabled';
    if (!client.client_id) return 'Dynamic registration requires a generated client_id';
    if (client.client_secret || client.token_endpoint_auth_method !== 'none') {
      return 'Dynamic registration only accepts public clients using token_endpoint_auth_method "none"';
    }
    if (!client.redirect_uris.length) {
      return 'Dynamic registration requires at least one redirect_uri';
    }
    const hardened = !!dynamicRedirectUris?.length;
    if (hardened) {
      if (!client.redirect_uris.every((uri) => dynamicRedirectUris!.some((allowed) => redirectMatchesAllowed(uri, allowed)))) {
        return 'Every redirect_uri must be allowed by dynamicClientRegistration.allowedRedirectUris';
      }
    } else if (client.redirect_uris.some(isInsecureHttpRedirect)) {
      // Open registration accepts the client's own declared redirects (the SDK still matches them
      // exactly at /authorize, and the approval password gates the flow), but declines plaintext http
      // on a non-loopback host: a code delivered over http could be intercepted. Transport hygiene,
      // not a trust decision — https and native custom-scheme redirects are fine.
      return 'Dynamic registration requires https redirect URIs (http is allowed only for loopback)';
    }
    // Require the authorization-code grant and accept the optional refresh_token grant alongside it
    // (real clients, e.g. ChatGPT, register both — refresh_token is advertised in discovery). Reject
    // any other grant type.
    if (client.grant_types && (!client.grant_types.includes('authorization_code') ||
        client.grant_types.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token'))) {
      return 'Dynamic registration accepts only the authorization_code and refresh_token grants';
    }
    if (client.response_types && (!client.response_types.includes('code') ||
        client.response_types.some((type) => type !== 'code'))) {
      return 'Dynamic registration only accepts the code response type';
    }
    return undefined;
  }

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string): OAuthClientInformationFull | undefined => {
      if (clientId === staticClient.client_id) return staticClient;
      const client = store.getClient(clientId);
      return client && !unsafeDynamicClientReason(client) ? client : undefined;
    },
  };
  if (dynamicRegistration) {
    clientsStore.registerClient = (metadata) => {
      const client = metadata as OAuthClientInformationFull;
      const reason = unsafeDynamicClientReason(client);
      if (reason) throw new InvalidClientMetadataError(reason);
      return store.registerClient(client);
    };
  }

  function passwordValid(password: string): boolean {
    return constantTimeEqual(password, approvalPassword ?? '');
  }

  function renderApprovalPage(inputsHtml: string, opts: { error?: string; requester?: string } = {}): string {
    const errorHtml = opts.error ? `<p style="color:#b00">${escapeHtml(opts.error)}</p>` : '';
    const requesterHtml = opts.requester
      ? `<p style="color:#111;margin-bottom:1rem">Request from <strong>${escapeHtml(opts.requester)}</strong></p>`
      : '';
    const credentialFields = passwordGate
      ? `<div style="margin:0 0 1rem"><label>Password<br><input name="password" type="password" autocomplete="current-password"></label></div>`
      : '';
    const name = escapeHtml(config.displayName);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize ${name}</title>
  <style>
    body   { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 1rem; color: #111; }
    h1     { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p      { color: #555; margin-bottom: 1.5rem; }
    label  { color: #111; }
    input  { width: 100%; padding: 0.4rem; font-size: 1rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { padding: 0.5rem 1.5rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Authorize ${name}</h1>
  <p>${escapeHtml(approvalPrompt)}</p>
  ${requesterHtml}
  ${errorHtml}
  <form method="POST" action="/authorize">
    ${inputsHtml}
    ${credentialFields}
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
  }

  // The provider carries the kit's three behaviors; the SDK router drives everything around it.
  const provider: OAuthServerProvider = {
    get clientsStore(): OAuthRegisteredClientsStore {
      return clientsStore;
    },

    // Reached after the SDK validates client_id/redirect_uri (phase 1) and
    // response_type/code_challenge/S256 (phase 2). We interpose the approval page on GET and the
    // password-gated form on POST via res.req.
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const req = res.req;
      const body = (req.body ?? {}) as Record<string, string>;

      const hidden = [
        ['response_type', 'code'],
        ['client_id', client.client_id],
        ['redirect_uri', params.redirectUri],
        ['code_challenge', params.codeChallenge],
        ['code_challenge_method', 'S256'],
        ['state', params.state],
      ]
        .filter((e): e is [string, string] => e[1] !== undefined)
        .map(([n, v]) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`)
        .join('\n    ');

      // Shown on the approval page so the operator can see which client and callback host they are
      // approving — the visible check that matters most once /register is open to public clients.
      const requester = describeRequester(client, params.redirectUri);

      if (req.method === 'GET') {
        res.type('html').send(renderApprovalPage(hidden, { requester }));
        return;
      }

      // POST — the approval form was submitted.
      if (passwordGate && !passwordValid((body.password ?? '').toString())) {
        res.status(401).type('html').send(renderApprovalPage(hidden, { error: 'Incorrect password.', requester }));
        return;
      }

      const code = randomUUID();
      store.putCode(code, {
        codeChallenge: params.codeChallenge,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      const url = new URL(params.redirectUri);
      url.searchParams.set('code', code);
      if (params.state) url.searchParams.set('state', params.state);
      res.redirect(url.toString());
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const pending = store.peekCode(authorizationCode);
      if (!pending) throw new InvalidGrantError('Unknown or expired authorization code');
      return pending.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
    ): Promise<OAuthTokens> {
      const pending = store.takeCode(authorizationCode); // single-use
      if (!pending) throw new InvalidGrantError('Unknown or expired authorization code');
      if (client.client_id !== pending.clientId || redirectUri !== pending.redirectUri) {
        throw new InvalidGrantError('client_id or redirect_uri mismatch');
      }
      const token = store.issueToken(client.client_id, staticClient.client_id);
      return { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000 } as OAuthTokens;
    },

    // Refresh tokens are intentionally not issued or accepted: tokens live 30 days and clients
    // re-authorize. The SDK's discovery still advertises the refresh_token grant (it is not
    // configurable), so this reachable path rejects cleanly rather than 500-ing. See the README.
    async exchangeRefreshToken(): Promise<OAuthTokens> {
      throw new InvalidGrantError('refresh tokens are not supported');
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (staticBearer && constantTimeEqual(token, staticBearer)) {
        return {
          token,
          clientId: config.clientId,
          scopes: [],
          expiresAt: Math.floor((Date.now() + TOKEN_TTL_MS) / 1000),
        };
      }
      const record = store.tokenRecord(token);
      if (record !== undefined) {
        if (record.clientId) {
          const dynamicClient = store.getClient(record.clientId);
          if (!dynamicClient || unsafeDynamicClientReason(dynamicClient)) {
            throw new InvalidTokenError('invalid or expired access token');
          }
        }
        return { token, clientId: record.clientId ?? staticClient.client_id, scopes: [], expiresAt: Math.floor(record.expiry / 1000) };
      }
      // Must be an InvalidTokenError (not a plain Error) so the SDK bearer middleware answers 401.
      throw new InvalidTokenError('invalid or expired access token');
    },
  };

  const issuer = new URL(config.baseUrl);
  const rate = config.disableRateLimit ? { rateLimit: false as const } : undefined;
  const routes = mcpAuthRouter({
    provider,
    issuerUrl: issuer,
    baseUrl: issuer,
    resourceName: config.displayName,
    ...(rate ? { authorizationOptions: rate, tokenOptions: rate, clientRegistrationOptions: rate } : {}),
  });

  const authMiddleware = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource`,
  });

  return {
    authMiddleware,
    routes,
    saveTokens: () => store.save(),
    listDynamicClients: () => store.listClients(),
    revokeDynamicClient: (clientId) => store.revokeClient(clientId),
    clearDynamicClients: () => store.clearClients(),
    seedTestToken: () => {
      if (!testMode) throw new Error('seedTestToken is only available when testMode is set');
      return store.seed();
    },
  };
}
