/**
 * TRACER A — the fail-open trap matrix (dangerChecks: fail-open-authz,
 * scope-after-retrieve). Pure, no DB: proves default-deny + scope-before-retrieve
 * structurally. Every non-matching, malformed, or garbage input must resolve to
 * a deny receipt — never a throw, never undefined-as-allow.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { decide } from "./decide.js";
import type { AccessScope } from "./types.js";

const FIXED_NOW = "2026-07-06T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const PRACTICE = randomUUID();
const OTHER_PRACTICE = randomUUID();
const ACTOR = "clinician-abc";

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    subject: { id: ACTOR, role: "clinician", practiceId: PRACTICE },
    resource: { resourceType: "Observation", practiceId: PRACTICE },
    purposeOfUse: "TREAT",
    requestPracticeId: PRACTICE,
    ...overrides
  };
}

describe("decide — structural (scope-before-retrieve)", () => {
  test("decide takes scope + clock ONLY (no sql/row parameter)", () => {
    expect(decide.length).toBe(2);
  });
});

describe("decide — the one allow", () => {
  test("clinician + TREAT + same-practice + clinical type → allow with matched rule", () => {
    const receipt = decide(scope(), now);
    expect(receipt.decision).toBe("allow");
    expect(receipt.matchedRuleId).toBe("v0-clinician-treat");
    expect(receipt.purposeOfUse).toBe("TREAT");
    expect(receipt.actorId).toBe(ACTOR);
    expect(receipt.resourceType).toBe("Observation");
    expect(receipt.practiceId).toBe(PRACTICE);
    expect(receipt.timestamp).toBe(FIXED_NOW);
    expect(receipt.reason).toContain("allow");
  });

  test("the purposeOfUse used in the decision is the value on the receipt", () => {
    // A valid non-allow purpose is preserved verbatim (no divergence), and is
    // not silently rewritten to the sentinel.
    const receipt = decide(scope({ purposeOfUse: "HPAYMT" }), now);
    expect(receipt.purposeOfUse).toBe("HPAYMT");
    expect(receipt.decision).toBe("deny");
  });
});

describe("decide — default-deny fail-closed matrix", () => {
  test("empty {} scope → deny with sentinel receipt (never throw)", () => {
    const receipt = decide({}, now);
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
    expect(receipt.matchedRuleId).toBeNull();
    expect(receipt.reason).toBe("deny: malformed access scope");
  });

  test("null / non-object garbage → deny with sentinel receipt", () => {
    for (const bad of [null, undefined, 42, "nope", []]) {
      const receipt = decide(bad, now);
      expect(receipt.decision).toBe("deny");
      expect(receipt.purposeOfUse).toBe("unknown");
    }
  });

  test("unrecognized actor role → deny (Zod boundary rejects, no throw-to-allow)", () => {
    const receipt = decide(
      { ...scope(), subject: { id: ACTOR, role: "intruder", practiceId: PRACTICE } },
      now
    );
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
    expect(receipt.matchedRuleId).toBeNull();
  });

  test("missing purpose-of-use → deny (unparseable) with sentinel purpose", () => {
    const { purposeOfUse: _omit, ...noPurpose } = scope();
    const receipt = decide(noPurpose, now);
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
  });

  test("unrecognized purpose-of-use → deny with sentinel purpose", () => {
    const receipt = decide({ ...scope(), purposeOfUse: "BILLING" }, now);
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
  });

  test("empty-string purpose-of-use → deny with sentinel purpose", () => {
    const receipt = decide({ ...scope(), purposeOfUse: "" }, now);
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
  });

  test("ETREAT (break-glass) → deny, parsed (not sentinel) and not grantable in v0", () => {
    const receipt = decide(scope({ purposeOfUse: "ETREAT" }), now);
    expect(receipt.decision).toBe("deny");
    // ETREAT is a valid enum value, so it is recorded as-is — not "unknown".
    expect(receipt.purposeOfUse).toBe("ETREAT");
    expect(receipt.matchedRuleId).toBeNull();
    expect(receipt.reason).toBe("deny: no matching allow rule");
  });

  test("every deferred purpose-of-use denies even for a clinician (only TREAT allows in v0)", () => {
    for (const purposeOfUse of ["HPAYMT", "HOPERAT", "HRESCH"] as const) {
      const receipt = decide(scope({ purposeOfUse }), now);
      expect(receipt.decision).toBe("deny");
      expect(receipt.purposeOfUse).toBe(purposeOfUse);
      expect(receipt.matchedRuleId).toBeNull();
    }
  });

  test("non-clinician roles deny even with TREAT + matching practice", () => {
    for (const role of ["biller", "operations", "researcher"] as const) {
      const receipt = decide(scope({ subject: { id: ACTOR, role, practiceId: PRACTICE } }), now);
      expect(receipt.decision).toBe("deny");
    }
  });

  test("practice mismatch (resource in another practice) → deny", () => {
    const receipt = decide(
      scope({ resource: { resourceType: "Observation", practiceId: OTHER_PRACTICE } }),
      now
    );
    expect(receipt.decision).toBe("deny");
    expect(receipt.matchedRuleId).toBeNull();
  });

  test("subject practice != request practice → deny", () => {
    const receipt = decide(
      scope({ subject: { id: ACTOR, role: "clinician", practiceId: OTHER_PRACTICE } }),
      now
    );
    expect(receipt.decision).toBe("deny");
  });

  test("clinician + non-TREAT purpose (HPAYMT) → deny", () => {
    expect(decide(scope({ purposeOfUse: "HPAYMT" }), now).decision).toBe("deny");
  });

  test("biller + TREAT → deny (role is not clinician)", () => {
    const receipt = decide(
      scope({ subject: { id: "biller-1", role: "biller", practiceId: PRACTICE } }),
      now
    );
    expect(receipt.decision).toBe("deny");
  });

  test("researcher reading clinical for HRESCH → deny (no allow rule matches)", () => {
    const receipt = decide(
      scope({
        subject: { id: "res-1", role: "researcher", practiceId: PRACTICE },
        purposeOfUse: "HRESCH"
      }),
      now
    );
    expect(receipt.decision).toBe("deny");
  });

  test("clinician + TREAT but non-clinical resource type → deny", () => {
    const receipt = decide(
      scope({ resource: { resourceType: "Organization", practiceId: PRACTICE } }),
      now
    );
    expect(receipt.decision).toBe("deny");
  });
});
