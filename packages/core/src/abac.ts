import { AppendOnlyAuditLedger, type AuditDecision, type AuditEvent } from "./audit.js";

export type BonfireActorRole = "clinician" | "agent" | "auditor" | "patient";
export type BonfirePolicyDecision = AuditDecision;

export interface PolicyActor {
  id: string;
  practiceId: string;
  role: BonfireActorRole;
}

export interface PolicyPatient {
  id: string;
  practiceId: string;
}

export interface PolicyRosterEntry {
  practiceId: string;
  actorId: string;
  patientId: string;
  relationship: string;
}

export interface PolicyConsent {
  practiceId: string;
  patientId: string;
  scope: string;
  status: "active" | "revoked";
}

export interface PolicyPatientActorLink {
  practiceId: string;
  actorId: string;
  patientId: string;
  relationship: "self";
  status: "active" | "revoked";
}

export interface PolicyCheck {
  name:
    | "clinician_role"
    | "same_practice"
    | "roster_membership"
    | "active_consent"
    | "patient_role"
    | "patient_actor_link"
    | "own_patient_record"
    | "patient_scope";
  passed: boolean;
}

export interface PolicyReceipt {
  policy: "bonfire.v0.patient-read";
  action: "patient.read";
  decision: BonfirePolicyDecision;
  actorId: string;
  patientId: string;
  practiceId: string;
  actorPracticeId: string;
  patientPracticeId: string;
  scope: string;
  checks: PolicyCheck[];
  reason: string;
}

export interface EvaluatePatientReadPolicyInput {
  actor: PolicyActor;
  patient: PolicyPatient;
  roster: readonly PolicyRosterEntry[];
  consents: readonly PolicyConsent[];
  patientActorLinks?: readonly PolicyPatientActorLink[];
  scope?: string;
}

export interface ReadPatientWithPolicyInput<TPatient extends PolicyPatient> extends EvaluatePatientReadPolicyInput {
  patient: TPatient;
  audit: AppendOnlyAuditLedger;
}

export interface PolicyReadResult<TPatient extends PolicyPatient> {
  patient: TPatient;
  receipt: PolicyReceipt;
  auditEvent: AuditEvent;
}

export class BonfireAccessDenied extends Error {
  readonly code = "BONFIRE_ACCESS_DENIED";
  readonly receipt: PolicyReceipt;

  constructor(receipt: PolicyReceipt) {
    super(`BonfireAccessDenied: ${receipt.reason}`);
    this.name = "BonfireAccessDenied";
    this.receipt = receipt;
  }
}

function hasRosterMembership(input: Required<Pick<EvaluatePatientReadPolicyInput, "actor" | "patient" | "roster">>): boolean {
  return input.roster.some((entry) =>
    entry.practiceId === input.actor.practiceId &&
    entry.actorId === input.actor.id &&
    entry.patientId === input.patient.id
  );
}

function hasActiveConsent(input: Required<Pick<EvaluatePatientReadPolicyInput, "patient" | "consents" | "scope">>): boolean {
  return input.consents.some((consent) =>
    consent.practiceId === input.patient.practiceId &&
    consent.patientId === input.patient.id &&
    consent.scope === input.scope &&
    consent.status === "active"
  );
}

function activeSelfPatientLinks(input: Pick<EvaluatePatientReadPolicyInput, "actor" | "patientActorLinks">): PolicyPatientActorLink[] {
  return (input.patientActorLinks ?? []).filter((link) =>
    link.practiceId === input.actor.practiceId &&
    link.actorId === input.actor.id &&
    link.relationship === "self" &&
    link.status === "active"
  );
}

function isPatientReadScope(scope: string): boolean {
  return scope === "patient-portal-read";
}

function receiptReason(checks: readonly PolicyCheck[]): string {
  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  return failed.length === 0 ? "all_policy_checks_passed" : `policy_denied:${failed.join(",")}`;
}

function defaultScopeForActor(actor: PolicyActor): string {
  return actor.role === "patient" ? "patient-portal-read" : "demo-treatment";
}

function clinicianChecks(input: EvaluatePatientReadPolicyInput, scope: string): PolicyCheck[] {
  return [
    {
      name: "clinician_role",
      passed: input.actor.role === "clinician"
    },
    {
      name: "same_practice",
      passed: input.actor.practiceId === input.patient.practiceId
    },
    {
      name: "roster_membership",
      passed: hasRosterMembership({ actor: input.actor, patient: input.patient, roster: input.roster })
    },
    {
      name: "active_consent",
      passed: hasActiveConsent({ patient: input.patient, consents: input.consents, scope })
    }
  ];
}

function patientChecks(input: EvaluatePatientReadPolicyInput, scope: string): PolicyCheck[] {
  const activeSelfLinks = activeSelfPatientLinks(input);
  const selfLink = activeSelfLinks.length === 1 ? activeSelfLinks[0] : undefined;

  return [
    {
      name: "patient_role",
      passed: input.actor.role === "patient"
    },
    {
      name: "same_practice",
      passed: input.actor.practiceId === input.patient.practiceId
    },
    {
      name: "patient_actor_link",
      passed: activeSelfLinks.length === 1
    },
    {
      name: "own_patient_record",
      passed: selfLink !== undefined &&
        selfLink.practiceId === input.patient.practiceId &&
        selfLink.patientId === input.patient.id
    },
    {
      name: "patient_scope",
      passed: isPatientReadScope(scope)
    }
  ];
}

export function evaluatePatientReadPolicy(input: EvaluatePatientReadPolicyInput): PolicyReceipt {
  const scope = input.scope ?? defaultScopeForActor(input.actor);
  const checks = input.actor.role === "patient" ? patientChecks(input, scope) : clinicianChecks(input, scope);
  const decision: BonfirePolicyDecision = checks.every((check) => check.passed) ? "allow" : "deny";

  return {
    policy: "bonfire.v0.patient-read",
    action: "patient.read",
    decision,
    actorId: input.actor.id,
    patientId: input.patient.id,
    practiceId: input.actor.practiceId,
    actorPracticeId: input.actor.practiceId,
    patientPracticeId: input.patient.practiceId,
    scope,
    checks,
    reason: receiptReason(checks)
  };
}

function appendPolicyAudit(
  audit: AppendOnlyAuditLedger,
  receipt: PolicyReceipt
): AuditEvent {
  return audit.append({
    practiceId: receipt.practiceId,
    actorId: receipt.actorId,
    action: receipt.action,
    targetType: "patient",
    targetId: receipt.patientId,
    decision: receipt.decision,
    reason: receipt.reason,
    receipt
  });
}

export function readPatientWithPolicy<TPatient extends PolicyPatient>(
  input: ReadPatientWithPolicyInput<TPatient>
): PolicyReadResult<TPatient> {
  const receipt = evaluatePatientReadPolicy(input);
  const auditEvent = appendPolicyAudit(input.audit, receipt);

  if (receipt.decision === "deny") {
    throw new BonfireAccessDenied(receipt);
  }

  return {
    patient: input.patient,
    receipt,
    auditEvent
  };
}

export function readablePatients<TPatient extends PolicyPatient>(
  actor: PolicyActor,
  patients: readonly TPatient[],
  roster: readonly PolicyRosterEntry[],
  consents: readonly PolicyConsent[],
  scope?: string,
  patientActorLinks: readonly PolicyPatientActorLink[] = []
): TPatient[] {
  const resolvedScope = scope ?? defaultScopeForActor(actor);

  return patients.filter((patient) =>
    evaluatePatientReadPolicy({ actor, patient, roster, consents, scope: resolvedScope, patientActorLinks }).decision === "allow"
  );
}
