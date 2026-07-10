/**
 * @bonfire/mcp — the local propose-only MCP server over @bonfire/sdk's
 * session-bound client. The public surface is the per-session server factory
 * plus the static three-tool allowlist; the stdio entry lives in main.ts.
 */
export type { BonfireMcpDeps } from "./server.js";
export { createBonfireMcpServer, createStdioTransport } from "./server.js";
export type { ToolDef, ToolName, ToolResult, ToolTextContent } from "./tools.js";
export { ALLOWLIST } from "./tools.js";
