// Who is making the current /mcp request: the verified client behind the bearer token, with the
// scopes its connection was granted. The app factory runs each /mcp request inside the caller's
// context, so tool registration, tool handlers and anything they call can read it with
// currentCaller() instead of threading it through every function.
import { AsyncLocalStorage } from 'async_hooks';
import type { AuthInfo } from '@modelcontextprotocol/server-legacy/auth';

// How the caller authenticated: the configured OAuth client, a dynamically registered client, the
// static bearer token, or a user signed in through Cloudflare Access. Each is a distinct identity, so
// a log or a policy can tell them apart.
export type CallerKind = 'static' | 'dynamic' | 'bearer' | 'access';

export interface Caller {
  // The client's id. For an 'access' caller, the client Access registered for the connection, or the
  // user's email when the request carries no OAuth client (a browser session).
  clientId: string;
  // The name a dynamically registered client declared for itself. Self-asserted, so it is a label
  // for people, never an identity to make decisions on.
  clientName?: string;
  kind: CallerKind;
  // For an 'access' caller, the signed-in user as Access verified them: their email, and the stable
  // id Access assigns (its `sub` claim), which survives an email change.
  email?: string;
  userId?: string;
  // Scopes this connection was granted. Empty when the auth module declares no scopes.
  scopes: string[];
}

const context = new AsyncLocalStorage<Caller>();

// The caller of the request being served, or undefined outside a request (startup, tests, or an
// app guarding /mcp with middleware other than the kit's auth module or createAccessAuth).
export function currentCaller(): Caller | undefined {
  return context.getStore();
}

// Runs fn as the given caller, or with no caller when it is undefined, even inside another
// caller's context. The app factory uses this for each /mcp request; apps can use it in tests to
// exercise per-caller behavior without an HTTP round trip.
export function runAsCaller<T>(caller: Caller | undefined, fn: () => T): T {
  return caller ? context.run(caller, fn) : context.exit(fn);
}

// The caller described by verified auth info, or undefined for auth info that neither the kit's auth
// module nor createAccessAuth produced.
export function callerFromAuthInfo(info: AuthInfo | undefined): Caller | undefined {
  const extra = info?.extra as { kind?: unknown; clientName?: unknown; email?: unknown; userId?: unknown } | undefined;
  const kind = extra?.kind;
  if (!info || (kind !== 'static' && kind !== 'dynamic' && kind !== 'bearer' && kind !== 'access')) return undefined;
  const clientName = typeof extra?.clientName === 'string' ? extra.clientName : undefined;
  const email = typeof extra?.email === 'string' ? extra.email : undefined;
  const userId = typeof extra?.userId === 'string' ? extra.userId : undefined;
  return {
    clientId: info.clientId,
    ...(clientName ? { clientName } : {}),
    kind,
    ...(email ? { email } : {}),
    ...(userId ? { userId } : {}),
    scopes: [...info.scopes],
  };
}
