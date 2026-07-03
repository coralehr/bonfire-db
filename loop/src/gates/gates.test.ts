/**
 * Gate-manifest invariants. The graduation guard (P2b): knip and jscpd were
 * advisory through BF-01/BF-02 and are now BLOCKING — a silent downgrade back to
 * advisory (the only way to quietly stop failing on dead code / duplication)
 * fails here. Encodes the invariant, not a count (a bump-on-every-change is the
 * ceremony the BF-02 retro cut).
 */
import { describe, expect, test } from "bun:test";
import type { GateTier } from "./gate.js";
import { STANDARD_GATES } from "./gates.js";

function tierOf(name: string): GateTier | undefined {
  return STANDARD_GATES.find((g) => g.name === name)?.tier;
}

describe("gate manifest tiers", () => {
  test("knip and jscpd are graduated to blocking (no silent downgrade)", () => {
    expect(tierOf("knip")).toBe("blocking");
    expect(tierOf("jscpd")).toBe("blocking");
  });

  test("the load-bearing deterministic gates stay blocking", () => {
    for (const name of ["typecheck", "lint", "semgrep", "test", "structural"]) {
      expect(tierOf(name)).toBe("blocking");
    }
  });

  test("STANDARD_GATES has no stage-2 gates (evals run via `loop eval`, separately)", () => {
    expect(STANDARD_GATES.some((g) => g.stage === 2)).toBe(false);
  });
});
