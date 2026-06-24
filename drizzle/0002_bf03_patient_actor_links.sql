-- BF-03: model patient-facing actors as explicit self-links to patient records.

ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_role_check;
ALTER TABLE actors
  ADD CONSTRAINT actors_role_check CHECK (role IN ('clinician', 'agent', 'auditor', 'patient'));

CREATE TABLE IF NOT EXISTS patient_actor_links (
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  relationship text NOT NULL CHECK (relationship = 'self'),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, actor_id, patient_id),
  CONSTRAINT patient_actor_links_actor_practice_fk FOREIGN KEY (actor_id, practice_id) REFERENCES actors(id, practice_id) ON DELETE CASCADE,
  CONSTRAINT patient_actor_links_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS patient_actor_links_active_self_actor_unique
ON patient_actor_links(practice_id, actor_id)
WHERE relationship = 'self' AND status = 'active';

CREATE INDEX IF NOT EXISTS patient_actor_links_patient_idx
ON patient_actor_links(practice_id, patient_id);
