// Opt-in audit logging for tool calls: an append-only JSONL trail plus a registerLogged wrapper that
// times each tool handler and records its outcome (arguments summarized, ok/error, duration). The
// caller supplies the log directory, which argument names to redact, and the enable/suppress gates,
// so nothing here is tied to a particular server's tools or environment variables.
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult } from './results.js';

export interface AuditLogConfig {
  // Directory the JSONL files are written to. Created lazily on the first write.
  logDir: string;
  // Argument names whose values are redacted at any depth in the args tree — for arguments that may
  // carry user content (bodies, field values). Matched by exact key name. Default: redact nothing.
  redactedFields?: Iterable<string>;
  // Filenames within logDir. Default: 'tool-calls.jsonl' and 'feedback.jsonl'.
  toolCallsFile?: string;
  feedbackFile?: string;
  // Whether logging is on, evaluated live on each call so it can follow an env var. Default: on.
  enabled?: () => boolean;
  // When it returns true, records are summarized but never written to disk — for test runs. Evaluated
  // live on each write. Default: never suppressed.
  suppressWrites?: () => boolean;
}

export interface ToolCallLog {
  tool: string;
  args: unknown;
  ok: boolean;
  duration_ms: number;
  // Suggestion text returned to the client on an isError result, or the thrown error message.
  error?: string;
}

export interface FeedbackLog {
  goal: string;
  attempted: string;
  stuck_on: string;
  suggested_tool?: string;
}

// The registerTool def and the handler's args are typed `any` because the SDK's registerTool is
// heavily generic; re-typing it here just fights the compiler with no runtime benefit. `any` on the
// handler args (rather than `unknown`) also lets callers pass strongly-typed handlers unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDef = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<ToolResult>;

export interface AuditLogger {
  // Wraps server.registerTool with timing + JSONL logging so every call lands in the audit trail with
  // an args summary, ok/error, duration, and the suggestion text returned on an isError response.
  registerLogged(server: McpServer, name: string, def: ToolDef, handler: ToolHandler): void;
  logToolCall(entry: ToolCallLog): void;
  logFeedback(entry: FeedbackLog): void;
  // Summarizes an arguments tree for logging: long strings become a length marker, redacted fields
  // become an opaque marker, everything else passes through. Exposed for direct use and testing.
  summarizeArgs(args: unknown): unknown;
  // Whether logging is currently enabled (the config's `enabled` gate). Useful for skipping the
  // registration of logging-dependent tools (e.g. a feedback tool) when logging is off.
  isLoggingEnabled(): boolean;
}

export function createAuditLog(config: AuditLogConfig): AuditLogger {
  const toolCallsFile = config.toolCallsFile ?? 'tool-calls.jsonl';
  const feedbackFile = config.feedbackFile ?? 'feedback.jsonl';
  const redacted = new Set(config.redactedFields ?? []);
  const enabled = config.enabled ?? (() => true);
  const suppressWrites = config.suppressWrites ?? (() => false);

  let dirEnsured = false;

  function ensureDir() {
    if (dirEnsured) return;
    try {
      mkdirSync(config.logDir, { recursive: true });
    } catch (err) {
      console.error('[log] failed to create log dir:', err);
    }
    dirEnsured = true; // even on failure: avoid retrying mkdir on every call
  }

  function appendJsonl(filename: string, record: Record<string, unknown>) {
    if (suppressWrites()) return;
    if (!enabled()) return;
    ensureDir();
    try {
      appendFileSync(join(config.logDir, filename), JSON.stringify(record) + '\n');
    } catch (err) {
      console.error(`[log] failed to write ${filename}:`, err);
    }
  }

  function redactValue(v: unknown): string {
    if (typeof v === 'string') return `<redacted:${v.length}chars>`;
    if (v === null || v === undefined) return '<redacted>';
    return `<redacted:${typeof v}>`;
  }

  // Truncate string fields over 80 chars so logs stay readable and small. Numbers, booleans, and short
  // strings pass through unchanged. Fields named in redactedFields are always redacted, at any depth.
  function summarizeArgs(args: unknown): unknown {
    if (args === null || args === undefined) return args;
    if (typeof args === 'string') return args.length > 80 ? `<str:${args.length}chars>` : args;
    if (Array.isArray(args)) return args.map(v => summarizeArgs(v));
    if (typeof args === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        out[k] = redacted.has(k) ? redactValue(v) : summarizeArgs(v);
      }
      return out;
    }
    return args;
  }

  function logToolCall(entry: ToolCallLog) {
    appendJsonl(toolCallsFile, {
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: summarizeArgs(entry.args),
      ok: entry.ok,
      duration_ms: entry.duration_ms,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }

  function logFeedback(entry: FeedbackLog) {
    appendJsonl(feedbackFile, {
      ts: new Date().toISOString(),
      ...entry,
    });
  }

  function extractErrorText(result: ToolResult): string | undefined {
    const first = result.content?.[0];
    return first && first.type === 'text' ? first.text : undefined;
  }

  function registerLogged(server: McpServer, name: string, def: ToolDef, handler: ToolHandler) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, def, async (args: unknown) => {
      const start = Date.now();
      try {
        const result = await handler(args);
        const ok = result.isError !== true;
        logToolCall({
          tool: name,
          args,
          ok,
          duration_ms: Date.now() - start,
          error: ok ? undefined : extractErrorText(result),
        });
        return result;
      } catch (e) {
        logToolCall({
          tool: name,
          args,
          ok: false,
          duration_ms: Date.now() - start,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    });
  }

  return { registerLogged, logToolCall, logFeedback, summarizeArgs, isLoggingEnabled: enabled };
}
