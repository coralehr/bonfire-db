/**
 * Authentication-decision audit (BF-13, acceptance #7). EVERY authentication
 * outcome — success and failure — emits exactly one append-only, hash-chained
 * audit row via the BF-05 audit API. Each helper opens the CORRECT tenant
 * transaction and calls `appendAuditRowTx` exactly once:
 *
 *   success        -> the RESOLVED practice's chain (GUC = membership.practiceId)
 *   failure (both  -> the reserved SYSTEM practice's chain (GUC = SYSTEM), because
 *     verify-fail    a failed auth has no tenant. The receipt's practiceId is the
 *     & no-member)   "unknown" sentinel, which BF-05's mis-attribution guard
 *                    whitelists, and RLS keeps SYSTEM rows invisible to any real
 *                    tenant.
 *
 * `import type { TenantDb }` only — no `postgres` handle is taken here; the tenant
 * transaction is owned by `withTenant`, so the audit write is transaction-local
 * and pooling-safe like every other write.
 */
import type { Decision, PolicyReceipt } from "../abac/types.js";
import { appendAuditRowTx } from "../audit/audit-log.js";
import type { Membership, TenantDb, WithTenantErrorCode } from "../db/tenant.js";
import type { BonfireError, Result } from "../result.js";
import { err } from "../result.js";
import type { AuthErrorCode } from "./errors.js";
import type { VerifiedIdentity } from "./types.js";

/**
 * The audit chain is append-only: an append reads the current tip and writes
 * tip.seq+1. Two decisions racing onto the SAME chain (notably the shared SYSTEM
 * chain, through which EVERY failed auth flows) can both read the same tip and
 * collide on the (practice_id, seq) unique index (23505 -> a rolled-back
 * TENANT_TX_FAILED). That is a transient optimistic-concurrency conflict, not a
 * lost decision: retrying re-reads the advanced tip and appends cleanly (the
 * rolled-back attempt committed nothing, so a retry never double-writes). A
 * bounded retry keeps "every decision writes exactly one audit row" true under
 * normal concurrency instead of silently dropping an authentication record. (A
 * hot shared chain under SUSTAINED high concurrency can still exhaust the bound;
 * see the ADR — sharding/serializing the SYSTEM chain is a documented follow-up.)
 */
const MAX_AUDIT_APPEND_ATTEMPTS = 12;

/**
 * The reserved system tenant that owns the failed-authentication hash chain. A
 * failed auth resolves to no practice, but every decision must still be audited;
 * SYSTEM gives those rows their own genesis chain that no real tenant can read
 * (RLS holds), so a denial is recorded without leaking into a customer's chain.
 */
export const SYSTEM_PRACTICE_ID = "00000000-0000-4000-8000-000000000000";

const AUTH_RESOURCE_TYPE = "Authentication";
const AUTH_REASON_VERIFIED = "auth: verified";
const AUTH_REASON_NO_MEMBERSHIP = "auth: no membership";
const AUTH_REASON_MEMBERSHIP_LOOKUP_FAILED = "auth: membership lookup failed";
const UNKNOWN_PRACTICE = "unknown";
const UNVERIFIED_ACTOR = "unverified";

/** Why an authentication failed: a verification error OR a missing membership. */
export type AuthFailure =
  | { readonly kind: "verify"; readonly code: AuthErrorCode }
  | { readonly kind: "no-membership"; readonly identity: VerifiedIdentity }
  | { readonly kind: "membership-lookup-failed"; readonly identity: VerifiedIdentity };

/** The Result an audit helper returns: the persisted row_hash, or a typed tx error. */
export type AuthAuditResult = Result<
  { readonly auditRowHash: string },
  BonfireError<WithTenantErrorCode>
>;

/** Collision-free serialization of the issuer/subject tuple used in audit rows. */
export function authActorId(identity: Pick<VerifiedIdentity, "iss" | "sub">): string {
  return JSON.stringify([identity.iss, identity.sub]);
}

interface AuthReceiptFields {
  readonly decision: Decision;
  readonly actorId: string;
  readonly practiceId: string;
  readonly reason: string;
  readonly timestamp: string;
}

/** Assemble the locked Authentication receipt shape shared by every auth decision. */
export function buildAuthReceipt(fields: AuthReceiptFields): PolicyReceipt {
  return {
    decision: fields.decision,
    actorId: fields.actorId,
    resourceType: AUTH_RESOURCE_TYPE,
    practiceId: fields.practiceId,
    purposeOfUse: "unknown",
    matchedRuleId: null,
    reason: fields.reason,
    timestamp: fields.timestamp
  };
}

function failureReceipt(failure: AuthFailure, timestamp: string): PolicyReceipt {
  switch (failure.kind) {
    case "verify":
      return buildAuthReceipt({
        decision: "deny",
        actorId: UNVERIFIED_ACTOR,
        practiceId: UNKNOWN_PRACTICE,
        reason: `auth: ${failure.code}`,
        timestamp
      });
    case "no-membership":
      return buildAuthReceipt({
        decision: "deny",
        actorId: authActorId(failure.identity),
        practiceId: UNKNOWN_PRACTICE,
        reason: AUTH_REASON_NO_MEMBERSHIP,
        timestamp
      });
    case "membership-lookup-failed":
      return buildAuthReceipt({
        decision: "deny",
        actorId: authActorId(failure.identity),
        practiceId: UNKNOWN_PRACTICE,
        reason: AUTH_REASON_MEMBERSHIP_LOOKUP_FAILED,
        timestamp
      });
  }
}

/** Append `receipt` to `practiceId`'s chain, retrying transient append conflicts. */
async function appendAuthAudit(
  tenantDb: TenantDb,
  practiceId: string,
  receipt: PolicyReceipt
): Promise<AuthAuditResult> {
  let last: AuthAuditResult | undefined;
  for (let attempt = 0; attempt < MAX_AUDIT_APPEND_ATTEMPTS; attempt += 1) {
    last = await tenantDb.withTenant(practiceId, (sql) => appendAuditRowTx(sql, receipt));
    if (last.ok) return last;
  }
  return last ?? err({ code: "TENANT_TX_FAILED", message: "audit append not attempted" });
}

/** Record a successful authentication on the RESOLVED practice's chain (allow). */
export function auditAuthSuccess(
  tenantDb: TenantDb,
  identity: VerifiedIdentity,
  membership: Membership,
  now: () => string = () => new Date().toISOString()
): Promise<AuthAuditResult> {
  const receipt = buildAuthReceipt({
    decision: "allow",
    actorId: authActorId(identity),
    practiceId: membership.practiceId,
    reason: AUTH_REASON_VERIFIED,
    timestamp: now()
  });
  return appendAuthAudit(tenantDb, membership.practiceId, receipt);
}

/** Record a failed authentication on the SYSTEM chain (deny, practiceId unknown). */
export function auditAuthFailure(
  tenantDb: TenantDb,
  failure: AuthFailure,
  now: () => string = () => new Date().toISOString()
): Promise<AuthAuditResult> {
  const receipt = failureReceipt(failure, now());
  return appendAuthAudit(tenantDb, SYSTEM_PRACTICE_ID, receipt);
}
