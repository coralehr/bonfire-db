/**
 * The pure, TOTAL policy decision. `decide` returns a `PolicyReceipt` for EVERY
 * input and NEVER throws: an unparseable scope, an unknown actor, or any missing
 * field resolves to a deny receipt (default-deny, fail-closed). Cedar/OPA
 * semantics without a runtime PDP: forbid rules win, then allow rules, else
 * default-deny — no rule ordering. The signature takes scope + a clock ONLY
 * (never a sql handle or a row): the decision is computed before any retrieval.
 */
import type { AccessScope, Decision, PolicyReceipt } from "./types.js";
import { accessScopeSchema } from "./types.js";

interface PolicyRule {
  readonly id: string;
  readonly matches: (scope: AccessScope) => boolean;
}

/** Clinical resource types a clinician may read for treatment in v0. */
const CLINICAL_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Patient",
  "Encounter",
  "Condition",
  "Observation",
  "MedicationRequest",
  "AllergyIntolerance",
  "Procedure",
  "DocumentReference"
]);

/**
 * The one v0 allow rule: a clinician, acting for TREAT, reading a clinical
 * resource whose practice matches the subject AND the request practice. All
 * three practice ids must agree — a cross-practice request never matches.
 */
function clinicianTreatMatches(scope: AccessScope): boolean {
  return (
    scope.subject.role === "clinician" &&
    scope.purposeOfUse === "TREAT" &&
    scope.subject.practiceId === scope.requestPracticeId &&
    scope.resource.practiceId === scope.requestPracticeId &&
    CLINICAL_RESOURCE_TYPES.has(scope.resource.resourceType)
  );
}

const V0_ALLOW_RULES: readonly PolicyRule[] = [
  { id: "v0-clinician-treat", matches: clinicianTreatMatches }
];

/**
 * No forbid rules ship in v0, but the deny-wins evaluation slot is kept so
 * BF-06 can add explicit prohibitions without reshaping the decision flow.
 */
const V0_FORBID_RULES: readonly PolicyRule[] = [];

const MALFORMED_REASON = "deny: malformed access scope";

/** Exhaustive, default-free mapping of an outcome to a human-readable reason. */
function decisionReason(decision: Decision, ruleId: string | null): string {
  switch (decision) {
    case "allow":
      return `allow: matched rule ${ruleId ?? "unknown"}`;
    case "deny":
      return ruleId === null ? "deny: no matching allow rule" : `deny: forbidden by rule ${ruleId}`;
  }
}

function receiptFor(
  scope: AccessScope,
  decision: Decision,
  ruleId: string | null,
  now: () => string
): PolicyReceipt {
  return {
    decision,
    actorId: scope.subject.id,
    resourceType: scope.resource.resourceType,
    practiceId: scope.requestPracticeId,
    purposeOfUse: scope.purposeOfUse,
    matchedRuleId: ruleId,
    reason: decisionReason(decision, ruleId),
    timestamp: now()
  };
}

function denyMalformed(now: () => string): PolicyReceipt {
  return {
    decision: "deny",
    actorId: "unknown",
    resourceType: "unknown",
    practiceId: "unknown",
    purposeOfUse: "unknown",
    matchedRuleId: null,
    reason: MALFORMED_REASON,
    timestamp: now()
  };
}

/**
 * Evaluate an access request. `input` is untrusted (parsed here); `now` supplies
 * the receipt timestamp (injected so decisions are deterministic under test).
 */
export function decide(input: unknown, now: () => string): PolicyReceipt {
  const parsed = accessScopeSchema.safeParse(input);
  if (!parsed.success) return denyMalformed(now);
  const scope = parsed.data;
  try {
    const forbidden = V0_FORBID_RULES.find((rule) => rule.matches(scope));
    if (forbidden !== undefined) return receiptFor(scope, "deny", forbidden.id, now);
    const permitted = V0_ALLOW_RULES.find((rule) => rule.matches(scope));
    const decision: Decision = permitted === undefined ? "deny" : "allow";
    return receiptFor(scope, decision, permitted?.id ?? null, now);
  } catch {
    // Totality guarantee: any rule-evaluation error resolves to DENY with a
    // receipt (never a throw-to-caller a read path could mistake for allow).
    // v0 matchers are pure comparisons and cannot throw; this defends the
    // invariant for future rules.
    return receiptFor(scope, "deny", null, now);
  }
}
