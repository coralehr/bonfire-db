/**
 * The tamper envelope: the digest moves when any covered dimension moves —
 * a span value, the consumed text, the span ORDER, a versionId (replay), or
 * the provenance link — and is deterministic for identical input.
 */
import { describe, expect, test } from "bun:test";
import { ccpContentDigest } from "./content-digest.js";
import type { CcpSpanDraft } from "./schemas.js";

const SRC = "cd".repeat(32);

function draft(overrides: Partial<CcpSpanDraft> = {}): CcpSpanDraft {
  return {
    resourceId: "66666666-6666-4666-8666-666666666666",
    resourceType: "Observation",
    jsonPath: "valueQuantity.value",
    value: 7.25,
    lastUpdated: "2026-07-01T10:00:00.000Z",
    versionId: "1",
    ...overrides
  };
}

describe("ccpContentDigest", () => {
  test("deterministic 64-hex digest for identical input", () => {
    const spans = [draft()];
    const a = ccpContentDigest(spans, "text", SRC);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ccpContentDigest([draft()], "text", SRC)).toBe(a);
  });

  test("moves on value tamper, text tamper, and provenance tamper", () => {
    const base = ccpContentDigest([draft()], "text", SRC);
    expect(ccpContentDigest([draft({ value: 9.99 })], "text", SRC)).not.toBe(base);
    expect(ccpContentDigest([draft()], "text (doctored)", SRC)).not.toBe(base);
    expect(ccpContentDigest([draft()], "text", "dc".repeat(32))).not.toBe(base);
  });

  test("moves on span REORDER and on a versionId (replay) change", () => {
    const first = draft();
    const second = draft({ jsonPath: "valueQuantity.unit", value: "mmol/L" });
    const emitted = ccpContentDigest([first, second], "text", SRC);
    expect(ccpContentDigest([second, first], "text", SRC)).not.toBe(emitted);
    expect(ccpContentDigest([draft({ versionId: "2" })], "text", SRC)).not.toBe(
      ccpContentDigest([draft()], "text", SRC)
    );
  });
});
