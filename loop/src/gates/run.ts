/**
 * The staged gate orchestrator (pure core).
 *
 * Two behaviours the research pinned down for agent-authored code:
 *  - AGGREGATE WITHIN a stage: run every gate in the stage and collect all
 *    failures, so the maker fixes everything in one pass instead of one-per-round.
 *  - SHORT-CIRCUIT BETWEEN stages: if a blocking gate failed in an earlier stage,
 *    don't burn the later (more expensive) stage — report it as skipped.
 *
 * Fail-closed: `ok` is true only when no blocking gate failed. In `strict` mode
 * (CI / authoritative) a blocking gate that could only be SKIPPED (its tool was
 * unavailable) also fails the run — a gate that could not run must never pass.
 */
import type { Gate, GateContext, GateOutcome, GateStage, GateTier } from "./gate.js";

export interface GateResult extends GateOutcome {
  readonly name: string;
  readonly stage: GateStage;
  readonly tier: GateTier;
}

export interface GateReport {
  readonly ok: boolean;
  readonly results: readonly GateResult[];
  readonly ranStages: readonly GateStage[];
  readonly skippedStages: readonly GateStage[];
  readonly blockingFailures: readonly GateResult[];
  readonly advisoryFailures: readonly GateResult[];
  readonly skipped: readonly GateResult[];
}

export interface RunGatesOptions {
  /** CI / authoritative: a skipped blocking gate fails the run (default false). */
  readonly strict?: boolean;
}

function isBlockingBad(result: GateResult, strict: boolean): boolean {
  if (result.tier !== "blocking") return false;
  return result.status === "fail" || (strict && result.status === "skip");
}

export function runGates(
  gates: readonly Gate[],
  ctx: GateContext,
  options: RunGatesOptions = {}
): GateReport {
  const strict = options.strict ?? false;
  const stages = [...new Set(gates.map((g) => g.stage))].sort((a, b) => a - b);

  const results: GateResult[] = [];
  const ranStages: GateStage[] = [];
  const skippedStages: GateStage[] = [];
  let blocked = false;

  for (const stage of stages) {
    if (blocked) {
      skippedStages.push(stage);
      continue;
    }
    ranStages.push(stage);
    let stageBlocked = false;
    for (const gate of gates.filter((g) => g.stage === stage)) {
      const outcome = gate.run(ctx);
      const result: GateResult = {
        name: gate.name,
        stage: gate.stage,
        tier: gate.tier,
        ...outcome
      };
      results.push(result);
      if (isBlockingBad(result, strict)) stageBlocked = true;
    }
    if (stageBlocked) blocked = true;
  }

  const blockingFailures = results.filter((r) => r.tier === "blocking" && r.status === "fail");
  const advisoryFailures = results.filter((r) => r.tier === "advisory" && r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  const strictSkipFailure = strict && skipped.some((r) => r.tier === "blocking");

  return {
    ok: blockingFailures.length === 0 && !strictSkipFailure,
    results,
    ranStages,
    skippedStages,
    blockingFailures,
    advisoryFailures,
    skipped
  };
}
