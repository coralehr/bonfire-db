/**
 * Execution eval bf09-no-approve-commit-mcp-tool (BF-09 acceptance #6; danger:
 * propose-only-broken).
 *
 * The agent surface (the MCP tool ALLOWLIST, read across the harness<->product
 * firewall from the frozen registration source) exposes EXACTLY the three
 * BF-08 tools — get_context, propose_resource, search_clinical — and no tool
 * whose name matches /approve|commit|reject|sign/i. Stage-1 pins the live
 * tools/list inside the package; this eval asserts the same invariant from
 * OUTSIDE the firewall against the real module, so a widened registry fails
 * even before any transport is built.
 *
 * Inversion: adding an "approve_proposal" (or any 4th/renamed) tool to
 * ALLOWLIST in packages/mcp/src/tools.ts reddens this eval.
 */
import { mcpToolNames } from "./bf09-governance-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf09-no-approve-commit-mcp-tool";
/** The frozen BF-08 propose-only surface, sorted. */
const FROZEN_TOOLS = ["get_context", "propose_resource", "search_clinical"] as const;
/** No governance-advancing verb may appear on the agent surface. */
const GOVERNANCE_VERBS = /approve|commit|reject|sign/i;

const tools = mcpToolNames(EVAL_ID);
const sorted = [...tools].sort();
if (sorted.join(",") !== FROZEN_TOOLS.join(",")) {
  fail(
    EVAL_ID,
    `ALLOWLIST is not exactly the ${String(FROZEN_TOOLS.length)} frozen tools: got [${sorted.join(", ")}]`
  );
}
const offending = tools.filter((name) => GOVERNANCE_VERBS.test(name));
if (offending.length > 0) {
  fail(
    EVAL_ID,
    `governance-advancing tool exposed on the agent surface: [${offending.join(", ")}]`
  );
}
pass(
  EVAL_ID,
  `allowlist = exactly [${sorted.join(", ")}]; no tool matches /approve|commit|reject|sign/i`
);
