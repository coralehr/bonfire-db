/**
 * Ratchet guards over the SQL-on-FHIR conformance + eval wiring (BP-021 class
 * applied to BF-04: a fail-open file-existence guard, an affected-filter
 * hole, or a deleted runner must be a RED check, never a silent skip).
 *
 * Pins, as text (never imports — the wired artifacts live outside the loop
 * workspace build graph):
 *   - CI runs `bun run conformance` UNCONDITIONALLY (no `[ -f ...]` guard).
 *   - CI boots projections (`bun run projections:rebuild`) unconditionally.
 *   - CI runs the Stage-2 eval corpus (`bun run loop eval`).
 *   - The root scripts the steps invoke still exist.
 *   - The packages/sql-on-fhir test script still bridges the repo-root
 *     integration suites into turbo (`../../tests/sql-on-fhir`) — tests/ is
 *     not a workspace, so without the bridge those suites are CI-invisible.
 *   - The BF-04 eval corpus still carries its four cases.
 */
import { describe, expect, test } from "bun:test";
import { readRepoFile as read } from "./wiring.js";

describe("SQL-on-FHIR conformance + eval wiring", () => {
  test("CI runs the conformance suite unconditionally (no fail-open file guard)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun run conformance");
    expect(ci).not.toMatch(/if \[ -f packages\/sql-on-fhir/);
  });

  test("CI boots projections and the FHIR gates unconditionally (BP-021 class)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun run projections:rebuild");
    expect(ci).toContain("bun run fhir:roundtrip");
    expect(ci).toContain("bun run fhir:validate");
    expect(ci).not.toMatch(/if \[ -f scripts\/(sql-on-fhir|fhir)/);
    expect(ci).not.toMatch(/if \[ -f seed\//);
  });

  test("CI executes the Stage-2 eval corpus", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun run loop eval");
  });

  test("the root scripts the CI steps invoke still exist", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.conformance).toBeDefined();
    expect(pkg.scripts?.["projections:rebuild"]).toBeDefined();
    expect(pkg.scripts?.loop).toBeDefined();
  });

  test("the package test script still bridges tests/sql-on-fhir into turbo", () => {
    const pkg = JSON.parse(read("packages/sql-on-fhir/package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.test).toContain("../../tests/sql-on-fhir");
  });

  test("the BF-04 eval corpus still carries its four cases", () => {
    const corpus = read("loop/evals/bf04.jsonl");
    for (const id of [
      "bf04-conformance-real",
      "bf04-skip-honesty",
      "bf04-rls-cross-tenant",
      "bf04-rebuild-determinism"
    ]) {
      expect(corpus).toContain(`"${id}"`);
    }
  });
});
