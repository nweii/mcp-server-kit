// Tool-result helpers that build the MCP CallToolResult shape once: plain text, JSON
// (with optional structuredContent), and error results. Tool handlers return these instead
// of hand-assembling `content` arrays.

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// A single text block.
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

// Pretty-printed JSON as a text block. By default it also attaches `structuredContent` so
// clients can read the parsed value structurally; MCP requires that field to be a JSON object,
// so arrays are wrapped as `{ items }` and primitives are omitted. Pass `{ structured: false }`
// for a text-only result.
export function jsonResult(
  data: unknown,
  opts: { structured?: boolean } = {},
): ToolResult {
  const { structured = true } = opts;
  const text = JSON.stringify(data, null, 2);
  if (!structured) return { content: [{ type: 'text' as const, text }] };

  const structuredContent: Record<string, unknown> | undefined = Array.isArray(data)
    ? { items: data }
    : data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

// An error result (`isError: true`) carrying a text message. Accepts an Error, a string, or
// anything else (coerced via String). Domain-specific error formatting stays at the call site;
// this covers the common case.
export function errorResult(err: unknown): ToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text }], isError: true };
}
