/**
 * Ratchet guard BP-021: the synthetic-only PHI tripwire must stay WIRED and
 * BROAD. The scanner self-tests its detector classes on a hardcoded fixture,
 * so narrowing SCAN_ROOTS to nothing, dropping a detector from ALL_RULES, or
 * deleting the CI/gate wiring would leave the run green while sweeping nothing.
 * This test — which runs in the CI `build-test / test` required check via
 * `turbo run test` — makes each of those a hard failure.
 *
 * It reads the files as text (the scanner lives under scripts/, outside the
 * loop workspace's build graph) rather than importing them.
 */
import { describe, expect, test } from "bun:test";
import { readRepoFile as read } from "./wiring.js";

const CANONICAL_RULES = [
  "name-marker",
  "ssn-structural",
  "phone-nanp",
  "npi-luhn",
  "mrn-system",
  "compound-identity",
  "ssn-text"
];

describe("synthetic-only tripwire wiring", () => {
  test("the scanner sweeps deny-by-default (git ls-files), not a shrinkable allowlist", () => {
    // BP-022: scope is every tracked file minus a reviewed carve-out, so a new
    // dir/extension is covered automatically. The old narrowable SCAN_ROOTS
    // allowlist is gone; coverage is pinned exactly by phi-scan-coverage.test.ts.
    const index = read("scripts/synthetic-scan/index.ts");
    expect(index).toContain("git");
    expect(index).toContain("ls-files");
    expect(index).toContain("enumerateTargets");
    expect(read("scripts/synthetic-scan/config.ts")).not.toContain("SCAN_ROOTS");
  });

  test("every canonical detector class is still registered in ALL_RULES", () => {
    const detectors = read("scripts/synthetic-scan/detectors.ts");
    for (const rule of CANONICAL_RULES) {
      expect(detectors).toContain(`"${rule}"`);
    }
  });

  test("the scan:synthetic script exists in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["scan:synthetic"]).toBeDefined();
  });

  test("the synthetic-only gate is registered in the loop gate manifest", () => {
    const gates = read("loop/src/gates/gates.ts");
    expect(gates).toContain('name: "synthetic-only"');
    expect(gates).toContain('"scan:synthetic"');
  });

  test("CI runs the scanner unconditionally (no fail-open file guard)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun run scan:synthetic");
    // The scan must not sit behind an `if [ -f ... ]` that echo-passes when the
    // scanner is deleted — deletion has to be a red check.
    expect(ci).not.toMatch(/if \[ -f scripts\/synthetic-scan/);
  });
});
