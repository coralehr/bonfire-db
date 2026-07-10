/**
 * Pure governance policy (BF-09): the state machine + the TOTAL default-deny
 * authority decision. Neither function touches a database; `decideGovernance`
 * is decided from the request alone and NEVER throws — malformed input, an
 * unknown role, or a hostile object whose getter throws all resolve to a deny
 * receipt (fail-closed), so an error can never be read as allow.
 */
import { z } from "zod";
import type { PolicyReceipt } from "../abac/types.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import type { GovernanceAction, GovernanceError, GovernanceState } from "./types.js";
import { GOVERNANCE_ACTIONS, governanceActorSchema } from "./types.js";

/**
 * Advance the state machine. The ONLY legal edges are proposed+approve →
 * approved, approved+commit → committed, and proposed+reject → rejected;
 * every other state/action pair is a typed GOVERNANCE_INVALID_TRANSITION.
 * The switch is exhaustive over the state union with no default, so adding a
 * state fails compilation until its edges are decided.
 */
export function transition(
  state: GovernanceState,
  action: Exclude<GovernanceAction, "propose">
): Result<GovernanceState, GovernanceError> {
  switch (state) {
    case "proposed": {
      if (action === "approve") return ok("approved");
      if (action === "reject") return ok("rejected");
      return illegalTransition(state, action);
    }
    case "approved":
      return action === "commit" ? ok("committed") : illegalTransition(state, action);
    case "committed":
    case "rejected":
      return illegalTransition(state, action);
  }
}

function illegalTransition(
  state: GovernanceState,
  action: Exclude<GovernanceAction, "propose">
): Result<never, GovernanceError> {
  return err({
    code: "GOVERNANCE_INVALID_TRANSITION",
    message: `governance action ${action} is illegal from state ${state}`
  });
}

/** The one untrusted boundary of the governance decision (parse, don't validate). */
const governanceDecisionSchema = z.object({
  actor: governanceActorSchema,
  action: z.enum(GOVERNANCE_ACTIONS),
  boundPracticeId: z.uuid()
});

/** Spread base for the malformed/thrown outcome: every field a deny sentinel. */
const UNKNOWN_DENY = {
  decision: "deny",
  actorId: "unknown",
  resourceType: "unknown",
  practiceId: "unknown",
  purposeOfUse: "unknown",
  matchedRuleId: null,
  reason: "deny: malformed governance request"
} as const;

/**
 * Decide one governance attempt. `boundPracticeId` is the tenant GUC value the
 * calling transaction is bound to (never caller input), so the receipt's
 * practice always matches the audit chain it lands on. Rules: any parsed
 * governance role may `propose` for its own practice; `approve`/`commit`/
 * `reject` require role clinician AND a practice match; everything else —
 * including a parse failure or a thrown getter — is deny.
 */
export function decideGovernance(
  input: unknown,
  now: () => string = () => new Date().toISOString()
): PolicyReceipt {
  try {
    const parsed = governanceDecisionSchema.safeParse(input);
    if (!parsed.success) return { ...UNKNOWN_DENY, timestamp: now() };
    const { actor, action, boundPracticeId } = parsed.data;
    let matchedRuleId: string | null = null;
    // A practice mismatch matches NO rule for any action — default-deny.
    if (actor.practiceId === boundPracticeId) {
      switch (action) {
        case "propose":
          matchedRuleId = "bf09-propose-any-role";
          break;
        case "approve":
        case "commit":
        case "reject":
          if (actor.role === "clinician") matchedRuleId = `bf09-${action}-clinician`;
          break;
      }
    }
    const decision = matchedRuleId === null ? ("deny" as const) : ("allow" as const);
    return {
      decision,
      actorId: actor.id,
      resourceType: `Governance.${action}`,
      practiceId: boundPracticeId,
      purposeOfUse: "TREAT",
      matchedRuleId,
      reason: `${decision}: governance ${action} by role ${actor.role}, rule ${matchedRuleId ?? "none"}`,
      timestamp: now()
    };
  } catch {
    // Totality: a hostile input (e.g. a property getter that throws mid-parse)
    // must yield a deny RECEIPT, never a throw a caller could read as allow.
    return { ...UNKNOWN_DENY, timestamp: now() };
  }
}
