/**
 * Pure tamper-detection tests for walkChain (dangerCheck: audit-bypass). No DB.
 * Each tamper class — mutate, reorder, insert, delete, genesis break, prev-link
 * break — must be flagged at the EXACT first broken index with the exact reason.
 *
 * Inversion-proof by construction: the row_hash_mismatch case mutates a field
 * without rehashing, so if walkChain's recompute were stubbed to always equal
 * the stored hash, that assertion would flip to ok:true and fail.
 */
import { describe, expect, test } from "bun:test";
import type { AuditLogicalFields } from "./row-hash.js";
import { auditRowHash, GENESIS_PREV_HASH, SHA256_HEX_LENGTH } from "./row-hash.js";
import type { AuditChainRow } from "./verify.js";
import { walkChain } from "./verify.js";

function baseFields(seq: string): AuditLogicalFields {
  return {
    actorId: "clinician-1",
    decision: "allow",
    resourceType: "Observation",
    purposeOfUse: "TREAT",
    matchedRuleId: "v0-clinician-treat",
    reason: `read ${seq}`,
    occurredAt: "2026-07-06T00:00:00.000Z",
    practiceId: "22222222-2222-4222-8222-222222222222",
    seq
  };
}

function linkedRow(
  seq: string,
  prevHash: string,
  overrides: Partial<AuditLogicalFields> = {}
): AuditChainRow {
  const fields = { ...baseFields(seq), ...overrides };
  return { fields, prevHash, rowHash: auditRowHash(fields, prevHash) };
}

function cleanChain(): AuditChainRow[] {
  const r1 = linkedRow("1", GENESIS_PREV_HASH);
  const r2 = linkedRow("2", r1.rowHash);
  const r3 = linkedRow("3", r2.rowHash);
  return [r1, r2, r3];
}

describe("walkChain — clean", () => {
  test("a well-formed chain verifies OK", () => {
    const report = walkChain(cleanChain());
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.rows).toBe(3);
  });

  test("the empty chain is trivially OK", () => {
    const report = walkChain([]);
    expect(report.ok).toBe(true);
  });
});

describe("walkChain — tamper classes", () => {
  test("mutation (field changed, not rehashed) → row_hash_mismatch at that index", () => {
    const chain = cleanChain();
    const victim = chain[1]!;
    chain[1] = { ...victim, fields: { ...victim.fields, reason: "SILENTLY EDITED" } };
    const report = walkChain(chain);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("row_hash_mismatch");
      expect(report.brokenIndex).toBe(1);
      expect(report.brokenSeq).toBe("2");
    }
  });

  test("mutation + rehash → breaks the NEXT row's prev_hash link", () => {
    const chain = cleanChain();
    const victim = chain[1]!;
    const forgedFields = { ...victim.fields, reason: "edited and rehashed" };
    chain[1] = {
      ...victim,
      fields: forgedFields,
      rowHash: auditRowHash(forgedFields, victim.prevHash)
    };
    const report = walkChain(chain);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("prev_hash_mismatch");
      expect(report.brokenIndex).toBe(2);
    }
  });

  test("reorder (swap rows 2 and 3) → seq_gap at the first out-of-order index", () => {
    const chain = cleanChain();
    const [r1, r2, r3] = chain;
    const report = walkChain([r1!, r3!, r2!]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("seq_gap");
      expect(report.brokenIndex).toBe(1);
    }
  });

  test("deletion (drop the middle row) → seq_gap where the gap appears", () => {
    const chain = cleanChain();
    const report = walkChain([chain[0]!, chain[2]!]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("seq_gap");
      expect(report.brokenIndex).toBe(1);
      expect(report.brokenSeq).toBe("3");
    }
  });

  test("insertion (forged row spliced in) → seq_gap once the seqs shift", () => {
    const chain = cleanChain();
    const r1 = chain[0]!;
    const forged = linkedRow("2", r1.rowHash, { reason: "forged insert" });
    const report = walkChain([r1, forged, chain[1]!, chain[2]!]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      // The forged row occupies seq slot 2 validly; the ORIGINAL row 2 now sits
      // where seq 3 is expected → the gap surfaces at index 2.
      expect(report.reason).toBe("seq_gap");
      expect(report.brokenIndex).toBe(2);
    }
  });

  test("genesis break: first row not linked to the genesis hash", () => {
    const r1 = linkedRow("1", "f".repeat(SHA256_HEX_LENGTH));
    const report = walkChain([r1]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("genesis_mismatch");
      expect(report.brokenIndex).toBe(0);
    }
  });

  test("prev-link break: a mid-chain row rehashed against a wrong parent", () => {
    const r1 = linkedRow("1", GENESIS_PREV_HASH);
    // r2 is internally consistent (row_hash matches its fields+prevHash) but its
    // prevHash does not equal r1.rowHash → prev_hash_mismatch, not genesis.
    const r2 = linkedRow("2", "a".repeat(SHA256_HEX_LENGTH));
    const report = walkChain([r1, r2]);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe("prev_hash_mismatch");
      expect(report.brokenIndex).toBe(1);
    }
  });
});
