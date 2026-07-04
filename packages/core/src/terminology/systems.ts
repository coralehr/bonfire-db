/**
 * Canonical code-system URIs. `required`-status systems key the small closed
 * enums (fail-closed reject); the large clinical vocabularies key the
 * extensible bindings the BundledPackValidator checks by SQL membership (miss
 * = audited WARNING, never a block). SNOMED is present for FORMAT-only checks —
 * no SNOMED concept content is ever bundled.
 */

/** http://terminology.hl7.org/CodeSystem/condition-clinical. */
export const SYS_CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
/** http://terminology.hl7.org/CodeSystem/condition-ver-status. */
export const SYS_CONDITION_VER_STATUS =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status";
/** http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical. */
export const SYS_ALLERGY_CLINICAL =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";

/** http://hl7.org/fhir/sid/icd-10-cm — extensible (bundled sample pack). */
export const SYS_ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm";
/** http://loinc.org — extensible (pack deferred; system-not-loaded WARN). */
export const SYS_LOINC = "http://loinc.org";
/** http://www.nlm.nih.gov/research/umls/rxnorm — extensible (pack deferred). */
export const SYS_RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** http://snomed.info/sct — FORMAT-only (Verhoeff + partition + URI). */
export const SYS_SNOMED = "http://snomed.info/sct";
