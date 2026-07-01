/**
 * The gate model: one deterministic check, described as data.
 *
 * A gate carries its STAGE (0 = fast hooks, 1 = full deterministic) and its
 * TIER (blocking vs advisory) as data, so severity is a property of the manifest
 * (./gates.ts), not scattered branching (loop-harness-plan.md T6). Every gate is
 * a pure function of a `GateContext`, whose injected `exec` runner makes the gate
 * unit-testable with a fake instead of a real subprocess (functional-core /
 * imperative-shell).
 */
import { type CommandRunner, commandDetail, failureReason } from "./exec.js";

/** 0 = fast hooks (format/typecheck/lint); 1 = full deterministic stack. */
export type GateStage = 0 | 1;

/** blocking = a failure fails the run; advisory = reported, does not block. */
export type GateTier = "blocking" | "advisory";

/** pass = clean; fail = ran and found a problem; skip = could not run (see strict). */
export type GateStatus = "pass" | "fail" | "skip";

export interface GateContext {
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected command runner — real in production, faked in tests. */
  readonly exec: CommandRunner;
}

export interface GateOutcome {
  readonly status: GateStatus;
  /** One-line result, always present ("silent success, verbose failure"). */
  readonly summary: string;
  /** Verbose detail on failure (tool output / violations); "" when passing. */
  readonly detail: string;
}

export interface Gate {
  readonly name: string;
  readonly stage: GateStage;
  readonly tier: GateTier;
  readonly run: (ctx: GateContext) => GateOutcome;
}

/**
 * A gate that runs one or more shell commands in order and fails on the first
 * non-zero. Used for the tools that mirror CI verbatim (tsc, eslint, biome, …).
 */
export function commandGate(spec: {
  name: string;
  stage: GateStage;
  tier: GateTier;
  commands: readonly (readonly string[])[];
}): Gate {
  return {
    name: spec.name,
    stage: spec.stage,
    tier: spec.tier,
    run: (ctx) => {
      for (const argv of spec.commands) {
        const result = ctx.exec(argv);
        if (!result.ok) {
          return {
            status: "fail",
            summary: `${spec.name} failed — ${failureReason(result)}`,
            detail: commandDetail(result, "(no output)")
          };
        }
      }
      return { status: "pass", summary: `${spec.name} passed`, detail: "" };
    }
  };
}
