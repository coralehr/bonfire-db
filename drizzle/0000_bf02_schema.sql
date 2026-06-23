-- Generated from drizzle/schema.ts for BF-02.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS practices (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actors (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('clinician', 'agent', 'auditor')),
  display_name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email ~* '@example\.(com|org|net)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actors_id_practice_unique UNIQUE (id, practice_id)
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  synthetic_mrn text NOT NULL,
  display_name text NOT NULL,
  birth_year integer NOT NULL CHECK (birth_year BETWEEN 1900 AND 2100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patients_practice_mrn_unique UNIQUE (practice_id, synthetic_mrn),
  CONSTRAINT patients_id_practice_unique UNIQUE (id, practice_id)
);

CREATE TABLE IF NOT EXISTS patient_roster (
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  relationship text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, actor_id, patient_id),
  CONSTRAINT patient_roster_actor_practice_fk FOREIGN KEY (actor_id, practice_id) REFERENCES actors(id, practice_id) ON DELETE CASCADE,
  CONSTRAINT patient_roster_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT consents_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE CASCADE,
  CONSTRAINT consents_patient_scope_unique UNIQUE (practice_id, patient_id, scope)
);

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  author_actor_id uuid NOT NULL,
  note_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('signed', 'draft')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE RESTRICT,
  CONSTRAINT notes_author_practice_fk FOREIGN KEY (author_actor_id, practice_id) REFERENCES actors(id, practice_id) ON DELETE RESTRICT,
  CONSTRAINT notes_id_practice_unique UNIQUE (id, practice_id)
);

CREATE TABLE IF NOT EXISTS note_chunks (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  note_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  CONSTRAINT note_chunks_note_practice_fk FOREIGN KEY (note_id, practice_id) REFERENCES notes(id, practice_id) ON DELETE CASCADE,
  CONSTRAINT note_chunks_note_index_unique UNIQUE (note_id, chunk_index),
  CONSTRAINT note_chunks_id_practice_unique UNIQUE (id, practice_id)
);

CREATE TABLE IF NOT EXISTS note_embeddings (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  note_chunk_id uuid NOT NULL,
  fixture_key text NOT NULL UNIQUE,
  embedding_model text NOT NULL,
  embedding vector(8) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_embeddings_chunk_practice_fk FOREIGN KEY (note_chunk_id, practice_id) REFERENCES note_chunks(id, practice_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_notes (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  proposer_actor_id uuid NOT NULL,
  note_type text NOT NULL,
  proposed_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_notes_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE RESTRICT,
  CONSTRAINT draft_notes_actor_practice_fk FOREIGN KEY (proposer_actor_id, practice_id) REFERENCES actors(id, practice_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS terminology_codes (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  code_system text NOT NULL,
  code text NOT NULL,
  display text NOT NULL,
  CONSTRAINT terminology_codes_unique UNIQUE (practice_id, code_system, code)
);

CREATE TABLE IF NOT EXISTS fhir_imports (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  bundle_type text NOT NULL,
  bundle_hash text NOT NULL,
  source_label text NOT NULL,
  imported_at timestamptz NOT NULL,
  CONSTRAINT fhir_imports_patient_practice_fk FOREIGN KEY (patient_id, practice_id) REFERENCES patients(id, practice_id) ON DELETE RESTRICT,
  CONSTRAINT fhir_imports_bundle_hash_unique UNIQUE (practice_id, bundle_hash)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  prev_hash text NOT NULL,
  row_hash text NOT NULL UNIQUE,
  seed_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_actor_practice_fk FOREIGN KEY (actor_id, practice_id) REFERENCES actors(id, practice_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS seed_state (
  seed_key text PRIMARY KEY,
  seed_version text NOT NULL,
  row_hash text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS actors_practice_idx ON actors(practice_id);
CREATE INDEX IF NOT EXISTS patients_practice_idx ON patients(practice_id);
CREATE INDEX IF NOT EXISTS notes_practice_patient_idx ON notes(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS note_chunks_practice_note_idx ON note_chunks(practice_id, note_id);
CREATE INDEX IF NOT EXISTS note_embeddings_practice_chunk_idx ON note_embeddings(practice_id, note_chunk_id);
CREATE INDEX IF NOT EXISTS audit_events_practice_created_idx ON audit_events(practice_id, created_at DESC);
