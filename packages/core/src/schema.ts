export const embeddingDimensions = 8;
export const seedCompleteKey = "seed_complete";

export const minimumTableNames = [
  "practices",
  "actors",
  "patients",
  "patient_roster",
  "patient_actor_links",
  "consents",
  "notes",
  "note_chunks",
  "note_embeddings",
  "draft_notes",
  "terminology_codes",
  "fhir_imports",
  "audit_events",
  "seed_state"
] as const;

export const clinicalTableNames = [
  "actors",
  "patients",
  "patient_roster",
  "patient_actor_links",
  "consents",
  "notes",
  "note_chunks",
  "note_embeddings",
  "draft_notes",
  "terminology_codes",
  "fhir_imports",
  "audit_events"
] as const;

export const clinicalTablesWithPracticeId = [...clinicalTableNames] as const;

export type MinimumTableName = typeof minimumTableNames[number];
export type ClinicalTableName = typeof clinicalTableNames[number];
