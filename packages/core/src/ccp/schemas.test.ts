/**
 * Boundary schemas (acceptance #2): every CCP document is Zod-validated —
 * a span with an empty resourceId/jsonPath or a malformed auditHash is
 * rejected, and the input schema refuses a request without a valid purpose.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ccpDocumentSchema, ccpInputSchema } from "./schemas.js";

const HASH = "7c".repeat(32);

function validDocument(): Record<string, unknown> {
  return {
    version: "ccp/v1",
    auditEventId: HASH,
    practiceId: randomUUID(),
    generatedAt: "2026-07-08T09:16:00.000Z",
    spans: [
      {
        resourceId: randomUUID(),
        resourceType: "Observation",
        jsonPath: "valueQuantity.value",
        value: 6.8,
        auditHash: HASH,
        lastUpdated: "2026-07-08T09:15:00.000Z",
        versionId: "1"
      }
    ],
    excludedByPolicy: { count: 0, resourceTypes: [] },
    text: `CCP v1 audit=${HASH}`
  };
}

function withSpanField(field: string, value: unknown): Record<string, unknown> {
  const doc = validDocument();
  const spans = doc.spans as [Record<string, unknown>];
  spans[0][field] = value;
  return doc;
}

describe("ccpDocumentSchema", () => {
  test("accepts a well-formed document", () => {
    expect(ccpDocumentSchema.safeParse(validDocument()).success).toBe(true);
  });

  test.each([
    ["resourceId", ""],
    ["resourceId", "not-a-uuid"],
    ["jsonPath", ""],
    ["auditHash", "abc123"],
    ["value", { nested: "object" }],
    ["value", null]
  ])("rejects a span whose %s is %p", (field, value) => {
    expect(ccpDocumentSchema.safeParse(withSpanField(field, value)).success).toBe(false);
  });

  test("rejects a wrong version tag and an empty text", () => {
    expect(ccpDocumentSchema.safeParse({ ...validDocument(), version: "ccp/v2" }).success).toBe(
      false
    );
    expect(ccpDocumentSchema.safeParse({ ...validDocument(), text: "" }).success).toBe(false);
  });
});

describe("ccpInputSchema", () => {
  test("rejects garbage, a missing subject, and an invalid purpose enum", () => {
    expect(ccpInputSchema.safeParse(null).success).toBe(false);
    expect(ccpInputSchema.safeParse({}).success).toBe(false);
    const response = {
      results: [],
      excludedByPolicy: { count: 0, resourceTypes: [] },
      policyReceipt: {
        decision: "allow",
        practiceId: randomUUID(),
        purposeOfUse: "TREAT",
        timestamp: "2026-07-08T09:15:00.000Z"
      },
      auditEventId: HASH
    };
    const subject = { id: "clin-1", role: "clinician", practiceId: randomUUID() };
    expect(ccpInputSchema.safeParse({ response, subject, purposeOfUse: "TREAT" }).success).toBe(
      true
    );
    expect(ccpInputSchema.safeParse({ response, subject, purposeOfUse: "unknown" }).success).toBe(
      false
    );
    expect(ccpInputSchema.safeParse({ response, purposeOfUse: "TREAT" }).success).toBe(false);
  });
});
