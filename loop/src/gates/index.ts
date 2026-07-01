/**
 * Public surface of the deterministic gate runner (loop-harness-plan.md H3).
 *
 * One `GateContext` (deterministic env + injected runner) drives a staged,
 * fail-closed, tiered run of the standard gates plus the slice's allowed-paths
 * check. The CLI (`loop gate`) is a thin shell over `runGates`.
 */

export { makeAllowedPathsGate } from "./allowed-paths-gate.js";
export { GATE_ENV, makeGateContext } from "./context.js";
export type { CommandResult, CommandRunner, RunCommandOptions } from "./exec.js";
export { makeRunner, runCommand } from "./exec.js";
export type { Gate, GateContext, GateOutcome, GateStage, GateStatus, GateTier } from "./gate.js";
export { commandGate } from "./gate.js";
export { STANDARD_GATES } from "./gates.js";
export { LOCKFILE_GATE } from "./lockfile-gate.js";
export type { GateReport, GateResult, RunGatesOptions } from "./run.js";
export { runGates } from "./run.js";
