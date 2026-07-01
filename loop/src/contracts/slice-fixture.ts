import type { SliceContract } from "./slice-contract.js";

/**
 * A minimal, valid {@link SliceContract} for tests. Callers override only the
 * fields their assertion cares about; all others are benign, schema-valid
 * defaults so the contract always parses. Centralising the base keeps the
 * per-test factories from drifting (and from tripping the duplication gate).
 */
export function makeSlice(overrides: Partial<SliceContract> = {}): SliceContract {
  return {
    id: "BF-02",
    title: "t",
    profile: "data",
    goal: "g",
    why: "w",
    dependsOn: ["BF-01"],
    allowedPaths: ["packages/**"],
    forbiddenPaths: [],
    acceptance: ["a"],
    verify: ["v"],
    evals: [],
    dangerChecks: [],
    caps: { maxAttempts: 3, maxTurns: 40, maxBudgetUSD: 5 },
    requiredAgents: ["maker", "verifier"],
    greptileRequired: true,
    ...overrides
  };
}
