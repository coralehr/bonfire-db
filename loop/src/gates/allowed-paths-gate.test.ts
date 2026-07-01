import { describe, expect, test } from "bun:test";
import { makeAllowedPathsGate } from "./allowed-paths-gate.js";
import type { CommandResult } from "./exec.js";
import type { GateContext } from "./gate.js";

/** A context whose git-diff returns exactly `files`. */
function ctxWithDiff(files: readonly string[], ok = true): GateContext {
  const result: CommandResult = {
    ok,
    exitCode: ok ? 0 : 1,
    output: ok ? files.join("\n") : "fatal: bad revision",
    spawnError: null
  };
  return { repoRoot: "/x", env: {}, exec: () => result };
}

describe("allowed-paths gate", () => {
  test("an unknown slice id fails", () => {
    const gate = makeAllowedPathsGate("BF-99", "main");
    expect(gate.run(ctxWithDiff([])).status).toBe("fail");
  });

  test("an empty changeset is vacuously in scope (pass)", () => {
    const gate = makeAllowedPathsGate("BF-01", "main");
    expect(gate.run(ctxWithDiff([])).status).toBe("pass");
  });

  test("a globally-forbidden path (the harness) is out of scope for a product slice", () => {
    const gate = makeAllowedPathsGate("BF-01", "main");
    const outcome = gate.run(ctxWithDiff(["loop/src/gates/run.ts"]));
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("loop/src/gates/run.ts");
  });

  test("a failed git diff fails the gate (never a silent pass)", () => {
    const gate = makeAllowedPathsGate("BF-01", "main");
    expect(gate.run(ctxWithDiff([], false)).status).toBe("fail");
  });
});
