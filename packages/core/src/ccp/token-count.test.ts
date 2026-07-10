/**
 * Token-measurement hook (acceptance #6/#7): a pluggable NAMED tokenizer,
 * fully offline (bundled o200k_base ranks, zero keys), and the golden-set
 * residual: the CCP text is >= 1.4x smaller in tokens than the compact-JSON
 * baseline of the IDENTICAL span set. All fixture data is synthetic.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CcpDocument } from "./schemas.js";
import { ccpDocumentSchema } from "./schemas.js";
import type { CcpGroup } from "./serialize.js";
import { serializeCcp } from "./serialize.js";
import type { TokenCounter } from "./token-count.js";
import { measureCcp, o200kCounter } from "./token-count.js";

const RESIDUAL_FLOOR = 1.4;
const AUDIT_HASH = "5a".repeat(32);

function group(resourceType: string, spans: CcpGroup["spans"]): CcpGroup {
  return {
    resourceType,
    resourceId: randomUUID(),
    lastUpdated: "2026-07-08T09:15:00.000Z",
    versionId: "1",
    spans
  };
}

/** A realistic synthetic golden set — the EXP1 measurement shape. */
function goldenGroups(): CcpGroup[] {
  return [
    group("Condition", [
      { jsonPath: "code.coding.0.display", value: "Essential (primary) hypertension" },
      { jsonPath: "code.coding.0.code", value: "I10" },
      { jsonPath: "clinicalStatus.coding.0.code", value: "active" },
      { jsonPath: "onsetDateTime", value: "2023-04-02" },
      { jsonPath: "note.0.text", value: "Blood pressure improving on current therapy." }
    ]),
    group("Observation", [
      { jsonPath: "code.coding.0.display", value: "Systolic blood pressure" },
      { jsonPath: "valueQuantity.value", value: 132 },
      { jsonPath: "valueQuantity.unit", value: "mm[Hg]" },
      { jsonPath: "effectiveDateTime", value: "2026-06-30T08:45:00Z" }
    ]),
    group("MedicationRequest", [
      {
        jsonPath: "medicationCodeableConcept.coding.0.display",
        value: "Lisinopril 10 MG Oral Tablet"
      },
      { jsonPath: "status", value: "active" },
      { jsonPath: "authoredOn", value: "2025-11-14" }
    ]),
    group("AllergyIntolerance", [
      { jsonPath: "code.coding.0.display", value: "Penicillin V" },
      { jsonPath: "clinicalStatus.coding.0.code", value: "active" },
      { jsonPath: "recordedDate", value: "2019-08-21" }
    ]),
    group("Observation", [
      { jsonPath: "code.coding.0.display", value: "Hemoglobin A1c" },
      { jsonPath: "valueQuantity.value", value: 6.8 },
      { jsonPath: "valueQuantity.unit", value: "%" },
      { jsonPath: "note.0.text", value: "Repeat in three months; continue lifestyle plan." }
    ]),
    group("DocumentReference", [
      { jsonPath: "type.coding.0.display", value: "Discharge summary" },
      { jsonPath: "content.0.attachment.title", value: "2026-05 cardiology discharge note" },
      { jsonPath: "date", value: "2026-05-19" },
      { jsonPath: "status", value: "current" }
    ])
  ];
}

function goldenDocument(): CcpDocument {
  const groups = goldenGroups();
  const text = serializeCcp({ sourceAuditEventId: "6b".repeat(32), excludedByPolicy: [] }, groups);
  const spans = groups.flatMap((g) =>
    g.spans.map((span) => ({
      resourceId: g.resourceId,
      resourceType: g.resourceType,
      jsonPath: span.jsonPath,
      value: span.value,
      auditHash: AUDIT_HASH,
      lastUpdated: g.lastUpdated,
      versionId: g.versionId
    }))
  );
  return ccpDocumentSchema.parse({
    version: "ccp/v1",
    auditEventId: AUDIT_HASH,
    practiceId: randomUUID(),
    generatedAt: "2026-07-08T09:16:00.000Z",
    spans,
    excludedByPolicy: { count: 0, resourceTypes: [] },
    text
  });
}

describe("measureCcp — pluggable, named, offline", () => {
  test("default counter is the named bundled o200k_base (offline, zero keys)", () => {
    expect(o200kCounter.tokenizerId).toBe("gpt-tokenizer/o200k_base");
    expect(o200kCounter.count("")).toBe(0);
    expect(o200kCounter.count("synthetic blood pressure")).toBeGreaterThan(0);
  });

  test("a custom counter is honoured end-to-end (id threaded, counts used)", () => {
    const perChar: TokenCounter = {
      tokenizerId: "test/per-char",
      count: (text: string): number => text.length
    };
    const doc = goldenDocument();
    const measured = measureCcp(doc, perChar);
    expect(measured.tokenizerId).toBe("test/per-char");
    expect(measured.ccpTokens).toBe(doc.text.length);
    expect(measured.baselineTokens).toBe(JSON.stringify(doc.spans).length);
    expect(measured.ratio).toBeCloseTo(measured.baselineTokens / measured.ccpTokens, 10);
  });

  test(`golden set: CCP is >= ${RESIDUAL_FLOOR}x smaller than compact JSON of the same spans`, () => {
    const measured = measureCcp(goldenDocument());
    expect(measured.tokenizerId).toBe("gpt-tokenizer/o200k_base");
    expect(measured.ccpTokens).toBeGreaterThan(0);
    expect(measured.baselineTokens).toBeGreaterThan(measured.ccpTokens);
    expect(measured.ratio).toBeGreaterThanOrEqual(RESIDUAL_FLOOR);
  });
});
