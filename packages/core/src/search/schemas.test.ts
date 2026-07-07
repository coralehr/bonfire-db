/**
 * Boundary-schema units (STEP 0): the untrusted request is parse-rejected on any
 * malformation, and the response schema pins the citation/freshness shape and the
 * 64-hex hash lengths.
 */
import { describe, expect, test } from "bun:test";
import { searchInputSchema, searchResponseSchema } from "./schemas.js";

const VALID_PRACTICE = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function validInput(): Record<string, unknown> {
  return {
    query: "aspirin",
    subject: { id: "clinician-1", role: "clinician", practiceId: VALID_PRACTICE },
    purposeOfUse: "TREAT"
  };
}

function validResponse(): Record<string, unknown> {
  return {
    results: [
      {
        resourceType: "Observation",
        resourceId: VALID_PRACTICE,
        score: 0.5,
        citation: { resourceId: VALID_PRACTICE, path: "code", rowHash: HASH },
        freshness: { lastUpdated: "2026-07-07T00:00:00.000Z", versionId: "1" }
      }
    ],
    excludedByPolicy: { count: 0, resourceTypes: [] },
    policyReceipt: {
      decision: "allow",
      actorId: "clinician-1",
      resourceType: "Search",
      practiceId: VALID_PRACTICE,
      purposeOfUse: "TREAT",
      matchedRuleId: null,
      reason: "ok",
      timestamp: "2026-07-07T00:00:00.000Z"
    },
    auditEventId: HASH
  };
}

describe("searchInputSchema", () => {
  test("accepts a well-formed clinician request", () => {
    expect(searchInputSchema.safeParse(validInput()).success).toBe(true);
  });

  test("rejects an empty query, an unknown role, a bad purpose, and a non-uuid practice", () => {
    const bad: Record<string, unknown>[] = [
      { ...validInput(), query: "" },
      { ...validInput(), subject: { id: "a", role: "wizard", practiceId: VALID_PRACTICE } },
      { ...validInput(), purposeOfUse: "FISHING" },
      { ...validInput(), subject: { id: "a", role: "clinician", practiceId: "not-a-uuid" } },
      {}
    ];
    for (const input of bad) expect(searchInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("searchResponseSchema", () => {
  test("accepts a well-formed response", () => {
    expect(searchResponseSchema.safeParse(validResponse()).success).toBe(true);
  });

  test("rejects a citation rowHash that is not 64 hex chars", () => {
    const response = validResponse();
    response.results = [
      {
        resourceType: "Observation",
        resourceId: VALID_PRACTICE,
        score: 0.5,
        citation: { resourceId: VALID_PRACTICE, path: "code", rowHash: "tooshort" },
        freshness: { lastUpdated: "2026-07-07T00:00:00.000Z", versionId: "1" }
      }
    ];
    expect(searchResponseSchema.safeParse(response).success).toBe(false);
  });
});
