/**
 * Ratchet guard BP-036: the @bonfire/sql-on-fhir test suite is the only one that
 * DROPs the shared vd_* projection tables and byte-identity-hashes a full rebuild
 * of the ENTIRE fhir_resources corpus. Run concurrently under `turbo run test`
 * with a suite that WRITES fhir_resources (BF-06's search-indexer tests) it flakes
 * (the two rebuilds see different corpora), and with a suite that READS vd_* it
 * 42P01s on the brief DROP window. It must therefore run in a SERIALIZED DB lane:
 * @bonfire/sql-on-fhir#test depends on the other DB suites so it runs last, alone.
 * This pins that turbo override so a future edit can't silently reopen the race.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

interface TurboTask {
  dependsOn?: string[];
}
const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as {
  tasks: Record<string, TurboTask>;
};

describe("BP-036: the sql-on-fhir DB suite runs in a serialized lane", () => {
  test("@bonfire/sql-on-fhir#test depends on the other DB suites (runs last, alone)", () => {
    const deps = turbo.tasks["@bonfire/sql-on-fhir#test"]?.dependsOn ?? [];
    expect(deps).toContain("@bonfire/core#test");
    expect(deps).toContain("@bonfire/api#test");
  });
});
