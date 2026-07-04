/**
 * US Core 6.1.0 profile URLs stamped onto `meta.profile` by the write path.
 * Consent maps to `null`: US Core 6.1.0 publishes NO Consent profile, so the
 * Consent resource is stored against base FHIR R4 (stamping a non-existent
 * profile would make the HL7 validator hard-error).
 */
import type { ScribeResourceType } from "./scribe-schemas.js";

const US_CORE = "http://hl7.org/fhir/us/core/StructureDefinition/";

/** resourceType → its US Core profile URL(s), or null for base-R4 resources. */
export const US_CORE_PROFILES: Readonly<Record<ScribeResourceType, readonly string[] | null>> = {
  Patient: [`${US_CORE}us-core-patient`],
  Encounter: [`${US_CORE}us-core-encounter`],
  Condition: [`${US_CORE}us-core-condition-problems-health-concerns`],
  Observation: [`${US_CORE}us-core-observation-lab`],
  MedicationRequest: [`${US_CORE}us-core-medicationrequest`],
  AllergyIntolerance: [`${US_CORE}us-core-allergyintolerance`],
  Procedure: [`${US_CORE}us-core-procedure`],
  DocumentReference: [`${US_CORE}us-core-documentreference`],
  Consent: null
};
