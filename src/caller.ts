// Who is making the current /mcp request: the verified client behind the bearer token, with the
// scopes its connection was granted. The app factory runs each /mcp request inside the caller's
// context, so tool registration, tool handlers and anything they call can read it with
// currentCaller() instead of threading it through every function.
import { AsyncLocalStorage } from 'async_hooks';
import type { AuthInfo } from '@modelcontextprotocol/server-legacy/auth';

// How the caller authenticated: the configured OAuth client, a dynamically registered client, or the
// static bearer token. Each is a distinct identity, so a log or a policy can tell them apart.
export type CallerKind = 'static' | 'dynamic' | 'bearer';

export interface Caller {
  clientId: string;
  // The name a dynamically registered client declared for itself. Self-asserted, so it is a label
  // for people, never an identity to make decisions on.
  clientName?: string;
  kind: CallerKind;
  // Scopes this connection was granted. Empty when the auth module declares no scopes.
  scopes: string[];
}

const context = new AsyncLocalStorage<Caller>();

// The caller of the request being served, or undefined outside a request (startup, tests, or an
// app guarding /mcp with its own middleware instead of the kit's auth module).
export function currentCaller(): Caller | undefined {
  return context.getStore();
}

// Runs fn as the given caller. The app factory uses this for each /mcp request; apps can use it in
// tests to exercise per-caller behavior without an HTTP round trip.
export function runAsCaller<T>(caller: Caller | undefined, fn: () => T): T {
  return caller ? context.run(caller, fn) : fn();
}

// The caller described by verified auth info, or undefined for auth info the kit's auth module did
// not produce.
export function callerFromAuthInfo(info: AuthInfo | undefined): Caller | undefined {
  const extra = info?.extra as { kind?: unknown; clientName?: unknown } | undefined;
  const kind = extra?.kind;
  if (!info || (kind !== 'static' && kind !== 'dynamic' && kind !== 'bearer')) return undefined;
  const clientName = typeof extra?.clientName === 'string' ? extra.clientName : undefined;
  return { clientId: info.clientId, ...(clientName ? { clientName } : {}), kind, scopes: [...info.scopes] };
}
