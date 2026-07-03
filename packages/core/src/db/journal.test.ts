/**
 * Drizzle journal discipline (forward-only migrations, BF-02).
 *
 * The migrator's watermark compares only the LAST applied timestamp, so an
 * out-of-order `when` silently skips a migration forever. These fs-only tests
 * make that failure class impossible to merge.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const DRIZZLE_DIR_URL = new URL("../../../../drizzle/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", DRIZZLE_DIR_URL), "utf8"));

describe("drizzle journal (forward-only, idempotent migrate)", () => {
  test("journal is v7 postgresql with at least the BF-01 + BF-02 entries", () => {
    expect(journal.version).toBe("7");
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
  });

  test("journal when strictly increasing", () => {
    const whens = journal.entries.map((entry) => entry.when);
    for (let i = 1; i < whens.length; i += 1) {
      expect(whens[i]).toBeGreaterThan(whens[i - 1]);
    }
  });

  test("journal idx contiguous from zero", () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
    });
  });

  test("every journal tag has its .sql file, including 0002_fhir_store", () => {
    for (const entry of journal.entries) {
      expect(existsSync(new URL(`${entry.tag}.sql`, DRIZZLE_DIR_URL))).toBe(true);
    }
    expect(journal.entries.some((entry) => entry.tag === "0002_fhir_store")).toBe(true);
  });
});
