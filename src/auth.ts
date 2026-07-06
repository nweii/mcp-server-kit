// Claude-facing OAuth 2.1 authorization server for a remote MCP server: discovery documents, the
// authorization-code flow with PKCE, file-persisted opaque token issuance, and the bearer middleware
// that guards /mcp. The module carries its own OAuth implementation (rather than delegating to an
// SDK router) so the exact HTTP surface — endpoint paths, error bodies, headers, and TTLs — stays
// under the consumer's control. A factory call yields a self-contained instance with no module-level
// singleton state: its token store, code store, and configuration are all per-instance.
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Verified OAuth callback URIs for common MCP clients, used when a consumer does not supply its own
// allowlist. Passing `allowedRedirectUris` replaces this list wholesale.
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback', // Claude.ai / Anthropic
  'https://chatgpt.com/connector_platform_oauth_redirect', // ChatGPT connectors (OpenAI)
  'cursor://anysphere.cursor-mcp/oauth/callback', // Cursor
  'https://poke.com/api/v1/mcp/callback', // Poke
];

export interface AuthConfig {
  // Public base URL of this server, used in discovery documents and the WWW-Authenticate
  // resource_metadata hint. A string is resolved once; pass a getter to resolve live per request
  // (e.g. when the listening port is only known after the server binds).
  baseUrl: string | (() => string);
  // The single OAuth client_id this server accepts.
  clientId: string;
  // Shown in the approval page title and heading ("Authorize <displayName>").
  displayName: string;
  // File the issued tokens persist to, so they survive a restart. Read at construction (unless
  // testMode) and rewritten on every issuance and on saveTokens().
  tokenStorePath: string;
  // Optional client secret. When set, token exchange requires the same value via client_secret_post,
  // the discovery document drops the "none" auth method, and the approval guard is satisfied (a
  // stranger who reaches /authorize still cannot exchange the code without the secret).
  clientSecret?: string;
  // Allowed OAuth redirect URIs. Defaults to DEFAULT_ALLOWED_REDIRECT_URIS.
  allowedRedirectUris?: string[];
  // Optional long-lived bearer accepted on /mcp in addition to issued tokens, for clients that send
  // a fixed Authorization header. Not part of the OAuth flow.
  staticBearerToken?: string;
  // Enables the password gate: the approval page grows a password field and issues a code only when
  // the correct password is posted. Satisfies the approval guard.
  approvalPassword?: string;
  // Explicitly declares /authorize acceptably guarded by an external gateway (reverse proxy or
  // zero-trust layer). Satisfies the approval guard without a password or client secret.
  approvalOpen?: boolean;
  // Body text on the approval page ("Allow this client to …?"). Defaults to a generic prompt.
  approvalPrompt?: string;
  // When true, skips loading the persisted token store at construction and enables seedTestToken.
  // Leave false in production so tokens load at boot.
  testMode?: boolean;
}

// The instance returned by createAuth. `routes` carries discovery + /authorize + /oauth/token;
// `authMiddleware` is the bearer gate for /mcp; `saveTokens` is for shutdown persistence.
export interface Auth {
  authMiddleware: RequestHandler;
  routes: Router;
  saveTokens(): void;
  // Inserts a valid opaque token and returns it. Throws unless testMode is set.
  seedTestToken(): string;
}

interface PendingCode {
  codeChallenge: string;
  codeChallengeMethod: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  expiresAt: number;
}

// Per-instance token and authorization-code store. Tokens persist to disk; codes are in-memory only.
// Instantiated once per createAuth call — there is deliberately no module-level singleton, so tests
// (and multiple servers in one process) never share state through import side effects.
class TokenStore {
  private tokens = new Map<string, number>(); // token → expiry (ms epoch)
  private authCodes = new Map<string, PendingCode>(); // code → pending auth

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
    for (const [k, v] of this.authCodes) if (now > v.expiresAt) this.authCodes.delete(k);
  }

  addCode(code: string, pending: PendingCode): void {
    this.authCodes.set(code, pending);
  }

  takeCode(code: string): PendingCode | undefined {
    this.prune();
    return this.authCodes.get(code);
  }

  deleteCode(code: string): void {
    this.authCodes.delete(code);
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

  isValid(token: string): boolean {
    this.prune();
    const expiry = this.tokens.get(token);
    return expiry !== undefined && Date.now() <= expiry;
  }
}

// --- Small crypto/HTML helpers ------------------------------------------------

// Constant-time string comparison. A length mismatch returns early (so length can be inferred from
// timing), but equal-length inputs are compared without a content-dependent timing signal.
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The OAuth request params, re-emitted as hidden form inputs so POST /authorize carries everything
// GET validated. Absent optional params are dropped.
function buildAuthParamInputs(src: Record<string, string>): string {
  const params: [string, string | undefined][] = [
    ['response_type', src.response_type],
    ['client_id', src.client_id],
    ['redirect_uri', src.redirect_uri],
    ['code_challenge', src.code_challenge],
    ['code_challenge_method', src.code_challenge_method],
    ['state', src.state],
    ['scope', src.scope],
  ];
  return params
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, val]) => `<input type="hidden" name="${name}" value="${escapeHtml(val)}">`)
    .join('\n    ');
}

export function createAuth(config: AuthConfig): Auth {
  const resolveBaseUrl = typeof config.baseUrl === 'function' ? config.baseUrl : () => config.baseUrl as string;
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

  function wwwAuthenticate(extra = ''): string {
    const meta = `resource_metadata="${resolveBaseUrl()}/.well-known/oauth-protected-resource"`;
    return extra ? `Bearer ${meta}, ${extra}` : `Bearer ${meta}`;
  }

  function renderApprovalPage(inputsHtml: string, opts: { error?: string } = {}): string {
    const errorHtml = opts.error ? `<p style="color:#b00">${escapeHtml(opts.error)}</p>` : '';
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

  // --- Route handlers ---------------------------------------------------------

  // GET /.well-known/oauth-protected-resource  (RFC9728)
  function protectedResourceHandler(_req: Request, res: Response): void {
    const base = resolveBaseUrl();
    res.json({ resource: base, authorization_servers: [base] });
  }

  // GET /.well-known/oauth-authorization-server  (RFC8414)
  function discoveryHandler(_req: Request, res: Response): void {
    const base = resolveBaseUrl();
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: clientSecret ? ['client_secret_post'] : ['client_secret_post', 'none'],
    });
  }

  // GET /authorize — validate params, render the approval page.
  function authorizationHandler(req: Request, res: Response): void {
    const q = req.query as Record<string, string>;
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method } = q;

    if (response_type !== 'code') {
      res.status(400).send('Unsupported response_type');
      return;
    }
    if (client_id !== config.clientId) {
      res.status(400).send('Unknown client_id');
      return;
    }
    if (!allowedRedirectUris.includes(redirect_uri)) {
      res.status(400).send('redirect_uri not allowed');
      return;
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      res.status(400).send('PKCE with S256 is required');
      return;
    }

    res.type('html').send(renderApprovalPage(buildAuthParamInputs(q)));
  }

  // POST /authorize — user approved; generate a code and redirect back to the client.
  function authorizationApproveHandler(req: Request, res: Response): void {
    const b = req.body as Record<string, string>;
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = b;

    if (response_type !== 'code' || client_id !== config.clientId) {
      res.status(400).send('Invalid request');
      return;
    }
    if (!allowedRedirectUris.includes(redirect_uri)) {
      res.status(400).send('redirect_uri not allowed');
      return;
    }

    if (passwordGate) {
      const password = (b.password ?? '').toString();
      if (!passwordValid(password)) {
        res
          .status(401)
          .type('html')
          .send(renderApprovalPage(buildAuthParamInputs(b), { error: 'Incorrect password.' }));
        return;
      }
    }

    const code = randomUUID();
    store.addCode(code, {
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      clientId: client_id,
      redirectUri: redirect_uri,
      state,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  // POST /oauth/token — exchange an authorization code + code_verifier for an access token.
  function tokenHandler(req: Request, res: Response): void {
    const { grant_type, code, code_verifier, client_id, client_secret, redirect_uri } = req.body as Record<
      string,
      string
    >;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const pending = store.takeCode(code);
    if (!pending) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code' });
      return;
    }
    if (client_id !== pending.clientId || redirect_uri !== pending.redirectUri) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    if (clientSecret) {
      if (client_secret !== clientSecret) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
    } else if (client_secret !== undefined) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    if (!verifyPKCE(code_verifier ?? '', pending.codeChallenge)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    store.deleteCode(code); // single-use
    const token = store.issueToken();
    res.json({ access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000 });
  }

  // --- Bearer middleware ------------------------------------------------------

  function bearerMatchesStatic(token: string): boolean {
    if (!staticBearer) return false;
    return constantTimeEqual(token, staticBearer);
  }

  const authMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate());
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = authHeader.slice(7);
    if (!bearerMatchesStatic(token) && !store.isValid(token)) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate('error="invalid_token"'));
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    next();
  };

  const routes = express.Router();
  routes.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  routes.get('/.well-known/oauth-authorization-server', discoveryHandler);
  routes.get('/authorize', authorizationHandler);
  routes.post('/authorize', authorizationApproveHandler);
  routes.post('/oauth/token', tokenHandler);

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
