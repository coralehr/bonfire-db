/**
 * The CCP-level policy receipt, assembled directly (the BF-06 buildSearchReceipt
 * precedent). `practiceId` is the bound-tenant id read from the GUC — never
 * caller input (T7) — and `purposeOfUse` is the parsed request purpose, so the
 * receipt and the audit chain can never diverge from what was evaluated.
 * `resourceType` is the synthetic aggregate 'CcpProjection'.
 */
import type { Decision, PolicyReceipt, PurposeOfUse } from "../abac/types.js";

const CCP_RESOURCE_TYPE = "CcpProjection";

export interface CcpReceiptFields {
  readonly decision: Decision;
  readonly actorId: string;
  readonly practiceId: string;
  readonly purposeOfUse: PurposeOfUse;
  readonly reason: string;
  readonly timestamp: string;
}

export function buildCcpReceipt(fields: CcpReceiptFields): PolicyReceipt {
  const { decision, actorId, practiceId, purposeOfUse, reason, timestamp } = fields;
  return {
    decision,
    actorId,
    resourceType: CCP_RESOURCE_TYPE,
    practiceId,
    purposeOfUse,
    matchedRuleId: null,
    reason,
    timestamp
  };
}
