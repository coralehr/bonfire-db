import { customType, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const embeddingDimensions = 8;

const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? embeddingDimensions})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .filter(Boolean)
      .map(Number);
  }
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const practices = pgTable("practices", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt()
});

export const actors = pgTable("actors", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  role: text("role", { enum: ["clinician", "agent", "auditor"] }).notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  createdAt: createdAt()
});

export const patients = pgTable("patients", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  syntheticMrn: text("synthetic_mrn").notNull(),
  displayName: text("display_name").notNull(),
  birthYear: integer("birth_year").notNull(),
  createdAt: createdAt()
});

export const patientRoster = pgTable("patient_roster", {
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorId: uuid("actor_id").notNull().references(() => actors.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  relationship: text("relationship").notNull(),
  createdAt: createdAt()
});

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  scope: text("scope").notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull()
});

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  authorActorId: uuid("author_actor_id").notNull().references(() => actors.id),
  noteType: text("note_type").notNull(),
  status: text("status", { enum: ["signed", "draft"] }).notNull(),
  body: text("body").notNull(),
  createdAt: createdAt()
});

export const noteChunks = pgTable("note_chunks", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull()
});

export const noteEmbeddings = pgTable("note_embeddings", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  noteChunkId: uuid("note_chunk_id").notNull().references(() => noteChunks.id),
  fixtureKey: text("fixture_key").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embedding: vector("embedding", { dimensions: embeddingDimensions }).notNull(),
  createdAt: createdAt()
});

export const draftNotes = pgTable("draft_notes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  proposerActorId: uuid("proposer_actor_id").notNull().references(() => actors.id),
  noteType: text("note_type").notNull(),
  proposedText: text("proposed_text").notNull(),
  status: text("status", { enum: ["proposed", "approved", "rejected"] }).notNull(),
  createdAt: createdAt()
});

export const terminologyCodes = pgTable("terminology_codes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  codeSystem: text("code_system").notNull(),
  code: text("code").notNull(),
  display: text("display").notNull()
});

export const fhirImports = pgTable("fhir_imports", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  bundleType: text("bundle_type").notNull(),
  bundleHash: text("bundle_hash").notNull(),
  sourceLabel: text("source_label").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull()
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorId: uuid("actor_id").notNull().references(() => actors.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  prevHash: text("prev_hash").notNull(),
  rowHash: text("row_hash").notNull(),
  seedKey: text("seed_key"),
  createdAt: createdAt()
});

export const seedState = pgTable("seed_state", {
  seedKey: text("seed_key").primaryKey(),
  seedVersion: text("seed_version").notNull(),
  rowHash: text("row_hash").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow()
});
