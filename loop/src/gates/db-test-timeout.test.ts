/**
 * Ratchet guard BP-034: the heavy sql-on-fhir suite runs a full projection
 * DROP + rebuild determinism check that needs ~6s; under `turbo run test` (every
 * package's DB suite hammering one Postgres concurrently) it flakes with a
 * CONNECTION_ENDED / timeout at bun's default 5s. The mitigation — a generous
 * per-run `--timeout` on that package's test script — is otherwise a bare literal
 * one careless edit away from silently reopening the flake. This pins the shared
 * DB-test timeout convention so removing or lowering it goes red here.
 *
 * The durable structural fix (a dedicated/serialized Postgres lane for the heavy
 * rebuild suite) remains a documented follow-up; this guard closes the silent-
 * removal vector today.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** The shared floor for a DB-backed package test script's per-run timeout (ms). */
const DB_TEST_TIMEOUT_FLOOR_MS = 20_000;

interface PackageJson {
  scripts?: Record<string, string>;
}

function testScriptOf(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, pkgPath), "utf8")) as PackageJson;
  return pkg.scripts?.test ?? "";
}

describe("BP-034: heavy DB test suites keep a generous timeout", () => {
  test("packages/sql-on-fhir test script pins --timeout >= the DB floor", () => {
    const script = testScriptOf("packages/sql-on-fhir/package.json");
    const match = /--timeout\s+(\d+)/.exec(script);
    expect(match).not.toBeNull();
    const ms = match?.[1] === undefined ? 0 : Number(match[1]);
    expect(ms).toBeGreaterThanOrEqual(DB_TEST_TIMEOUT_FLOOR_MS);
  });

  test("the sql-on-fhir test script actually runs the DB suites (guard is not vacuous)", () => {
    const script = testScriptOf("packages/sql-on-fhir/package.json");
    expect(script).toContain("bun test");
    expect(script).toContain("tests/sql-on-fhir");
  });
});
