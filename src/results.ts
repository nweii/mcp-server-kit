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

// Schema-validated structured result — the sanctioned return for a tool that declares an
// `outputSchema`. Pass the same schema object used as the tool's `outputSchema` (any `{ parse }`,
// e.g. a Zod object) plus the data; it validates once here (belt) before the SDK re-validates the
// returned `structuredContent` against `outputSchema` (suspenders), so a mismatch fails loudly at
// the call boundary rather than drifting silently. The text block defaults to pretty JSON of the
// *parsed* data (the spec wants text to mirror the structured content for back-compat); pass
// `toText` only when a tool genuinely reads better as prose — and it receives the parsed data, so
// the text can never describe a different shape than the schema. Keep schemas additive-only and
// object-rooted (avoid top-level unions) so a change never breaks a client that learned the shape.
export function structuredResult<T extends object>(
  schema: { parse: (data: unknown) => T },
  data: T,
  toText?: (parsed: T) => string,
): ToolResult {
  const parsed = schema.parse(data);
  const text = toText ? toText(parsed) : JSON.stringify(parsed, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

// An error result (`isError: true`) carrying a text message. Accepts an Error, a string, or
// anything else (coerced via String). Domain-specific error formatting stays at the call site;
// this covers the common case.
export function errorResult(err: unknown): ToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text }], isError: true };
}
