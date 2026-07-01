/**
 * The four harness agent definitions, assembled and validated.
 *
 * Each role's `AgentDef` is authored in its own file under ./defs (authored
 * separately from this machinery) and imported here. The contract every def file
 * MUST satisfy — NodeNext ESM, so import with the `.js` extension:
 *
 *   ./defs/maker.ts             export const makerDef: AgentDef
 *   ./defs/verifier.ts          export const verifierDef: AgentDef
 *   ./defs/security-auditor.ts  export const securityAuditorDef: AgentDef
 *   ./defs/planner.ts           export const plannerDef: AgentDef
 *
 * Every def is re-validated against `agentDefSchema` at module load. These are
 * in-repo constants, so an invalid def is a programmer error and throws (the same
 * posture as the slice registry), not a recoverable Result.
 */
import type { AgentDef } from "./agent-def.js";
import { agentDefSchema } from "./agent-def.js";
import { makerDef } from "./defs/maker.js";
import { plannerDef } from "./defs/planner.js";
import { securityAuditorDef } from "./defs/security-auditor.js";
import { verifierDef } from "./defs/verifier.js";

function validate(def: AgentDef, source: string): AgentDef {
  const parsed = agentDefSchema.safeParse(def);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid agent def in ${source}: ${detail}`);
  }
  return parsed.data;
}

/** Every validated agent definition, the single source the generator renders. */
export const agentDefs: readonly AgentDef[] = [
  validate(makerDef, "defs/maker.ts"),
  validate(verifierDef, "defs/verifier.ts"),
  validate(securityAuditorDef, "defs/security-auditor.ts"),
  validate(plannerDef, "defs/planner.ts")
];

// Names map 1:1 to generated filenames; a duplicate would silently overwrite
// another agent's .claude/.codex output. Fail loudly at load (programmer error).
const agentNames = agentDefs.map((def) => def.name);
if (new Set(agentNames).size !== agentNames.length) {
  throw new Error(`Duplicate agent name(s) in the registry: ${agentNames.join(", ")}`);
}
