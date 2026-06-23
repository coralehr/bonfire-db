import { describe, expect, test } from "bun:test";
import {
  AppendOnlyAuditLedger,
  BonfireAccessDenied,
  evaluatePatientReadPolicy,
  readablePatients,
  readPatientWithPolicy
} from "./index";

const practiceOne = "11111111-1111-4111-8111-111111111111";
const practiceTwo = "99999999-9999-4999-8999-999999999999";

const clinicianOne = {
  id: "22222222-2222-4222-8222-222222222201",
  practiceId: practiceOne,
  role: "clinician" as const
};

const wrongClinician = {
  id: "22222222-2222-4222-8222-222222222299",
  practiceId: practiceTwo,
  role: "clinician" as const
};

const agentActor = {
  id: "22222222-2222-4222-8222-222222222202",
  practiceId: practiceOne,
  role: "agent" as const
};

const patientActor = {
  id: "22222222-2222-4222-8222-222222222203",
  practiceId: practiceOne,
  role: "patient" as const
};

const allowedPatient = {
  id: "33333333-3333-4333-8333-333333333301",
  practiceId: practiceOne,
  displayName: "Synthetic Patient Ember"
};

const unrosteredPatient = {
  id: "33333333-3333-4333-8333-333333333302",
  practiceId: practiceOne,
  displayName: "Synthetic Patient Harbor"
};

const otherPracticePatient = {
  id: "33333333-3333-4333-8333-333333333303",
  practiceId: practiceTwo,
  displayName: "Synthetic Patient Cedar"
};

const roster = [
  {
    practiceId: practiceOne,
    actorId: clinicianOne.id,
    patientId: allowedPatient.id,
    relationship: "primary_clinician"
  }
] as const;

const consents = [
  {
    practiceId: practiceOne,
    patientId: allowedPatient.id,
    scope: "demo-treatment",
    status: "active" as const
  },
  {
    practiceId: practiceOne,
    patientId: unrosteredPatient.id,
    scope: "demo-treatment",
    status: "active" as const
  },
  {
    practiceId: practiceTwo,
    patientId: otherPracticePatient.id,
    scope: "demo-treatment",
    status: "active" as const
  }
] as const;

const patientActorLinks = [
  {
    practiceId: practiceOne,
    actorId: patientActor.id,
    patientId: allowedPatient.id,
    relationship: "self" as const,
    status: "active" as const
  }
] as const;

describe("abac patient read policy", () => {
  test("allowed clinician can read only patients in their practice, roster, and active consent scope", () => {
    expect(readablePatients(clinicianOne, [allowedPatient, unrosteredPatient, otherPracticePatient], roster, consents))
      .toEqual([allowedPatient]);

    const receipt = evaluatePatientReadPolicy({
      actor: clinicianOne,
      patient: allowedPatient,
      roster,
      consents
    });

    expect(receipt.decision).toBe("allow");
    expect(receipt.reason).toBe("all_policy_checks_passed");
    expect(receipt.actorPracticeId).toBe(practiceOne);
    expect(receipt.patientPracticeId).toBe(practiceOne);
    expect(receipt.checks.every((check) => check.passed)).toBe(true);
  });

  test("wrong clinician receives BonfireAccessDenied with a policy receipt", () => {
    const audit = new AppendOnlyAuditLedger();

    expect(() => readPatientWithPolicy({
      actor: wrongClinician,
      patient: allowedPatient,
      roster,
      consents,
      audit
    })).toThrow(BonfireAccessDenied);

    const event = audit.list()[0];
    expect(event?.decision).toBe("deny");
    expect(event?.reason).toContain("same_practice");
    expect(event?.reason).toContain("roster_membership");
    expect((event?.receipt as { actorPracticeId?: string; patientPracticeId?: string }).actorPracticeId).toBe(practiceTwo);
    expect((event?.receipt as { actorPracticeId?: string; patientPracticeId?: string }).patientPracticeId).toBe(practiceOne);
  });

  test("non-clinician actor is denied even when practice, roster, and consent would otherwise match", () => {
    const receipt = evaluatePatientReadPolicy({
      actor: agentActor,
      patient: allowedPatient,
      roster: [
        ...roster,
        {
          practiceId: practiceOne,
          actorId: agentActor.id,
          patientId: allowedPatient.id,
          relationship: "local_agent"
        }
      ],
      consents
    });

    expect(receipt.decision).toBe("deny");
    expect(receipt.reason).toContain("clinician_role");
  });

  test("patient actor can read only their own active self-linked patient record", () => {
    expect(readablePatients(
      patientActor,
      [allowedPatient, unrosteredPatient, otherPracticePatient],
      roster,
      consents,
      undefined,
      patientActorLinks
    )).toEqual([allowedPatient]);

    const receipt = evaluatePatientReadPolicy({
      actor: patientActor,
      patient: allowedPatient,
      roster,
      consents,
      patientActorLinks
    });

    expect(receipt.decision).toBe("allow");
    expect(receipt.scope).toBe("patient-portal-read");
    expect(receipt.checks.map((check) => check.name)).toEqual([
      "patient_role",
      "same_practice",
      "patient_actor_link",
      "own_patient_record",
      "patient_scope"
    ]);
    expect(receipt.checks.every((check) => check.passed)).toBe(true);
  });

  test("patient actor is denied when requesting any patient other than their self-linked record", () => {
    const receipt = evaluatePatientReadPolicy({
      actor: patientActor,
      patient: unrosteredPatient,
      roster,
      consents,
      patientActorLinks
    });

    expect(receipt.decision).toBe("deny");
    expect(receipt.reason).toContain("own_patient_record");
  });

  test("patient actor is denied when their self-link is revoked or ambiguous", () => {
    const revokedReceipt = evaluatePatientReadPolicy({
      actor: patientActor,
      patient: allowedPatient,
      roster,
      consents,
      patientActorLinks: [
        {
          ...patientActorLinks[0],
          status: "revoked" as const
        }
      ]
    });

    const ambiguousReceipt = evaluatePatientReadPolicy({
      actor: patientActor,
      patient: allowedPatient,
      roster,
      consents,
      patientActorLinks: [
        ...patientActorLinks,
        {
          practiceId: practiceOne,
          actorId: patientActor.id,
          patientId: unrosteredPatient.id,
          relationship: "self" as const,
          status: "active" as const
        }
      ]
    });

    expect(revokedReceipt.decision).toBe("deny");
    expect(revokedReceipt.reason).toContain("patient_actor_link");
    expect(ambiguousReceipt.decision).toBe("deny");
    expect(ambiguousReceipt.reason).toContain("patient_actor_link");
  });

  test("patient actor cannot reuse clinician treatment scope to read records", () => {
    const receipt = evaluatePatientReadPolicy({
      actor: patientActor,
      patient: allowedPatient,
      roster,
      consents,
      patientActorLinks,
      scope: "demo-treatment"
    });

    expect(receipt.decision).toBe("deny");
    expect(receipt.reason).toContain("patient_scope");
  });

  test("allow and deny paths append audit events", () => {
    const audit = new AppendOnlyAuditLedger();

    const result = readPatientWithPolicy({
      actor: clinicianOne,
      patient: allowedPatient,
      roster,
      consents,
      audit
    });
    expect(result.auditEvent.decision).toBe("allow");

    try {
      readPatientWithPolicy({
        actor: clinicianOne,
        patient: unrosteredPatient,
        roster,
        consents,
        audit
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BonfireAccessDenied);
    }

    expect(audit.list().map((event) => event.decision)).toEqual(["allow", "deny"]);
  });

  test("patient actor allow and deny paths append audit receipts", () => {
    const audit = new AppendOnlyAuditLedger();

    readPatientWithPolicy({
      actor: patientActor,
      patient: allowedPatient,
      roster,
      consents,
      patientActorLinks,
      audit
    });

    try {
      readPatientWithPolicy({
        actor: patientActor,
        patient: unrosteredPatient,
        roster,
        consents,
        patientActorLinks,
        audit
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BonfireAccessDenied);
    }

    const events = audit.list();
    expect(events.map((event) => event.decision)).toEqual(["allow", "deny"]);
    expect(events[1]?.reason).toContain("own_patient_record");
  });
});
