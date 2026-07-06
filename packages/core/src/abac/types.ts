/**
 * ABAC boundary types + the single untrusted Zod schema for a read request's
 * access scope. This module is deliberately free of any database dependency:
 * a policy decision is computed from request scope ALONE (scope-before-retrieve),
 * so nothing here may reach for a target row.
 */
import { z } from "zod";

/** The v0 fixed role set (attribute of the requesting subject). */
export const ROLES = ["clinician", "biller", "operations", "researcher"] as const;

/**
 * HL7 purpose-of-use values accepted at the boundary. ETREAT (emergency /
 * break-glass elevation) parses but is NOT grantable in v0 — it never matches
 * an allow rule, so it default-denies; the elevation flow is deferred post-v0.
 */
export const PURPOSES_OF_USE = ["TREAT", "HPAYMT", "HOPERAT", "HRESCH", "ETREAT"] as const;

export type Role = (typeof ROLES)[number];
export type PurposeOfUse = (typeof PURPOSES_OF_USE)[number];

/** The two-valued decision outcome recorded on every receipt and audit row. */
export type Decision = "allow" | "deny";

/**
 * The purpose-of-use recorded on a receipt. A well-formed request carries a
 * typed `PurposeOfUse`; a malformed request (unparseable scope) carries the
 * `"unknown"` sentinel so a missing/garbage purpose can never masquerade as an
 * allow-implying value.
 */
export type ReceiptPurpose = PurposeOfUse | "unknown";

const subjectSchema = z.object({
  id: z.string().min(1),
  role: z.enum(ROLES),
  practiceId: z.uuid()
});

const resourceAttrsSchema = z.object({
  resourceType: z.string().min(1),
  practiceId: z.uuid()
});

/**
 * The ONE untrusted boundary of the decision: parse, don't validate. Every
 * field is required; no `.default()` / `.catch()` (a defaulted enum would turn
 * a missing purpose into a silent allow-implying value).
 */
export const accessScopeSchema = z.object({
  subject: subjectSchema,
  resource: resourceAttrsSchema,
  purposeOfUse: z.enum(PURPOSES_OF_USE),
  requestPracticeId: z.uuid()
});

export type Subject = z.infer<typeof subjectSchema>;
export type ResourceAttrs = z.infer<typeof resourceAttrsSchema>;
export type AccessScope = z.infer<typeof accessScopeSchema>;

/**
 * The structured policy receipt emitted for BOTH allow and deny outcomes. The
 * `purposeOfUse` here is the exact value used in the decision, so the receipt
 * and the audit row can never diverge from what was actually evaluated.
 */
export interface PolicyReceipt {
  readonly decision: Decision;
  readonly actorId: string;
  readonly resourceType: string;
  readonly practiceId: string;
  readonly purposeOfUse: ReceiptPurpose;
  readonly matchedRuleId: string | null;
  readonly reason: string;
  readonly timestamp: string;
}
