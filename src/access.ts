// ABOUTME: Auth middleware for a server behind a Cloudflare Access application with Managed OAuth:
// Access runs the sign-in and token lifecycle, and this verifies the signed identity it forwards.
import { createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server-legacy/auth';

export interface AccessAuthConfig {
  // The Zero Trust team domain, such as "myteam.cloudflareaccess.com". A bare host is read as https.
  teamDomain: string;
  // The Access application's audience (AUD) tag, from the application's overview in the dashboard.
  // Tokens minted for any other Access application in the team are refused.
  audience: string;
  // Scopes every Access caller holds. Access grants no scopes of its own, so a server that gates
  // tools by scope declares here what a signed-in user gets.
  scopes?: Array<string>;
}

// Header Access sets on every request it lets through to the origin.
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

// Seconds of clock skew tolerated on exp and nbf.
const CLOCK_SKEW_SECONDS = 60;
// Shortest gap between key refetches triggered by an unknown key id, so forged tokens can't make
// every request call out to Cloudflare.
const MIN_REFETCH_MS = 60_000;

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  email?: unknown;
  sub?: unknown;
  // Present on requests made with a Managed OAuth token: the client Access registered for that
  // connection.
  oauth?: { client_id?: unknown };
}

function teamUrl(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('createAccessAuth requires a teamDomain');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// Fetches the team's signing keys and keeps them, refetching when a token names a key id it hasn't
// seen (Access rotates keys) at most once per MIN_REFETCH_MS.
function makeKeyStore(certsUrl: string) {
  let keys = new Map<string, KeyObject>();
  let lastFetch = 0;
  let inFlight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const res = await fetch(certsUrl);
    if (!res.ok) throw new Error(`fetching Access keys returned ${res.status}`);
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid !== 'string') continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
  }

  return async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const known = keys.get(kid);
    if (known) return known;
    // Requests arriving during a fetch share it; the rate limit only applies to starting a new one.
    if (!inFlight) {
      if (Date.now() - lastFetch < MIN_REFETCH_MS) return undefined;
      lastFetch = Date.now();
      inFlight = refresh().finally(() => {
        inFlight = undefined;
      });
    }
    await inFlight;
    return keys.get(kid);
  };
}

// Returns verified AuthInfo for a request, or undefined when its Access JWT is missing or invalid.
async function verifyRequest(
  req: Request,
  issuer: string,
  audience: string,
  scopes: Array<string>,
  keyFor: (kid: string) => Promise<KeyObject | undefined>,
): Promise<AuthInfo | undefined> {
  const jwt = req.headers[ACCESS_JWT_HEADER];
  if (typeof jwt !== 'string') return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment) as { alg?: unknown; kid?: unknown };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined;
  const key = await keyFor(header.kid);
  if (!key) return undefined;
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
  if (!verify('RSA-SHA256', signed, key, Buffer.from(signatureSegment, 'base64url'))) return undefined;

  const claims = decodeSegment(payloadSegment) as AccessClaims;
  const now = Date.now() / 1000;
  if (claims.iss !== issuer) return undefined;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return undefined;
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) return undefined;
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) return undefined;
  // Managed OAuth and browser sign-ins both identify a user; service tokens carry no email and
  // aren't a person, so they are refused here rather than given an identity.
  if (typeof claims.email !== 'string' || !claims.email) return undefined;

  // Each Managed OAuth connection is its own client, as each DCR client is under the kit's own auth.
  // A request without one (a browser session, `cloudflared access`) is named by the user instead.
  const oauthClientId = typeof claims.oauth?.client_id === 'string' ? claims.oauth.client_id : undefined;
  return {
    token: '',
    clientId: oauthClientId ?? claims.email,
    scopes: [...scopes],
    expiresAt: claims.exp,
    extra: { kind: 'access', email: claims.email, ...(typeof claims.sub === 'string' ? { userId: claims.sub } : {}) },
  };
}

// Middleware for createApp's `authMiddleware`. A request through Access runs as an 'access' caller
// carrying the signed-in user's email; anything else gets 403. It never answers with its own 401
// challenge: Access owns sign-in, and a request without its JWT did not come through Access.
export function createAccessAuth(config: AccessAuthConfig): RequestHandler {
  const issuer = teamUrl(config.teamDomain);
  const audience = config.audience.trim();
  if (!audience) throw new Error('createAccessAuth requires the Access application audience tag');
  const scopes = config.scopes ?? [];
  const keyFor = makeKeyStore(`${issuer}/cdn-cgi/access/certs`);

  return (req, res, next) => {
    verifyRequest(req, issuer, audience, scopes, keyFor)
      .catch(() => undefined)
      .then((info) => {
        if (!info) {
          res.status(403).json({ error: 'forbidden', error_description: 'Request did not come through Cloudflare Access' });
          return;
        }
        (req as Request & { auth?: AuthInfo }).auth = info;
        next();
      })
      .catch(next);
  };
}
