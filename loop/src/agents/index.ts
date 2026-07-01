/**
 * Public surface of the single-source agent-definition system.
 *
 * One `AgentDef` per harness agent is the source of truth; the generator renders
 * it into both editor formats (`.claude` + `.codex`), the writer materializes
 * them, and the drift check guarantees the committed files never diverge.
 */
export type { AgentDef } from "./agent-def.js";
export { AGENT_NAME_PATTERN, agentDefSchema } from "./agent-def.js";
export { agentDefs } from "./agents.js";
export type { DriftedFile, DriftFailure } from "./drift.js";
export { checkAgentDrift, findRepoRoot } from "./drift.js";
export type { GeneratedFile } from "./generate.js";
export { generateFiles, renderClaudeAgent, renderCodexAgent } from "./generate.js";
export { writeAgentFiles } from "./write.js";
