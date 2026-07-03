/**
 * Turn eval cases into Stage-2 gates. Each case becomes a `commandGate` at
 * `stage: 2` — reusing the existing gate model and fail-closed exec (BP-001)
 * rather than a parallel eval framework. `loop eval` runs these through the same
 * `runGates` engine `loop gate` uses.
 */
import type { EvalCase } from "../contracts/eval-case.js";
import { commandGate, type Gate } from "./gate.js";

/** One Stage-2 blocking gate per case; `--slice` filtering happens before this. */
export function makeEvalGates(cases: readonly EvalCase[]): readonly Gate[] {
  return cases.map((evalCase) =>
    commandGate({
      name: `eval:${evalCase.id}`,
      stage: 2,
      tier: "blocking",
      commands: [evalCase.run.command]
    })
  );
}
