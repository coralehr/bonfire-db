/**
 * The whitelisted clinical projection views `useClinicalQuery` may read. The
 * union is compile-time AND runtime (zod enum): a view name is an IDENTIFIER
 * spliced into SQL, so it must never be an open string. The vd_* set is
 * data-driven from the SQL-on-FHIR ViewDefinitions — a catalog test asserts
 * this list stays a subset of the materialized tables.
 */
import { z } from "zod";

export const CLINICAL_VIEWS = [
  "vd_allergy_intolerance_summary",
  "vd_condition_summary",
  "vd_document_reference_summary",
  "vd_encounter_summary",
  "vd_medication_request_summary",
  "vd_observation_summary",
  "vd_patient_demographics",
  "vd_procedure_summary"
] as const;

export type ClinicalView = (typeof CLINICAL_VIEWS)[number];

export const clinicalViewSchema = z.enum(CLINICAL_VIEWS);
