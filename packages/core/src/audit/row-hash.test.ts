/**
 * Pure hash-chain preimage tests (dangerCheck: audit-bypass). No DB.
 * Proves: genesis == pinned (drift catch), determinism, null-vs-omitted preimage
 * divergence (matched_rule_id coverage), and N+1 linkage.
 */
import { describe, expect, test } from "bun:test";
import { canonicalizeJson, sha256Hex } from "../db/canonical-json.js";
import type { AuditLogicalFields } from "./row-hash.js";
import {
  AUDIT_CHAIN_DOMAIN,
  auditRowHash,
  GENESIS_PREV_HASH,
  SHA256_HEX_LENGTH
} from "./row-hash.js";

function fields(overrides: Partial<AuditLogicalFields> = {}): AuditLogicalFields {
  return {
    actorId: "clinician-1",
    decision: "allow",
    resourceType: "Observation",
    purposeOfUse: "TREAT",
    matchedRuleId: "v0-clinician-treat",
    reason: "allow: matched rule v0-clinician-treat",
    occurredAt: "2026-07-06T00:00:00.000Z",
    practiceId: "22222222-2222-4222-8222-222222222222",
    seq: "1",
    ...overrides
  };
}

describe("genesis hash", () => {
  test("pinned GENESIS_PREV_HASH equals a fresh recompute (drift guard)", () => {
    const recomputed = sha256Hex(canonicalizeJson({ domain: AUDIT_CHAIN_DOMAIN }));
    expect(recomputed).toBe(GENESIS_PREV_HASH);
    expect(GENESIS_PREV_HASH.length).toBe(SHA256_HEX_LENGTH);
  });
});

describe("auditRowHash", () => {
  test("is a 64-char lowercase-hex SHA-256", () => {
    const hash = auditRowHash(fields(), GENESIS_PREV_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.length).toBe(SHA256_HEX_LENGTH);
  });

  test("is deterministic for identical input", () => {
    expect(auditRowHash(fields(), GENESIS_PREV_HASH)).toBe(
      auditRowHash(fields(), GENESIS_PREV_HASH)
    );
  });

  test("changes when any logical field changes", () => {
    const base = auditRowHash(fields(), GENESIS_PREV_HASH);
    expect(auditRowHash(fields({ reason: "tampered" }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(auditRowHash(fields({ decision: "deny" }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(auditRowHash(fields({ purposeOfUse: "HPAYMT" }), GENESIS_PREV_HASH)).not.toBe(base);
    expect(auditRowHash(fields({ seq: "2" }), GENESIS_PREV_HASH)).not.toBe(base);
  });

  test("changes when prev_hash changes (chain binding)", () => {
    const a = auditRowHash(fields(), GENESIS_PREV_HASH);
    const b = auditRowHash(fields(), "0".repeat(SHA256_HEX_LENGTH));
    expect(a).not.toBe(b);
  });

  test("null matched_rule_id and omitted matched_rule_id do NOT hash the same", () => {
    // A deny with matchedRuleId: null must produce a preimage that still carries
    // the key. If canonical JSON dropped it, this would collapse and tamper
    // coverage of the field would be lost.
    const withNull = auditRowHash(fields({ matchedRuleId: null }), GENESIS_PREV_HASH);
    const omitted = sha256Hex(
      canonicalizeJson({
        actor_id: "clinician-1",
        decision: "allow",
        occurred_at: "2026-07-06T00:00:00.000Z",
        practice_id: "22222222-2222-4222-8222-222222222222",
        prev_hash: GENESIS_PREV_HASH,
        purpose_of_use: "TREAT",
        reason: "allow: matched rule v0-clinician-treat",
        resource_type: "Observation",
        seq: "1"
      })
    );
    expect(withNull).not.toBe(omitted);
  });

  test("N+1 linkage: row2.prev_hash = row1.row_hash chains deterministically", () => {
    const row1 = auditRowHash(fields({ seq: "1" }), GENESIS_PREV_HASH);
    const row2 = auditRowHash(fields({ seq: "2", decision: "deny", matchedRuleId: null }), row1);
    expect(row2).not.toBe(row1);
    // Recomputing row2 from row1's hash yields the same value (stable chain).
    const row2Again = auditRowHash(
      fields({ seq: "2", decision: "deny", matchedRuleId: null }),
      row1
    );
    expect(row2Again).toBe(row2);
  });
});
