/**
 * Typed FHIR R4 builders — the ONLY producers of canonical clinical resources.
 * Each takes a validated scribe input and returns a strongly-typed fhir4.*
 * resource stamped with its US Core `meta.profile`; nothing beyond the input's
 * fields plus that profile is added, so the strip-meta inverse recovers the
 * input exactly (round-trip losslessness is structural, machine-checked).
 */

import { US_CORE_PROFILES } from "./profiles.js";
import type {
  AllergyIntoleranceScribe,
  ConditionScribe,
  ConsentScribe,
  DocumentReferenceScribe,
  EncounterScribe,
  MedicationRequestScribe,
  ObservationScribe,
  PatientScribe,
  ProcedureScribe,
  ScribeResourceType
} from "./scribe-schemas.js";
import type {
  FhirAllergyIntolerance,
  FhirCondition,
  FhirConsent,
  FhirDocumentReference,
  FhirEncounter,
  FhirMedicationRequest,
  FhirObservation,
  FhirPatient,
  FhirProcedure,
  FhirResource
} from "./types.js";

function withProfile<T extends FhirResource>(resource: T, resourceType: ScribeResourceType): T {
  const profile = US_CORE_PROFILES[resourceType];
  if (profile !== null) resource.meta = { profile: [...profile] };
  return resource;
}

export function buildPatient(input: PatientScribe): FhirPatient {
  const patient: FhirPatient = {
    resourceType: "Patient",
    id: input.id,
    identifier: input.identifier,
    name: input.name,
    gender: input.gender
  };
  if (input.birthDate !== undefined) patient.birthDate = input.birthDate;
  return withProfile(patient, "Patient");
}

export function buildEncounter(input: EncounterScribe): FhirEncounter {
  const encounter: FhirEncounter = {
    resourceType: "Encounter",
    id: input.id,
    status: input.status,
    class: input.class,
    type: [...input.type],
    subject: input.subject
  };
  return withProfile(encounter, "Encounter");
}

export function buildCondition(input: ConditionScribe): FhirCondition {
  const condition: FhirCondition = {
    resourceType: "Condition",
    id: input.id,
    clinicalStatus: input.clinicalStatus,
    verificationStatus: input.verificationStatus,
    category: [...input.category],
    code: input.code,
    subject: input.subject
  };
  return withProfile(condition, "Condition");
}

export function buildObservation(input: ObservationScribe): FhirObservation {
  const observation: FhirObservation = {
    resourceType: "Observation",
    id: input.id,
    status: input.status,
    category: [...input.category],
    code: input.code,
    subject: input.subject,
    effectiveDateTime: input.effectiveDateTime,
    valueQuantity: input.valueQuantity
  };
  return withProfile(observation, "Observation");
}

export function buildMedicationRequest(input: MedicationRequestScribe): FhirMedicationRequest {
  const request: FhirMedicationRequest = {
    resourceType: "MedicationRequest",
    id: input.id,
    status: input.status,
    intent: input.intent,
    medicationCodeableConcept: input.medicationCodeableConcept,
    subject: input.subject,
    authoredOn: input.authoredOn,
    requester: input.requester
  };
  return withProfile(request, "MedicationRequest");
}

export function buildAllergyIntolerance(input: AllergyIntoleranceScribe): FhirAllergyIntolerance {
  const allergy: FhirAllergyIntolerance = {
    resourceType: "AllergyIntolerance",
    id: input.id,
    clinicalStatus: input.clinicalStatus,
    code: input.code,
    patient: input.patient
  };
  return withProfile(allergy, "AllergyIntolerance");
}

export function buildProcedure(input: ProcedureScribe): FhirProcedure {
  const procedure: FhirProcedure = {
    resourceType: "Procedure",
    id: input.id,
    status: input.status,
    code: input.code,
    subject: input.subject,
    performedDateTime: input.performedDateTime
  };
  return withProfile(procedure, "Procedure");
}

export function buildDocumentReference(input: DocumentReferenceScribe): FhirDocumentReference {
  const document: FhirDocumentReference = {
    resourceType: "DocumentReference",
    id: input.id,
    status: input.status,
    type: input.type,
    category: [...input.category],
    subject: input.subject,
    content: input.content.map((entry) => ({ ...entry }))
  };
  if (input.date !== undefined) document.date = input.date;
  return withProfile(document, "DocumentReference");
}

export function buildConsent(input: ConsentScribe): FhirConsent {
  const consent: FhirConsent = {
    resourceType: "Consent",
    id: input.id,
    status: input.status,
    scope: input.scope,
    category: [...input.category],
    patient: input.patient,
    dateTime: input.dateTime,
    policyRule: input.policyRule
  };
  return withProfile(consent, "Consent");
}
