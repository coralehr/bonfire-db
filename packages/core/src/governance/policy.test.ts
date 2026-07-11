/**
 * Pure governance policy battery (dangerChecks: propose-only-broken,
 * fail-open-authz). No database: the full transition grid (acceptance #1),
 * the default-deny authority decision (acceptance #2/#3/#4), and the
 * signed-note boundary schema (acceptance #7). Every malformed, unknown-role,
 * cross-practice, or hostile input must resolve to a deny RECEIPT — never a
 * throw, never an allow-by-error.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { GovernanceState, PolicyReceipt } from "../index.js";
import {
  decideGovernance,
  GOVERNANCE_ROLES,
  GOVERNANCE_STATES,
  signedNoteSchema,
  transition
} from "../index.js";

const FIXED_NOW = "2026-07-11T09:00:00.000Z";
const clock = (): string => FIXED_NOW;
const BOUND_PRACTICE = randomUUID();

const ADVANCE_ACTIONS = ["approve", "commit", "reject"] as const;

/** The complete legal edge set; every other state x action pair must reject. */
const LEGAL_EDGES: ReadonlyMap<string, GovernanceState> = new Map([
  ["proposed>approve", "approved"],
  ["proposed>reject", "rejected"],
  ["approved>commit", "committed"]
]);

describe("transition: the full 12-combo state x action grid (acceptance #1)", () => {
  test("grid dimensions: 4 states x 3 actions, exactly 3 legal edges", () => {
    expect(GOVERNANCE_STATES.length * ADVANCE_ACTIONS.length).toBe(12);
    expect(LEGAL_EDGES.size).toBe(3);
  });

  for (const state of GOVERNANCE_STATES) {
    for (const action of ADVANCE_ACTIONS) {
      const target = LEGAL_EDGES.get(`${state}>${action}`);
      if (target === undefined) {
        test(`${state} + ${action} rejects with GOVERNANCE_INVALID_TRANSITION`, () => {
          const result = transition(state, action);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe("GOVERNANCE_INVALID_TRANSITION");
            expect(result.error.message).toContain(state);
            expect(result.error.message).toContain(action);
          }
        });
      } else {
        test(`${state} + ${action} advances to ${target}`, () => {
          const result = transition(state, action);
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.data).toBe(target);
        });
      }
    }
  }

  test("committed is terminal: no action leaves it (a proposal can never re-open)", () => {
    for (const action of ADVANCE_ACTIONS) {
      expect(transition("committed", action).ok).toBe(false);
    }
  });
});

function requestBy(role: string, action: string, actorPractice: string = BOUND_PRACTICE): unknown {
  return {
    actor: { id: `${role}-77`, role, practiceId: actorPractice },
    action,
    boundPracticeId: BOUND_PRACTICE
  };
}

function expectDeny(receipt: PolicyReceipt): void {
  expect(receipt.decision).toBe("deny");
  expect(receipt.matchedRuleId).toBeNull();
  expect(receipt.reason.length).toBeGreaterThan(0);
}

describe("decideGovernance: DEFAULT-DENY for approve/commit/reject (acceptance #2)", () => {
  const NON_CLINICIANS = ["agent", "biller", "operations", "researcher"] as const;

  for (const role of NON_CLINICIANS) {
    for (const action of ["approve", "commit", "reject"]) {
      test(`${role} ${action} -> deny, attributed to the actor`, () => {
        const receipt = decideGovernance(requestBy(role, action), clock);
        expectDeny(receipt);
        expect(receipt.actorId).toBe(`${role}-77`);
        expect(receipt.resourceType).toBe(`Governance.${action}`);
        expect(receipt.practiceId).toBe(BOUND_PRACTICE);
        expect(receipt.timestamp).toBe(FIXED_NOW);
      });
    }
  }

  test("an unknown role denies with sentinel attribution (parse failure, no salvage)", () => {
    const receipt = decideGovernance(requestBy("superadmin", "approve"), clock);
    expectDeny(receipt);
    expect(receipt.actorId).toBe("unknown");
    expect(receipt.practiceId).toBe("unknown");
    expect(receipt.purposeOfUse).toBe("unknown");
  });

  test.each([[null], [{}], ["approve"], [42]])("malformed input %p denies", (input) => {
    const receipt = decideGovernance(input, clock);
    expectDeny(receipt);
    expect(receipt.actorId).toBe("unknown");
    expect(receipt.resourceType).toBe("unknown");
  });

  test("a clinician from ANOTHER practice is denied approve (practice mismatch)", () => {
    const receipt = decideGovernance(requestBy("clinician", "approve", randomUUID()), clock);
    expectDeny(receipt);
    expect(receipt.actorId).toBe("clinician-77");
    // The receipt stays bound to the GUC practice, never the actor's claim.
    expect(receipt.practiceId).toBe(BOUND_PRACTICE);
  });

  test("a HOSTILE actor whose getter throws yields a deny receipt, never a throw", () => {
    const hostile = {
      actor: {
        id: "spy-1",
        role: "clinician",
        get practiceId(): string {
          throw new Error("hostile getter");
        }
      },
      action: "approve",
      boundPracticeId: BOUND_PRACTICE
    };
    const receipt = decideGovernance(hostile, clock);
    expectDeny(receipt);
    expect(receipt.actorId).toBe("unknown");
  });
});

describe("decideGovernance: the allow rules (acceptance #3/#4)", () => {
  test("clinician approve for the bound practice -> structured allow", () => {
    const receipt = decideGovernance(requestBy("clinician", "approve"), clock);
    expect(receipt.decision).toBe("allow");
    expect(receipt.matchedRuleId).toBe("bf09-approve-clinician");
    expect(receipt.resourceType).toBe("Governance.approve");
    expect(receipt.actorId).toBe("clinician-77");
    expect(receipt.practiceId).toBe(BOUND_PRACTICE);
    expect(receipt.purposeOfUse).toBe("TREAT");
  });

  test("clinician commit and reject also allow (clinician owns every advance)", () => {
    expect(decideGovernance(requestBy("clinician", "commit"), clock).matchedRuleId).toBe(
      "bf09-commit-clinician"
    );
    expect(decideGovernance(requestBy("clinician", "reject"), clock).matchedRuleId).toBe(
      "bf09-reject-clinician"
    );
  });

  for (const role of GOVERNANCE_ROLES) {
    test(`${role} may propose for its own practice (propose is open to every role)`, () => {
      const receipt = decideGovernance(requestBy(role, "propose"), clock);
      expect(receipt.decision).toBe("allow");
      expect(receipt.matchedRuleId).toBe("bf09-propose-any-role");
      expect(receipt.resourceType).toBe("Governance.propose");
    });
  }

  test("propose for a FOREIGN practice denies even for a clinician", () => {
    expectDeny(decideGovernance(requestBy("clinician", "propose", randomUUID()), clock));
  });

  test("the default clock emits an ISO-8601 ms UTC timestamp (audit-appendable)", () => {
    const receipt = decideGovernance(requestBy("agent", "propose"));
    expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("signedNoteSchema (acceptance #7)", () => {
  function goldenNote(): Record<string, unknown> {
    return {
      proposalId: randomUUID(),
      resource: { resourceType: "Patient", resourceId: randomUUID(), versionId: "1" },
      approverActorId: "clinician-77",
      approvedAt: "2026-07-11 09:00:00.000+00",
      committerActorId: "clinician-88",
      signedAt: FIXED_NOW,
      // Built at runtime on purpose; a literal 64-hex string reads as a secret.
      commitAuditHash: "ab".repeat(32)
    };
  }

  test("a golden committed record validates", () => {
    const parsed = signedNoteSchema.safeParse(goldenNote());
    expect(parsed.success).toBe(true);
  });

  test("a record missing the approver identity is rejected", () => {
    const { approverActorId: _dropped, ...note } = goldenNote();
    expect(signedNoteSchema.safeParse(note).success).toBe(false);
    expect(signedNoteSchema.safeParse({ ...note, approverActorId: "" }).success).toBe(false);
  });

  test("a record missing or corrupting the signature hash is rejected", () => {
    const { commitAuditHash: _dropped, ...note } = goldenNote();
    expect(signedNoteSchema.safeParse(note).success).toBe(false);
    expect(signedNoteSchema.safeParse({ ...note, commitAuditHash: "not-hex" }).success).toBe(false);
    expect(signedNoteSchema.safeParse({ ...note, commitAuditHash: "ab".repeat(16) }).success).toBe(
      false
    );
  });
});
