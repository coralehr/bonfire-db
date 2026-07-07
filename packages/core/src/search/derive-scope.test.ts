/**
 * Pure units for scope derivation: a clinician acting for TREAT on the bound
 * practice gets all 8 searchable types; anything else (wrong role, wrong purpose,
 * cross-practice subject) lands every type in excludedByPolicy with a deny reason.
 * decide() stays the authority — deriveScope only partitions its verdicts.
 */
import { describe, expect, test } from "bun:test";
import { deriveScope, isSearchableType, SEARCHABLE_TYPES } from "./derive-scope.js";

const PRACTICE = "22222222-2222-4222-8222-222222222222";
const OTHER_PRACTICE = "33333333-3333-4333-8333-333333333333";
const CLOCK = (): string => "2026-07-07T00:00:00.000Z";

describe("SEARCHABLE_TYPES", () => {
  test("is the 8 clinical types and drives isSearchableType", () => {
    expect(SEARCHABLE_TYPES.length).toBe(8);
    expect(isSearchableType("Observation")).toBe(true);
    expect(isSearchableType("Consent")).toBe(false);
  });
});

describe("deriveScope", () => {
  test("clinician + TREAT + matching practice: all 8 allowed, none excluded", () => {
    const scope = deriveScope(
      { id: "c1", role: "clinician", practiceId: PRACTICE },
      "TREAT",
      PRACTICE,
      CLOCK
    );
    expect([...scope.allowed].sort()).toEqual([...SEARCHABLE_TYPES].sort());
    expect(scope.excluded).toEqual([]);
  });

  test("non-clinician role (biller): all types excluded, none allowed", () => {
    const scope = deriveScope(
      { id: "b1", role: "biller", practiceId: PRACTICE },
      "HPAYMT",
      PRACTICE,
      CLOCK
    );
    expect(scope.allowed).toEqual([]);
    expect(scope.excluded.length).toBe(SEARCHABLE_TYPES.length);
    expect(scope.excluded.every((e) => e.matchedRuleId === null)).toBe(true);
  });

  test("cross-practice subject (subject.practiceId != request): denies every type", () => {
    const scope = deriveScope(
      { id: "c1", role: "clinician", practiceId: OTHER_PRACTICE },
      "TREAT",
      PRACTICE,
      CLOCK
    );
    expect(scope.allowed).toEqual([]);
    expect(scope.excluded.length).toBe(SEARCHABLE_TYPES.length);
  });
});
