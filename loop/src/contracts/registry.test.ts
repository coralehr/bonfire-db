import { describe, expect, test } from "bun:test";
import { allSlices, getSlice, validateEntries, validateRegistry } from "./registry.js";
import type { SliceContract } from "./slice-contract.js";
import { makeSlice } from "./slice-fixture.js";

const EXPECTED_IDS = Array.from(
  { length: 13 },
  (_unused, index) => `BF-${String(index + 1).padStart(2, "0")}`
);

function validSlice(id: string, dependsOn: string[] = []): SliceContract {
  return makeSlice({ id, title: `slice ${id}`, profile: "foundation", dependsOn });
}

// unknown[] (not SliceContract[]) lets failure tests splice in junk entries.
function thirteen(): unknown[] {
  return EXPECTED_IDS.map((id) => validSlice(id));
}

function codes(entries: readonly unknown[]): string[] {
  const result = validateEntries(entries);
  return result.ok ? [] : result.error.issues.map((issue) => issue.code);
}

describe("validateRegistry — the real ./tasks", () => {
  test("validates and holds all 13 slices", () => {
    const result = validateRegistry();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slices).toHaveLength(13);
    } else {
      throw new Error(`registry invalid: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  });

  test("ids are unique and cover exactly BF-01..BF-13", () => {
    const ids = allSlices().map((slice) => slice.id);
    expect([...new Set(ids)].sort()).toEqual(EXPECTED_IDS);
  });

  test("getSlice resolves a known id and returns undefined otherwise", () => {
    expect(getSlice("BF-01")?.id).toBe("BF-01");
    expect(getSlice("BF-99")).toBeUndefined();
  });
});

describe("validateEntries — failure branches (fixtures, not the real registry)", () => {
  test("accepts a valid 13-slice set", () => {
    expect(validateEntries(thirteen()).ok).toBe(true);
  });

  test("flags a duplicate id", () => {
    const entries = thirteen();
    entries[1] = validSlice("BF-01");
    expect(codes(entries)).toContain("duplicate-id");
  });

  test("flags an unexpected id (and the resulting missing one)", () => {
    const entries = thirteen();
    entries[12] = validSlice("BF-14");
    const c = codes(entries);
    expect(c).toContain("unexpected-id");
    expect(c).toContain("missing-id");
  });

  test("flags a missing id", () => {
    expect(codes(thirteen().slice(0, 11))).toContain("missing-id");
  });

  test("flags an unknown dependency", () => {
    const entries = thirteen();
    entries[0] = validSlice("BF-01", ["BF-99"]);
    expect(codes(entries)).toContain("unknown-dependency");
  });

  test("flags a dependency cycle", () => {
    const entries = thirteen();
    entries[0] = validSlice("BF-01", ["BF-02"]);
    entries[1] = validSlice("BF-02", ["BF-01"]);
    expect(codes(entries)).toContain("dependency-cycle");
  });

  test("flags a self-dependency cycle", () => {
    const entries = thirteen();
    entries[0] = validSlice("BF-01", ["BF-01"]);
    expect(codes(entries)).toContain("dependency-cycle");
  });

  test("flags an invalid (malformed) contract", () => {
    const entries = thirteen();
    entries[0] = { id: "BF-01", junk: true };
    expect(codes(entries)).toContain("invalid-contract");
  });
});
