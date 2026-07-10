/**
 * Per-session MCP server factory (U1). One NEW McpServer per call — a server
 * is never shared across sessions or transports — and tools are registered
 * ONLY by iterating the static ALLOWLIST (this is the single registerTool
 * callsite in the package). Handlers close over the session-bound SDK client
 * ONLY: no db/sql/withTenant identifier ever enters handler scope (D2).
 *
 * This module is the ONLY one importing @modelcontextprotocol/sdk, so the
 * announced v2 package split is a one-file migration.
 */
import type { TenantDb } from "@bonfire/core";
import type { BonfireSession } from "@bonfire/sdk";
import { createBonfireClient } from "@bonfire/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALLOWLIST } from "./tools.js";

const SERVER_INFO = { name: "bonfire-mcp", version: "0.0.0" };

export interface BonfireMcpDeps {
  readonly db: TenantDb;
  readonly session: BonfireSession;
}

/**
 * Build the session-bound client once and register the fixed allowlist over
 * it. The db handle is used solely here at the composition root; agents can
 * reach data only through the client's typed, tenant-scoped methods.
 */
export function createBonfireMcpServer(deps: BonfireMcpDeps): McpServer {
  const client = createBonfireClient(deps.db, deps.session);
  const server = new McpServer(SERVER_INFO);
  for (const tool of ALLOWLIST) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.run(client, args)
    );
  }
  return server;
}

/** The stdio transport, wrapped so main.ts needs no direct SDK import. */
export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
