import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clinicalTableNames,
  clinicalTablesWithPracticeId,
  embeddingDimensions,
  minimumTableNames,
  seedCompleteKey
} from "./schema";
import { bonfireSeed, seedEmails } from "../../../seed/data";

const migrationSql = readFileSync(join(process.cwd(), "drizzle/0000_bf02_schema.sql"), "utf8");
const drizzleSchema = readFileSync(join(process.cwd(), "drizzle/schema.ts"), "utf8");

describe("BF-02 schema contract", () => {
  test("contains every minimum MVP table", () => {
    for (const tableName of minimumTableNames) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
  });

  test("keeps a Drizzle table source for every generated SQL table", () => {
    expect(drizzleSchema).toContain("drizzle-orm/pg-core");

    for (const tableName of minimumTableNames) {
      expect(drizzleSchema).toContain(`pgTable("${tableName}"`);
    }
  });

  test("keeps Drizzle constraints aligned with tenant-scoped SQL guards", () => {
    expect(drizzleSchema).toContain("patient_roster_pkey");
    expect(migrationSql).toContain("PRIMARY KEY (practice_id, actor_id, patient_id)");

    for (const constraintName of [
      "patient_roster_actor_practice_fk",
      "patient_roster_patient_practice_fk",
      "actors_id_practice_unique",
      "patients_id_practice_unique",
      "patients_practice_mrn_unique",
      "notes_patient_practice_fk",
      "notes_author_practice_fk",
      "note_embeddings_chunk_practice_fk",
      "audit_events_actor_practice_fk"
    ]) {
      expect(drizzleSchema).toContain(constraintName);
      expect(migrationSql).toContain(constraintName);
    }
  });

  test("does not duplicate compound tenant FKs as single-column references", () => {
    for (const redundantReference of [
      'actorId: uuid("actor_id").notNull().references',
      'patientId: uuid("patient_id").notNull().references',
      'authorActorId: uuid("author_actor_id").notNull().references',
      'noteId: uuid("note_id").notNull().references',
      'noteChunkId: uuid("note_chunk_id").notNull().references',
      'proposerActorId: uuid("proposer_actor_id").notNull().references'
    ]) {
      expect(drizzleSchema).not.toContain(redundantReference);
    }
  });

  test("tracks practice_id on every clinical table", () => {
    expect(clinicalTablesWithPracticeId).toEqual(clinicalTableNames);

    for (const tableName of clinicalTableNames) {
      const tableStart = migrationSql.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName}`);
      expect(tableStart).toBeGreaterThanOrEqual(0);

      const tableEnd = migrationSql.indexOf("\n);", tableStart);
      const tableSql = migrationSql.slice(tableStart, tableEnd);
      expect(tableSql).toContain("practice_id uuid NOT NULL");
    }
  });

  test("commits pgvector embedding slots and seed marker names", () => {
    expect(embeddingDimensions).toBe(8);
    expect(seedCompleteKey).toBe("seed_complete");
    expect(migrationSql).toContain(`embedding vector(${embeddingDimensions}) NOT NULL`);
    expect(bonfireSeed.embeddings.every((slot) => slot.vector.length === embeddingDimensions)).toBe(true);
  });

  test("audit events include hash-chain columns", () => {
    expect(migrationSql).toContain("prev_hash text NOT NULL");
    expect(migrationSql).toContain("row_hash text NOT NULL");
  });

  test("seed email addresses use example domains only", () => {
    expect(seedEmails().length).toBeGreaterThan(0);
    for (const email of seedEmails()) {
      expect(email).toMatch(/@example\.(com|org|net)$/);
    }
  });
});
