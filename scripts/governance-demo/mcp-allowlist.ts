/**
 * scripts/governance-demo/mcp-allowlist.ts — print the MCP tool ALLOWLIST names
 * across the harness<->product firewall, so the bf09 eval can prove no
 * approve/commit/reject/sign tool is exposed on the agent surface (BF-09
 * acceptance #6; the frozen BF-08 3-tool allowlist).
 *
 * ALLOWLIST (packages/mcp) is the SINGLE, Object.frozen tool registration
 * source — createBonfireMcpServer registers exactly this array and nothing
 * else. This script imports it from the @bonfire/mcp entry point; the MCP SDK
 * that entry point transitively pulls resolves against packages/mcp's own
 * node_modules (bun resolves a bare specifier relative to the importing source
 * file, server.ts, not this script), so it runs standalone. The complementary
 * in-package pin test (server.test.ts) proves the LIVE tools/list a connected
 * client sees equals these names; this eval guards the Stage-2 firewall angle:
 * an ALLOWLIST widened to add an approve/commit tool fails here even before any
 * transport is built.
 *
 * No argv. stdout = one JSON line { tools: [names...] }. Exit 0.
 */
import { ALLOWLIST } from "../../packages/mcp/src/index.js";

const tools = ALLOWLIST.map((tool) => tool.name);
process.stdout.write(`${JSON.stringify({ tools })}\n`);
