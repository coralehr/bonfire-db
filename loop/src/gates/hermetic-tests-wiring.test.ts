/**
 * Ratchet guard BP-024 (db-test-depends-on-unrun-boot-step): a DB test asserted
 * seeded row counts but never seeded — green locally (operator had run seed),
 * red on a fresh CI runner that only migrated.
 *
 * Two-part close, both pinned here:
 *  1. The recorded exhibit is now HERMETIC: it lives in the seed workspace (which
 *     owns the seeder, so no core→seed cycle) and self-provisions via seedIfNeeded
 *     in beforeAll — proven to pass against a migrate-only DB. The old
 *     boot-order-dependent copy under packages/core is gone.
 *  2. The tests that are NOT yet hermetic (they read vd_* projections / loaded
 *     terminology) rely on the CI boot establishing that shared state BEFORE the
 *     test task. The recorded failure was exactly the boot missing a step, so we
 *     pin that db:migrate + seed + fhir:load-terminology + projections:rebuild all
 *     run, in order, before `turbo run <task>`. Full hermeticity of the remaining
 *     suites is a scoped follow-up; this stops the boot contract from regressing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

describe("BP-024: DB tests do not depend on an unrun boot step", () => {
  test("the seed-contract test is hermetic (in seed/, self-seeds via seedIfNeeded)", () => {
    const hermetic = join(repoRoot, "seed", "seeded-state.test.ts");
    expect(existsSync(hermetic)).toBe(true);
    expect(readFileSync(hermetic, "utf8")).toContain("seedIfNeeded");
    // The boot-order-dependent predecessor must not come back.
    expect(
      existsSync(join(repoRoot, "packages", "core", "src", "db", "seeded-state.test.ts"))
    ).toBe(false);
  });

  test("CI boot provisions the shared DB state, in order, before the test task", () => {
    const steps = [
      "bun run db:migrate",
      "bun run seed",
      "bun run fhir:load-terminology",
      "bun run projections:rebuild"
    ];
    const positions = steps.map((s) => ci.indexOf(s));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `boot step "${steps[i]}" missing from CI`).toBeGreaterThan(-1);
    }
    // Strictly increasing = the documented boot order.
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
    }
    // ...and the whole boot precedes the turbo test task (the recorded failure was
    // a test running before its state existed).
    const turboRun = ci.indexOf('bunx turbo run "${TASK}"');
    expect(turboRun).toBeGreaterThan(positions[positions.length - 1] as number);
  });
});
