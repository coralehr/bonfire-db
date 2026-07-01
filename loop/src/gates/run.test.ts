import { describe, expect, test } from "bun:test";
import type { Gate, GateContext, GateStage, GateStatus, GateTier } from "./gate.js";
import { runGates } from "./run.js";

const CTX: GateContext = {
  repoRoot: "/x",
  env: {},
  exec: () => ({ ok: true, exitCode: 0, output: "", spawnError: null })
};

function fakeGate(name: string, stage: GateStage, tier: GateTier, status: GateStatus): Gate {
  return { name, stage, tier, run: () => ({ status, summary: `${name} ${status}`, detail: "" }) };
}

describe("runGates — staging + tiers + fail-closed", () => {
  test("all pass → ok", () => {
    const report = runGates(
      [fakeGate("a", 0, "blocking", "pass"), fakeGate("b", 1, "blocking", "pass")],
      CTX
    );
    expect(report.ok).toBe(true);
    expect(report.ranStages).toEqual([0, 1]);
  });

  test("a blocking failure in stage 0 short-circuits stage 1", () => {
    const report = runGates(
      [fakeGate("a", 0, "blocking", "fail"), fakeGate("b", 1, "blocking", "pass")],
      CTX
    );
    expect(report.ok).toBe(false);
    expect(report.skippedStages).toEqual([1]);
    expect(report.results.find((r) => r.name === "b")).toBeUndefined();
  });

  test("aggregates ALL failures within a stage (fixes everything in one pass)", () => {
    const report = runGates(
      [fakeGate("a", 1, "blocking", "fail"), fakeGate("b", 1, "blocking", "fail")],
      CTX
    );
    expect(report.blockingFailures.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("an advisory failure is reported but does not block", () => {
    const report = runGates([fakeGate("a", 1, "advisory", "fail")], CTX);
    expect(report.ok).toBe(true);
    expect(report.advisoryFailures.map((r) => r.name)).toEqual(["a"]);
  });

  test("strict: a skipped blocking gate fails the run; lenient: it does not", () => {
    const gates = [fakeGate("a", 1, "blocking", "skip")];
    expect(runGates(gates, CTX, { strict: true }).ok).toBe(false);
    expect(runGates(gates, CTX, { strict: false }).ok).toBe(true);
  });
});
