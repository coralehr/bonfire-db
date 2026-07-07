/**
 * The Search-level policy receipt, assembled directly (the BF-13 buildAuthReceipt
 * precedent) since `decide()` receipts are per-candidate-type. `practiceId` is the
 * bound-tenant id read from the GUC and `purposeOfUse` is the real request purpose
 * — the exact values appended to the audit chain, so receipt and audit never
 * diverge. `resourceType` is the synthetic aggregate 'Search'.
 */
import type { Decision, PolicyReceipt, PurposeOfUse } from "../abac/types.js";

const SEARCH_RESOURCE_TYPE = "Search";

export interface SearchReceiptFields {
  readonly decision: Decision;
  readonly actorId: string;
  readonly practiceId: string;
  readonly purposeOfUse: PurposeOfUse;
  readonly reason: string;
  readonly timestamp: string;
}

export function buildSearchReceipt(fields: SearchReceiptFields): PolicyReceipt {
  return {
    decision: fields.decision,
    actorId: fields.actorId,
    resourceType: SEARCH_RESOURCE_TYPE,
    practiceId: fields.practiceId,
    purposeOfUse: fields.purposeOfUse,
    matchedRuleId: null,
    reason: fields.reason,
    timestamp: fields.timestamp
  };
}
