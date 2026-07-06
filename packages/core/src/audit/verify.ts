/**
 * Tamper detection over an audit chain. `walkChain` is PURE: it recomputes every
 * row_hash and checks linkage, returning the FIRST broken link. The per-row
 * check order is fixed — sequence gap, then prev_hash linkage (genesis for the
 * first row), then a row_hash recompute — so any mutation, reordering, insertion,
 * or deletion surfaces at the exact index. `verifyAuditChainTx` is the thin DB
 * seam: it reads the tenant's chain under RLS (so it sees only its own rows) and
 * hands the canonical-text rows to `walkChain`.
 */
import { z } from "zod";
import type { TenantSql } from "../db/tenant.js";
import type { AuditLogicalFields } from "./row-hash.js";
import { auditRowHash, GENESIS_PREV_HASH } from "./row-hash.js";

export type ChainBreakReason =
  | "seq_gap"
  | "genesis_mismatch"
  | "prev_hash_mismatch"
  | "row_hash_mismatch";

export interface AuditChainRow {
  readonly fields: AuditLogicalFields;
  readonly prevHash: string;
  readonly rowHash: string;
}

export type AuditChainReport =
  | { readonly ok: true; readonly rows: number }
  | {
      readonly ok: false;
      readonly brokenIndex: number;
      readonly brokenSeq: string;
      readonly reason: ChainBreakReason;
    };

function broken(index: number, row: AuditChainRow, reason: ChainBreakReason): AuditChainReport {
  return { ok: false, brokenIndex: index, brokenSeq: row.fields.seq, reason };
}

/**
 * Walk an ordered chain (seq ascending) and return the first break, or ok. The
 * expected seq is derived from the array position, so a gap/reorder/delete is
 * caught before the hash checks even run.
 */
export function walkChain(rows: readonly AuditChainRow[]): AuditChainReport {
  let expectedPrev = GENESIS_PREV_HASH;
  for (const [index, row] of rows.entries()) {
    const expectedSeq = String(index + 1);
    if (row.fields.seq !== expectedSeq) return broken(index, row, "seq_gap");
    if (row.prevHash !== expectedPrev) {
      return broken(index, row, index === 0 ? "genesis_mismatch" : "prev_hash_mismatch");
    }
    if (auditRowHash(row.fields, row.prevHash) !== row.rowHash) {
      return broken(index, row, "row_hash_mismatch");
    }
    expectedPrev = row.rowHash;
  }
  return { ok: true, rows: rows.length };
}

const chainDbRowSchema = z.object({
  seq: z.string(),
  practice_id: z.string(),
  actor_id: z.string(),
  decision: z.string(),
  resource_type: z.string(),
  purpose_of_use: z.string(),
  matched_rule_id: z.string().nullable(),
  reason: z.string(),
  occurred_at: z.string(),
  prev_hash: z.string(),
  row_hash: z.string()
});

function toChainRow(raw: unknown): AuditChainRow {
  const parsed = chainDbRowSchema.safeParse(raw);
  if (!parsed.success) throw new Error("unexpected audit_log row shape");
  const row = parsed.data;
  return {
    fields: {
      actorId: row.actor_id,
      decision: row.decision,
      resourceType: row.resource_type,
      purposeOfUse: row.purpose_of_use,
      matchedRuleId: row.matched_rule_id,
      reason: row.reason,
      occurredAt: row.occurred_at,
      practiceId: row.practice_id,
      seq: row.seq
    },
    prevHash: row.prev_hash,
    rowHash: row.row_hash
  };
}

/**
 * Read the current tenant's audit chain (RLS-scoped) and verify it. Canonical
 * text is read exactly as it was hashed: `::text` for seq/practice_id, and a
 * UTC `to_char` that byte-matches the ISO-8601 timestamp written at append time.
 */
export async function verifyAuditChainTx(sql: TenantSql): Promise<AuditChainReport> {
  const rows = await sql`
    select seq::text as seq, practice_id::text as practice_id, actor_id, decision,
      resource_type, purpose_of_use, matched_rule_id, reason,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
      prev_hash, row_hash
    from audit_log
    order by seq asc`;
  return walkChain(rows.map((row) => toChainRow(row)));
}
