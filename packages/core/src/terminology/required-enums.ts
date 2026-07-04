/**
 * Small `required`-strength FHIR value sets. These are the only bindings the
 * write path REJECTS on: they are closed, tiny, and license-clean (HL7 base
 * code systems), so an invalid member is a hard fail-closed error — never a
 * data-quality warning. Authored as `as const` tuples so scribe schemas can
 * `z.enum` them at the boundary and the terminology validator can re-check.
 */

/** http://hl7.org/fhir/administrative-gender (Patient.gender). */
export const ADMINISTRATIVE_GENDER = ["male", "female", "other", "unknown"] as const;

/** http://hl7.org/fhir/encounter-status (Encounter.status). */
export const ENCOUNTER_STATUS = [
  "planned",
  "arrived",
  "triaged",
  "in-progress",
  "onleave",
  "finished",
  "cancelled",
  "entered-in-error",
  "unknown"
] as const;

/** http://terminology.hl7.org/CodeSystem/condition-clinical (Condition.clinicalStatus). */
export const CONDITION_CLINICAL_STATUS = [
  "active",
  "recurrence",
  "relapse",
  "inactive",
  "remission",
  "resolved"
] as const;

/** http://terminology.hl7.org/CodeSystem/condition-ver-status (Condition.verificationStatus). */
export const CONDITION_VERIFICATION_STATUS = [
  "unconfirmed",
  "provisional",
  "differential",
  "confirmed",
  "refuted",
  "entered-in-error"
] as const;

/** http://hl7.org/fhir/observation-status (Observation.status). */
export const OBSERVATION_STATUS = [
  "registered",
  "preliminary",
  "final",
  "amended",
  "corrected",
  "cancelled",
  "entered-in-error",
  "unknown"
] as const;

/** http://hl7.org/fhir/CodeSystem/medicationrequest-status (MedicationRequest.status). */
export const MEDICATION_REQUEST_STATUS = [
  "active",
  "on-hold",
  "cancelled",
  "completed",
  "entered-in-error",
  "stopped",
  "draft",
  "unknown"
] as const;

/** http://hl7.org/fhir/CodeSystem/medicationrequest-intent (MedicationRequest.intent). */
export const MEDICATION_REQUEST_INTENT = [
  "proposal",
  "plan",
  "order",
  "original-order",
  "reflex-order",
  "filler-order",
  "instance-order",
  "option"
] as const;

/** http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical (AllergyIntolerance.clinicalStatus). */
export const ALLERGY_CLINICAL_STATUS = ["active", "inactive", "resolved"] as const;

/** http://hl7.org/fhir/event-status (Procedure.status). */
export const PROCEDURE_STATUS = [
  "preparation",
  "in-progress",
  "not-done",
  "on-hold",
  "stopped",
  "completed",
  "entered-in-error",
  "unknown"
] as const;

/** http://hl7.org/fhir/document-reference-status (DocumentReference.status). */
export const DOCUMENT_REFERENCE_STATUS = ["current", "superseded", "entered-in-error"] as const;

/** http://hl7.org/fhir/consent-state-codes (Consent.status). */
export const CONSENT_STATUS = [
  "draft",
  "proposed",
  "active",
  "rejected",
  "inactive",
  "entered-in-error"
] as const;
