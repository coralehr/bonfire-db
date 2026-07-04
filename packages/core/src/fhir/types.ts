/**
 * The @types/fhir R4 barrel. @types/fhir publishes its R4 resources into the
 * ambient UMD namespace fhir4 (not importable as a module under NodeNext), so a
 * triple-slash reference pulls it into scope; the typed builders import from HERE.
 */
/// <reference types="fhir" />

export type FhirResource = fhir4.Resource;
export type FhirPatient = fhir4.Patient;
export type FhirCondition = fhir4.Condition;
export type FhirObservation = fhir4.Observation;
export type FhirEncounter = fhir4.Encounter;
export type FhirMedicationRequest = fhir4.MedicationRequest;
export type FhirAllergyIntolerance = fhir4.AllergyIntolerance;
export type FhirProcedure = fhir4.Procedure;
export type FhirDocumentReference = fhir4.DocumentReference;
export type FhirConsent = fhir4.Consent;
