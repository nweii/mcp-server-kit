// Public entry point for the kit: the app factory, process/shutdown helpers, and tool-result
// helpers, plus their types.
export { createApp } from './app.js';
export type { CreateAppOptions, RegisterTools } from './app.js';
export { createAuth, DEFAULT_ALLOWED_REDIRECT_URIS } from './auth.js';
export type { Auth, AuthConfig, DynamicClientRegistrationConfig } from './auth.js';
export { startServer } from './process.js';
export type { StartServerOptions } from './process.js';
export { textResult, jsonResult, errorResult } from './results.js';
export type { ToolContent, ToolResult } from './results.js';
export { createAuditLog } from './logging.js';
export type { AuditLogConfig, AuditLogger, ToolCallLog, FeedbackLog } from './logging.js';
