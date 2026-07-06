/**
 * The audit write path + the authorize-and-audit seam. Both run INSIDE a
 * withTenant transaction: practice_id is derived in SQL from the tenant GUC
 * (never a param), and any database fault THROWS so withTenant rolls the whole
 * transaction back (expected outcomes are values; DB faults are throws).
 *
 * Append is chain-safe under concurrency: an advisory xact lock keyed on the
 * practice serializes appends for that tenant, and the (practice_id, seq) +
 * (practice_id, prev_hash) UNIQUE constraints are the structural backstop — a
 * fork or duplicate raises 23505, which throws and rolls back. `authorizeAndAudit`
 * appends UNCONDITIONALLY (no allow/deny branch): every decision emits exactly
 * one row, so a denied read can never slip through without an audit entry.
 */
import { z } from "zod";
import { decide } from "../abac/decide.js";
import type { PolicyReceipt } from "../abac/types.js";
import type { TenantSql } from "../db/tenant.js";
import type { AuditLogicalFields } from "./row-hash.js";
import { auditRowHash, GENESIS_PREV_HASH } from "./row-hash.js";

/** bigint-safe step for the next per-practice sequence number. */
const SEQ_INCREMENT = 1n;

const contextRowSchema = z.object({ practice_id: z.string() });
const tipRowSchema = z.object({ seq: z.string(), row_hash: z.string() });
const insertedRowSchema = z.object({ row_hash: z.string() });

function logicalFields(
  receipt: PolicyReceipt,
  practiceId: string,
  seq: string
): AuditLogicalFields {
  return {
    actorId: receipt.actorId,
    decision: receipt.decision,
    resourceType: receipt.resourceType,
    purposeOfUse: receipt.purposeOfUse,
    matchedRuleId: receipt.matchedRuleId,
    reason: receipt.reason,
    occurredAt: receipt.timestamp,
    practiceId,
    seq
  };
}

/** Append one row to the current tenant's hash chain; returns the persisted row_hash. */
export async function appendAuditRowTx(
  sql: TenantSql,
  receipt: PolicyReceipt
): Promise<{ readonly auditRowHash: string }> {
  await sql`select pg_advisory_xact_lock(hashtext('bonfire.audit.chain'),
    hashtext(coalesce(current_setting('app.current_practice_id', true), '')))`;
  const ctx = await sql`
    select (select safe_uuid(current_setting('app.current_practice_id', true)))::text as practice_id`;
  const context = contextRowSchema.safeParse(ctx[0]);
  if (!context.success) throw new Error("audit append requires a bound practice context");
  const tipRows =
    await sql`select seq::text as seq, row_hash from audit_log order by seq desc limit 1`;
  const tipParsed = tipRows.length === 0 ? undefined : tipRowSchema.parse(tipRows[0]);
  const nextSeq =
    tipParsed === undefined ? "1" : (BigInt(tipParsed.seq) + SEQ_INCREMENT).toString();
  const prevHash = tipParsed === undefined ? GENESIS_PREV_HASH : tipParsed.row_hash;
  const fields = logicalFields(receipt, context.data.practice_id, nextSeq);
  const rowHash = auditRowHash(fields, prevHash);
  const inserted = await sql`
    insert into audit_log
      (practice_id, seq, actor_id, decision, resource_type, purpose_of_use,
       matched_rule_id, reason, occurred_at, prev_hash, row_hash)
    values (
      (select safe_uuid(current_setting('app.current_practice_id', true))),
      ${nextSeq}::bigint, ${receipt.actorId}, ${receipt.decision}, ${receipt.resourceType},
      ${receipt.purposeOfUse}, ${receipt.matchedRuleId}, ${receipt.reason},
      ${receipt.timestamp}::timestamptz, ${prevHash}, ${rowHash})
    returning row_hash`;
  return { auditRowHash: insertedRowSchema.parse(inserted[0]).row_hash };
}

/**
 * The gated read seam: decide the policy from request scope (default-deny), then
 * UNCONDITIONALLY audit the decision. Returns both the receipt (for the caller's
 * response) and the persisted row_hash (for downstream CCP citation linkage).
 */
export async function authorizeAndAudit(
  sql: TenantSql,
  scope: unknown,
  now: () => string = () => new Date().toISOString()
): Promise<{ readonly receipt: PolicyReceipt; readonly auditRowHash: string }> {
  const receipt = decide(scope, now);
  const { auditRowHash } = await appendAuditRowTx(sql, receipt);
  return { receipt, auditRowHash };
}
