// Claude-facing OAuth 2.1 for a remote MCP server, built on the MCP SDK's auth server: the SDK's
// mcpAuthRouter and requireBearerAuth wrap a custom OAuthServerProvider that carries the three
// behaviors the kit owns — a password-gated approval page interposed at /authorize, a static-bearer
// fallback on /mcp, and a file-persisted opaque token store. Each createAuth call is self-contained:
// its token store, code store, and configuration are per-instance, with no module-level singleton
// state. Leaning on the SDK means the OAuth wire surface (discovery, endpoint paths, error shapes)
// is whatever the SDK emits; the kit adds only the interposed behaviors.
import type { RequestHandler, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
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

// The instance returned by createAuth. `routes` is the SDK auth router (discovery + /authorize +
// /token); `authMiddleware` is the SDK bearer gate for /mcp; `saveTokens` is for shutdown persistence.
export interface Auth {
  authMiddleware: RequestHandler;
  routes: RequestHandler;
  saveTokens(): void;
  // Inserts a valid opaque token and returns it. Throws unless testMode is set.
  seedTestToken(): string;
}

interface PendingCode {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

// Per-instance token and authorization-code store. Tokens persist to disk; codes are in-memory only.
// Instantiated once per createAuth call — there is deliberately no module-level singleton, so tests
// (and multiple servers in one process) never share state through import side effects.
class TokenStore {
  private tokens = new Map<string, number>(); // token → expiry (ms epoch)
  private codes = new Map<string, PendingCode>(); // code → pending auth

  constructor(
    private readonly storePath: string,
    load: boolean,
  ) {
    if (load) this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Record<string, number>;
      const now = Date.now();
      for (const [token, expiry] of Object.entries(data)) {
        if (expiry > now) this.tokens.set(token, expiry);
      }
      console.log(`[auth] loaded ${this.tokens.size} token(s) from ${this.storePath}`);
    } catch {
      // no store yet — start fresh
    }
  }

  save(): void {
    try {
      const data: Record<string, number> = {};
      for (const [token, expiry] of this.tokens) data[token] = expiry;
      writeFileSync(this.storePath, JSON.stringify(data));
    } catch (err) {
      console.error('[auth] failed to save token store:', err);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.tokens) if (now > v) this.tokens.delete(k);
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

  issueToken(): string {
    this.prune();
    const token = randomUUID();
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    this.save();
    return token;
  }

  // Adds a token without persisting to disk; for test seeding only.
  seed(): string {
    this.prune();
    const token = randomUUID();
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  // Returns the token's expiry (ms epoch) if valid, else undefined.
  expiryOf(token: string): number | undefined {
    this.prune();
    const expiry = this.tokens.get(token);
    return expiry !== undefined && Date.now() <= expiry ? expiry : undefined;
  }
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

  const store = new TokenStore(config.tokenStorePath, !testMode);

  function passwordValid(password: string): boolean {
    return constantTimeEqual(password, approvalPassword ?? '');
  }

  function renderApprovalPage(inputsHtml: string, error?: string): string {
    const errorHtml = error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : '';
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
      return {
        getClient: (clientId: string): OAuthClientInformationFull | undefined => {
          if (clientId !== config.clientId) return undefined;
          return {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: allowedRedirectUris,
            token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
            grant_types: ['authorization_code'],
            response_types: ['code'],
          } as OAuthClientInformationFull;
        },
      };
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

      if (req.method === 'GET') {
        res.type('html').send(renderApprovalPage(hidden));
        return;
      }

      // POST — the approval form was submitted.
      if (passwordGate && !passwordValid((body.password ?? '').toString())) {
        res.status(401).type('html').send(renderApprovalPage(hidden, 'Incorrect password.'));
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
      const token = store.issueToken();
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
      const expiry = store.expiryOf(token);
      if (expiry !== undefined) {
        return { token, clientId: config.clientId, scopes: [], expiresAt: Math.floor(expiry / 1000) };
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
    ...(rate ? { authorizationOptions: rate, tokenOptions: rate } : {}),
  });

  const authMiddleware = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource`,
  });

  return {
    authMiddleware,
    routes,
    saveTokens: () => store.save(),
    seedTestToken: () => {
      if (!testMode) throw new Error('seedTestToken is only available when testMode is set');
      return store.seed();
    },
  };
}
