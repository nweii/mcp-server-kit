// Express application factory for a remote MCP server: assembles CORS, request logging, a
// bearer-gated health endpoint, and the stateless streamable-HTTP `/mcp` mount around a
// caller-supplied tool-registration function and a pluggable auth middleware. Used by the
// process entry and by tests.
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Auth } from './auth.js';

// Registers the server's tools onto a fresh McpServer. Called once per POST /mcp request, so a
// slow or async registration (reading a store, awaiting I/O) is supported.
export type RegisterTools = (server: McpServer) => void | Promise<void>;

export interface CreateAppOptions {
  // Display name and version reported in MCP server info and the health body.
  name: string;
  version: string;
  // Registers the server's tools onto each per-request McpServer instance.
  registerTools: RegisterTools;
  // The auth module guarding /mcp. When supplied, its OAuth routes (discovery, /authorize,
  // /oauth/token) are mounted and its bearer check gates /mcp. Provide this or authMiddleware.
  auth?: Auth;
  // Bare middleware guarding /mcp, as an alternative to `auth` when no OAuth routes are needed
  // (a static-token check, or a stub in tests). Ignored when `auth` is supplied. Runs before /mcp.
  authMiddleware?: RequestHandler;
  // Bearer token for /health. When omitted the route responds 404, so the secret pasted into an
  // uptime monitor grants nothing and rotates independently of the /mcp auth.
  healthToken?: string;
  // Allowed CORS origins. Omit or pass null to allow any origin (`*`); pass an array to restrict.
  corsOrigins?: string[] | null;
  // Optional liveness probe run on an authorized /health request. Throwing marks the server
  // unhealthy (503); returning normally reports healthy (200).
  healthProbe?: () => void | Promise<void>;
  // When true, suppresses the per-request console log line (keeps test output quiet).
  testMode?: boolean;
}

function ts(): string {
  return new Date().toISOString();
}

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded?.split(',')[0] ?? req.socket.remoteAddress ?? '?');
  return ip.trim();
}

function makeRequestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(
        `[${ts()}] ${clientIp(req)} ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
      );
    });
    next();
  };
}

function setCorsHeaders(req: Request, res: Response, allowedOrigins: string[] | null): boolean {
  const origin = req.headers.origin;

  if (allowedOrigins === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (req.method === 'OPTIONS' && origin) {
    res.status(403).end();
    return false;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  return true;
}

// Constant-time string comparison so the health token can't be recovered by timing.
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function makeHealthHandler(opts: CreateAppOptions): RequestHandler {
  return async (req: Request, res: Response) => {
    const expected = opts.healthToken?.trim();
    if (!expected) {
      res.status(404).end();
      return;
    }
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token || !constantTimeEqual(token, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (opts.healthProbe) {
      try {
        await opts.healthProbe();
      } catch {
        res.status(503).json({ ok: false, version: opts.version, uptime_seconds: process.uptime() });
        return;
      }
    }
    res.json({ ok: true, version: opts.version, uptime_seconds: process.uptime() });
  };
}

export function createApp(opts: CreateAppOptions): Express {
  const authMiddleware = opts.auth ? opts.auth.authMiddleware : opts.authMiddleware;
  if (!authMiddleware) {
    throw new Error('createApp requires either an `auth` module or an `authMiddleware` to guard /mcp');
  }

  const app = express();
  const allowedOrigins = opts.corsOrigins ?? null;

  app.use((req, res, next) => {
    if (!setCorsHeaders(req, res, allowedOrigins)) return;
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  if (!opts.testMode) app.use(makeRequestLogger());

  // Liveness probe — gated by its own health token, not the /mcp auth middleware.
  app.get('/health', makeHealthHandler(opts));

  // OAuth surface (discovery, /authorize, /oauth/token) from the auth module, when one is supplied.
  if (opts.auth) app.use(opts.auth.routes);

  // Streamable HTTP clients probe GET with Accept: text/event-stream; 405 means "no standalone
  // SSE" (not 404). Stateless transport has no session to delete, so DELETE is 405 too.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  };
  app.get('/mcp', authMiddleware, methodNotAllowed);
  app.delete('/mcp', authMiddleware, methodNotAllowed);

  app.post('/mcp', authMiddleware, async (req, res) => {
    if (!opts.testMode) {
      const body = req.body as { method?: string; params?: { name?: string } };
      const mcpMethod = body?.method ?? '?';
      const toolName = body?.params?.name;
      console.log(`[${ts()}] MCP ${mcpMethod}${toolName ? ` (${toolName})` : ''}`);
    }

    const server = new McpServer({ name: opts.name, version: opts.version });
    await opts.registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
      enableJsonResponse: true, // return JSON instead of SSE; avoids proxy buffering issues
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
