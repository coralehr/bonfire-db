import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_COMPILER_CONTRACT_VERSION,
  evidenceCompileRequestSchema
} from "./compiler-contract.js";

describe("storage-neutral evidence compiler contract", () => {
  test("parses a bounded, policy-attributed, source-versioned plan", () => {
    const parsed = evidenceCompileRequestSchema.parse({
      contractVersion: EVIDENCE_COMPILER_CONTRACT_VERSION,
      plan: {
        profile: "micro-evidence-v1",
        roots: [{ resourceType: "DiagnosticReport", resourceId: "synthetic-report" }],
        maxDepth: 2,
        maxTargets: 32,
        maxEdges: 128,
        maxCitations: 128
      },
      principal: {
        id: "synthetic-clinician",
        role: "clinician",
        practiceId: "11111111-1111-4111-8111-111111111111"
      },
      purposeOfUse: "TREAT",
      sourceVersion: {
        snapshotId: "synthetic-snapshot-1",
        asOf: "2026-07-13T00:00:00.000Z"
      }
    });
    expect(parsed.plan.maxDepth).toBe(2);
    expect(parsed.sourceVersion.snapshotId).toBe("synthetic-snapshot-1");
  });

  test("rejects unbounded traversal and unattributed purpose", () => {
    const result = evidenceCompileRequestSchema.safeParse({
      contractVersion: EVIDENCE_COMPILER_CONTRACT_VERSION,
      plan: {
        profile: "clinical-reference-v1",
        roots: [{ resourceType: "Patient", resourceId: "synthetic-patient" }],
        maxDepth: 100,
        maxTargets: 1,
        maxEdges: 1,
        maxCitations: 1
      },
      principal: {
        id: "synthetic-clinician",
        role: "clinician",
        practiceId: "11111111-1111-4111-8111-111111111111"
      },
      purposeOfUse: "anything",
      sourceVersion: { snapshotId: "s1", asOf: "2026-07-13T00:00:00.000Z" }
    });
    expect(result.success).toBe(false);
  });
});
