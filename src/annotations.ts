// Tool annotation defaults the kit applies to every tool a server registers. The MCP spec defaults
// destructiveHint to true, and some clients read that hint without first checking readOnlyHint,
// so a read-only tool that leaves destructiveHint unset is shown to users as able to delete data.
import type { McpServer } from '@modelcontextprotocol/server';

type ToolAnnotations = NonNullable<Parameters<McpServer['registerTool']>[1]['annotations']>;

// Returns the annotations with destructiveHint set to false when the tool declares itself
// read-only and leaves destructiveHint unset. An explicit destructiveHint is kept as given.
export function withAnnotationDefaults(annotations: ToolAnnotations | undefined): ToolAnnotations | undefined {
  if (annotations?.readOnlyHint !== true) return annotations;
  if (annotations.destructiveHint !== undefined) return annotations;
  return { ...annotations, destructiveHint: false };
}

// Wraps the server's registerTool so every tool registered on it passes through
// withAnnotationDefaults, whether a server calls registerTool directly or through registerLogged.
export function applyAnnotationDefaults(server: McpServer): void {
  const register = server.registerTool.bind(server);
  // TypeScript checks this replacement against registerTool's last overload only. It forwards
  // name and callback unchanged and replaces config.annotations with a value of the same type, so
  // it accepts every overload's arguments and returns what registerTool returns.
  server.registerTool = (...[name, config, cb]: Parameters<McpServer['registerTool']>) =>
    register(name, { ...config, annotations: withAnnotationDefaults(config.annotations) }, cb);
}
