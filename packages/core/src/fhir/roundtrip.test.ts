/**
 * Round-trip losslessness + the lossless-or-ledgered gate (ratchet BP-008).
 *
 * Every conformant golden must round-trip (typed→FHIR→typed) with ZERO
 * structural diffs, the one decimal-scale normalization must be ledgered, and
 * the three-state inversion proves the gate: a dropped field with no ADR-backed
 * ledger entry FAILS, adding the entry+ADR passes, deleting the ADR FAILS again.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decimalDiffs,
  evaluateRoundTrip,
  fromFhir,
  parseJsonValue,
  parseLossLedger,
  roundTrip,
  type ScribeInput,
  structuralDiffs,
  toFhir,
  toJsonObject
} from "../index.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, "fixtures", "golden");
const LEDGER = join(REPO_ROOT, "docs", "loss-ledger.md");

function goldenNames(): string[] {
  return readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && !f.includes("-bad-"));
}

function inputFromGolden(name: string): ScribeInput {
  const raw = readFileSync(join(GOLDEN_DIR, name), "utf8");
  const recovered = fromFhir(toJsonObject(parseJsonValue(raw)));
  if (!recovered.ok) throw new Error(`${name} not mappable`);
  return recovered.data;
}

describe("typed→FHIR→typed round-trip is lossless", () => {
  test("all nine scribe resources are covered by the goldens", () => {
    const types = new Set(goldenNames().map((n) => inputFromGolden(n).resourceType));
    expect(types.size).toBe(9);
  });

  for (const name of goldenNames()) {
    test(`${name} round-trips with zero structural diffs`, () => {
      const input = inputFromGolden(name);
      const trip = roundTrip(input);
      expect(trip.recovered.ok).toBe(true);
      if (!trip.recovered.ok) return;
      const diffs = structuralDiffs(
        input.resourceType,
        toJsonObject(input),
        toJsonObject(trip.recovered.data)
      );
      expect(diffs).toEqual([]);
    });
  }

  for (const name of goldenNames()) {
    test(`${name} is reproducible: toFhir(fromFhir(golden)) equals the golden`, () => {
      const raw = readFileSync(join(GOLDEN_DIR, name), "utf8");
      const golden = toJsonObject(parseJsonValue(raw));
      const input = inputFromGolden(name);
      // FHIR-first idempotence — any field a builder failed to re-emit shows here.
      expect(structuralDiffs(input.resourceType, golden, toFhir(input))).toEqual([]);
    });
  }
});

describe("decimal-scale loss is detected and ledgered", () => {
  test("observation-decimal.json has exactly one ledgered decimal diff", () => {
    const raw = readFileSync(join(GOLDEN_DIR, "observation-decimal.json"), "utf8");
    const diffs = decimalDiffs("Observation", raw);
    expect(diffs).toEqual([
      {
        resourceType: "Observation",
        pointer: "/valueQuantity/value",
        kind: "decimal-scale",
        detail: "2.0 → 2"
      }
    ]);
    const ledger = parseLossLedger(readFileSync(LEDGER, "utf8"));
    const evaluation = evaluateRoundTrip({
      diffs,
      ledger,
      knownAdrs: ["docs/adr/decimal-normalization.md"]
    });
    expect(evaluation.ok).toBe(true);
  });

  test("the real ledger has one entry that references its ADR", () => {
    const ledger = parseLossLedger(readFileSync(LEDGER, "utf8"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.resourceType).toBe("Observation");
    expect(ledger[0]?.adr).toBe("docs/adr/decimal-normalization.md");
  });
});

describe("lossless-or-ledgered three-state inversion (BP-008)", () => {
  const input = { resourceType: "Patient", id: "x", birthDate: "1990-01-01" } as const;
  const dropped = { resourceType: "Patient", id: "x" } as const;
  const diffs = structuralDiffs("Patient", toJsonObject(input), toJsonObject(dropped));

  test("a dropped field produces a structural diff", () => {
    expect(diffs).toEqual([
      {
        resourceType: "Patient",
        pointer: "/birthDate",
        kind: "missing",
        detail: "missing key birthDate"
      }
    ]);
  });

  test("state 1 — diff with NO ledger entry FAILS", () => {
    expect(evaluateRoundTrip({ diffs, ledger: [], knownAdrs: [] }).ok).toBe(false);
  });

  test("state 2 — ledger entry + existing ADR PASSES", () => {
    const ledger = [
      { resourceType: "Patient", pointer: "/birthDate", reason: "test", adr: "docs/adr/x.md" }
    ];
    expect(evaluateRoundTrip({ diffs, ledger, knownAdrs: ["docs/adr/x.md"] }).ok).toBe(true);
  });

  test("state 3 — same ledger entry but ADR deleted FAILS", () => {
    const ledger = [
      { resourceType: "Patient", pointer: "/birthDate", reason: "test", adr: "docs/adr/x.md" }
    ];
    expect(evaluateRoundTrip({ diffs, ledger, knownAdrs: [] }).ok).toBe(false);
  });
});
