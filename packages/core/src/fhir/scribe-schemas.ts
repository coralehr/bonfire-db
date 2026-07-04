/**
 * The nine typed scribe write inputs (the ~8 clinical resources plus Consent),
 * one strict Zod schema each, combined into a discriminated union on
 * `resourceType`. Each schema is a FHIR-aligned resource MINUS its
 * server-stamped `meta`; `required`-strength coded fields are pinned to closed
 * enums so an off-value fails at the boundary (fail-closed reject), and the
 * validated shape maps losslessly to canonical FHIR R4 / US Core 6.1.0.
 */
import { z } from "zod";
import {
  ADMINISTRATIVE_GENDER,
  ALLERGY_CLINICAL_STATUS,
  CONDITION_CLINICAL_STATUS,
  CONDITION_VERIFICATION_STATUS,
  CONSENT_STATUS,
  DOCUMENT_REFERENCE_STATUS,
  ENCOUNTER_STATUS,
  MEDICATION_REQUEST_INTENT,
  MEDICATION_REQUEST_STATUS,
  OBSERVATION_STATUS,
  PROCEDURE_STATUS
} from "../terminology/required-enums.js";
import {
  SYS_ALLERGY_CLINICAL,
  SYS_CONDITION_CLINICAL,
  SYS_CONDITION_VER_STATUS
} from "../terminology/systems.js";
import {
  codeableConceptSchema,
  codingSchema,
  documentContentSchema,
  humanNameSchema,
  identifierSchema,
  quantitySchema,
  referenceSchema,
  statusConceptSchema
} from "./scribe-shared.js";

const resourceId = z.uuid();
const dateTime = z.string().min(1);
const categories = z.array(codeableConceptSchema).min(1);

const patientScribeSchema = z.strictObject({
  resourceType: z.literal("Patient"),
  id: resourceId,
  identifier: z.array(identifierSchema).min(1),
  name: z.array(humanNameSchema).min(1),
  gender: z.enum(ADMINISTRATIVE_GENDER),
  birthDate: z.string().min(1).optional()
});

const encounterScribeSchema = z.strictObject({
  resourceType: z.literal("Encounter"),
  id: resourceId,
  status: z.enum(ENCOUNTER_STATUS),
  class: codingSchema,
  type: categories,
  subject: referenceSchema
});

const conditionScribeSchema = z.strictObject({
  resourceType: z.literal("Condition"),
  id: resourceId,
  clinicalStatus: statusConceptSchema(SYS_CONDITION_CLINICAL, CONDITION_CLINICAL_STATUS),
  verificationStatus: statusConceptSchema(SYS_CONDITION_VER_STATUS, CONDITION_VERIFICATION_STATUS),
  category: categories,
  code: codeableConceptSchema,
  subject: referenceSchema
});

const observationScribeSchema = z.strictObject({
  resourceType: z.literal("Observation"),
  id: resourceId,
  status: z.enum(OBSERVATION_STATUS),
  category: categories,
  code: codeableConceptSchema,
  subject: referenceSchema,
  effectiveDateTime: dateTime,
  valueQuantity: quantitySchema
});

const medicationRequestScribeSchema = z.strictObject({
  resourceType: z.literal("MedicationRequest"),
  id: resourceId,
  status: z.enum(MEDICATION_REQUEST_STATUS),
  intent: z.enum(MEDICATION_REQUEST_INTENT),
  medicationCodeableConcept: codeableConceptSchema,
  subject: referenceSchema,
  authoredOn: dateTime,
  requester: referenceSchema
});

const allergyIntoleranceScribeSchema = z.strictObject({
  resourceType: z.literal("AllergyIntolerance"),
  id: resourceId,
  clinicalStatus: statusConceptSchema(SYS_ALLERGY_CLINICAL, ALLERGY_CLINICAL_STATUS),
  code: codeableConceptSchema,
  patient: referenceSchema
});

const procedureScribeSchema = z.strictObject({
  resourceType: z.literal("Procedure"),
  id: resourceId,
  status: z.enum(PROCEDURE_STATUS),
  code: codeableConceptSchema,
  subject: referenceSchema,
  performedDateTime: dateTime
});

const documentReferenceScribeSchema = z.strictObject({
  resourceType: z.literal("DocumentReference"),
  id: resourceId,
  status: z.enum(DOCUMENT_REFERENCE_STATUS),
  type: codeableConceptSchema,
  category: categories,
  subject: referenceSchema,
  content: z.array(documentContentSchema).min(1),
  date: dateTime.optional()
});

const consentScribeSchema = z.strictObject({
  resourceType: z.literal("Consent"),
  id: resourceId,
  status: z.enum(CONSENT_STATUS),
  scope: codeableConceptSchema,
  category: categories,
  patient: referenceSchema,
  dateTime,
  policyRule: codeableConceptSchema
});

/** The full scribe write surface: one discriminated union over all nine resources. */
export const scribeInputSchema = z.discriminatedUnion("resourceType", [
  patientScribeSchema,
  encounterScribeSchema,
  conditionScribeSchema,
  observationScribeSchema,
  medicationRequestScribeSchema,
  allergyIntoleranceScribeSchema,
  procedureScribeSchema,
  documentReferenceScribeSchema,
  consentScribeSchema
]);

export type ScribeInput = z.infer<typeof scribeInputSchema>;
export type ScribeResourceType = ScribeInput["resourceType"];

export type PatientScribe = z.infer<typeof patientScribeSchema>;
export type EncounterScribe = z.infer<typeof encounterScribeSchema>;
export type ConditionScribe = z.infer<typeof conditionScribeSchema>;
export type ObservationScribe = z.infer<typeof observationScribeSchema>;
export type MedicationRequestScribe = z.infer<typeof medicationRequestScribeSchema>;
export type AllergyIntoleranceScribe = z.infer<typeof allergyIntoleranceScribeSchema>;
export type ProcedureScribe = z.infer<typeof procedureScribeSchema>;
export type DocumentReferenceScribe = z.infer<typeof documentReferenceScribeSchema>;
export type ConsentScribe = z.infer<typeof consentScribeSchema>;
