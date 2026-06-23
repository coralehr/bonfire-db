import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

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
}, (table) => [
  unique("practices_slug_key").on(table.slug)
]);

export const actors = pgTable("actors", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  role: text("role", { enum: ["clinician", "agent", "auditor", "patient"] }).notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  createdAt: createdAt()
}, (table) => [
  unique("actors_email_key").on(table.email),
  unique("actors_id_practice_unique").on(table.id, table.practiceId),
  check("actors_email_example_check", sql`${table.email} ~* '@example\\.(com|org|net)$'`)
]);

export const patients = pgTable("patients", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  syntheticMrn: text("synthetic_mrn").notNull(),
  displayName: text("display_name").notNull(),
  birthYear: integer("birth_year").notNull(),
  createdAt: createdAt()
}, (table) => [
  unique("patients_practice_mrn_unique").on(table.practiceId, table.syntheticMrn),
  unique("patients_id_practice_unique").on(table.id, table.practiceId),
  check("patients_birth_year_check", sql`${table.birthYear} BETWEEN 1900 AND 2100`)
]);

export const patientRoster = pgTable("patient_roster", {
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorId: uuid("actor_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  relationship: text("relationship").notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({ name: "patient_roster_pkey", columns: [table.practiceId, table.actorId, table.patientId] }),
  foreignKey({
    name: "patient_roster_actor_practice_fk",
    columns: [table.actorId, table.practiceId],
    foreignColumns: [actors.id, actors.practiceId]
  }).onDelete("cascade"),
  foreignKey({
    name: "patient_roster_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("cascade")
]);

export const patientActorLinks = pgTable("patient_actor_links", {
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorId: uuid("actor_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  relationship: text("relationship", { enum: ["self"] }).notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({ name: "patient_actor_links_pkey", columns: [table.practiceId, table.actorId, table.patientId] }),
  uniqueIndex("patient_actor_links_active_self_actor_unique")
    .on(table.practiceId, table.actorId)
    .where(sql`${table.relationship} = 'self' AND ${table.status} = 'active'`),
  foreignKey({
    name: "patient_actor_links_actor_practice_fk",
    columns: [table.actorId, table.practiceId],
    foreignColumns: [actors.id, actors.practiceId]
  }).onDelete("cascade"),
  foreignKey({
    name: "patient_actor_links_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("cascade")
]);

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull(),
  scope: text("scope").notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull()
}, (table) => [
  unique("consents_patient_scope_unique").on(table.practiceId, table.patientId, table.scope),
  foreignKey({
    name: "consents_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("cascade")
]);

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull(),
  authorActorId: uuid("author_actor_id").notNull(),
  noteType: text("note_type").notNull(),
  status: text("status", { enum: ["signed", "draft"] }).notNull(),
  body: text("body").notNull(),
  createdAt: createdAt()
}, (table) => [
  unique("notes_id_practice_unique").on(table.id, table.practiceId),
  foreignKey({
    name: "notes_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("restrict"),
  foreignKey({
    name: "notes_author_practice_fk",
    columns: [table.authorActorId, table.practiceId],
    foreignColumns: [actors.id, actors.practiceId]
  }).onDelete("restrict")
]);

export const noteChunks = pgTable("note_chunks", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  noteId: uuid("note_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull()
}, (table) => [
  unique("note_chunks_note_index_unique").on(table.noteId, table.chunkIndex),
  unique("note_chunks_id_practice_unique").on(table.id, table.practiceId),
  foreignKey({
    name: "note_chunks_note_practice_fk",
    columns: [table.noteId, table.practiceId],
    foreignColumns: [notes.id, notes.practiceId]
  }).onDelete("cascade"),
  check("note_chunks_chunk_index_check", sql`${table.chunkIndex} >= 0`)
]);

export const noteEmbeddings = pgTable("note_embeddings", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  noteChunkId: uuid("note_chunk_id").notNull(),
  fixtureKey: text("fixture_key").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embedding: vector("embedding", { dimensions: embeddingDimensions }).notNull(),
  createdAt: createdAt()
}, (table) => [
  unique("note_embeddings_fixture_key_key").on(table.fixtureKey),
  foreignKey({
    name: "note_embeddings_chunk_practice_fk",
    columns: [table.noteChunkId, table.practiceId],
    foreignColumns: [noteChunks.id, noteChunks.practiceId]
  }).onDelete("cascade")
]);

export const draftNotes = pgTable("draft_notes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull(),
  proposerActorId: uuid("proposer_actor_id").notNull(),
  noteType: text("note_type").notNull(),
  proposedText: text("proposed_text").notNull(),
  status: text("status", { enum: ["proposed", "approved", "rejected"] }).notNull(),
  createdAt: createdAt()
}, (table) => [
  foreignKey({
    name: "draft_notes_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("restrict"),
  foreignKey({
    name: "draft_notes_actor_practice_fk",
    columns: [table.proposerActorId, table.practiceId],
    foreignColumns: [actors.id, actors.practiceId]
  }).onDelete("restrict")
]);

export const terminologyCodes = pgTable("terminology_codes", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  codeSystem: text("code_system").notNull(),
  code: text("code").notNull(),
  display: text("display").notNull()
}, (table) => [
  unique("terminology_codes_unique").on(table.practiceId, table.codeSystem, table.code)
]);

export const fhirImports = pgTable("fhir_imports", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  patientId: uuid("patient_id").notNull(),
  bundleType: text("bundle_type").notNull(),
  bundleHash: text("bundle_hash").notNull(),
  sourceLabel: text("source_label").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull()
}, (table) => [
  unique("fhir_imports_bundle_hash_unique").on(table.practiceId, table.bundleHash),
  foreignKey({
    name: "fhir_imports_patient_practice_fk",
    columns: [table.patientId, table.practiceId],
    foreignColumns: [patients.id, patients.practiceId]
  }).onDelete("restrict")
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  practiceId: uuid("practice_id").notNull().references(() => practices.id),
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  prevHash: text("prev_hash").notNull(),
  rowHash: text("row_hash").notNull(),
  seedKey: text("seed_key"),
  createdAt: createdAt()
}, (table) => [
  unique("audit_events_row_hash_key").on(table.rowHash),
  unique("audit_events_seed_key_key").on(table.seedKey),
  foreignKey({
    name: "audit_events_actor_practice_fk",
    columns: [table.actorId, table.practiceId],
    foreignColumns: [actors.id, actors.practiceId]
  }).onDelete("restrict")
]);

export const seedState = pgTable("seed_state", {
  seedKey: text("seed_key").primaryKey(),
  seedVersion: text("seed_version").notNull(),
  rowHash: text("row_hash").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow()
});
