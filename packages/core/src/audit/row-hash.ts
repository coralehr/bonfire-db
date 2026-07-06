/**
 * The audit hash-chain preimage. `auditRowHash` is a PURE, deterministic
 * SHA-256 over the RFC 8785 canonical JSON of a row's logical fields plus the
 * parent `prev_hash`. Keys are the snake_case DB column names so the preimage
 * is stable and independent of any TypeScript field renaming. `matched_rule_id`
 * is serialized as an explicit `null` (never omitted): canonical JSON drops
 * `undefined` members, so an omitted key would silently shrink the preimage and
 * drop that field from tamper coverage.
 */
import type { JsonObject } from "../db/canonical-json.js";
import { canonicalizeJson, sha256Hex } from "../db/canonical-json.js";

/** Domain separator so the genesis hash cannot collide with any row preimage. */
export const AUDIT_CHAIN_DOMAIN = "bonfire.audit.v1.genesis";

/** Length of a lowercase-hex SHA-256 digest. */
export const SHA256_HEX_LENGTH = 64;

/**
 * Fixed, documented genesis hash the FIRST row of every per-practice chain
 * links from: `sha256Hex(canonicalizeJson({ domain: AUDIT_CHAIN_DOMAIN }))`.
 * Pinned as a literal so any drift in the domain or the hashing is caught by a
 * unit test that recomputes it.
 */
export const GENESIS_PREV_HASH = "40c830dd17cd0878cb29288c881f77e1c581a4dc40ab784552ad309f8260978c";

/**
 * A row's logical fields — every value is a string (or `null`), read back from
 * the DB as canonical text (`::text` for `practice_id`/`seq`, `to_char` for
 * `occurred_at`) so the write-time and verify-time preimages byte-match.
 */
export interface AuditLogicalFields {
  readonly actorId: string;
  readonly decision: string;
  readonly resourceType: string;
  readonly purposeOfUse: string;
  readonly matchedRuleId: string | null;
  readonly reason: string;
  readonly occurredAt: string;
  readonly practiceId: string;
  readonly seq: string;
}

/** SHA-256 over the canonical serialization of the logical fields + prev_hash. */
export function auditRowHash(fields: AuditLogicalFields, prevHash: string): string {
  const preimage: JsonObject = {
    actor_id: fields.actorId,
    decision: fields.decision,
    matched_rule_id: fields.matchedRuleId,
    occurred_at: fields.occurredAt,
    practice_id: fields.practiceId,
    prev_hash: prevHash,
    purpose_of_use: fields.purposeOfUse,
    reason: fields.reason,
    resource_type: fields.resourceType,
    seq: fields.seq
  };
  return sha256Hex(canonicalizeJson(preimage));
}
