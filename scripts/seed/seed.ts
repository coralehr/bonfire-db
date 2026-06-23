import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bonfireSeed, seedCompleteKey, seedVersion } from "../../seed/data.js";

const exampleEmailPattern = /@example\.(com|org|net)$/;
const readinessAttempts = 30;

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function sqlLiteral(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function vectorLiteral(vector: readonly number[]): string {
  return sqlLiteral(`[${vector.join(",")}]`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function runPsql(args: string[], input?: string): string {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "bonfire", "-d", "bonfire", ...args],
    { encoding: "utf8", input }
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "psql failed").trim());
  }

  return result.stdout;
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
    try {
      runPsql(["-c", "SELECT 1"]);
      return;
    } catch (error) {
      if (attempt === readinessAttempts) throw error;
      await delay(1000);
    }
  }
}

function assertSyntheticEmails(): void {
  for (const actor of bonfireSeed.actors) {
    if (!exampleEmailPattern.test(actor.email)) {
      throw new Error(`seed actor ${actor.id} uses a non-example email domain`);
    }
  }
}

function seedSql(): string {
  const statements: string[] = ["BEGIN;"];

  for (const practice of bonfireSeed.practices) {
    statements.push(`
      INSERT INTO practices (id, slug, name)
      VALUES (${sqlLiteral(practice.id)}, ${sqlLiteral(practice.slug)}, ${sqlLiteral(practice.name)})
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        name = EXCLUDED.name;
    `);
  }

  for (const actor of bonfireSeed.actors) {
    statements.push(`
      INSERT INTO actors (id, practice_id, role, display_name, email)
      VALUES (${sqlLiteral(actor.id)}, ${sqlLiteral(actor.practiceId)}, ${sqlLiteral(actor.role)}, ${sqlLiteral(actor.displayName)}, ${sqlLiteral(actor.email)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        role = EXCLUDED.role,
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email;
    `);
  }

  for (const patient of bonfireSeed.patients) {
    statements.push(`
      INSERT INTO patients (id, practice_id, synthetic_mrn, display_name, birth_year)
      VALUES (${sqlLiteral(patient.id)}, ${sqlLiteral(patient.practiceId)}, ${sqlLiteral(patient.syntheticMrn)}, ${sqlLiteral(patient.displayName)}, ${sqlLiteral(patient.birthYear)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        synthetic_mrn = EXCLUDED.synthetic_mrn,
        display_name = EXCLUDED.display_name,
        birth_year = EXCLUDED.birth_year;
    `);
  }

  for (const roster of bonfireSeed.patientRoster) {
    statements.push(`
      INSERT INTO patient_roster (practice_id, actor_id, patient_id, relationship)
      VALUES (${sqlLiteral(roster.practiceId)}, ${sqlLiteral(roster.actorId)}, ${sqlLiteral(roster.patientId)}, ${sqlLiteral(roster.relationship)})
      ON CONFLICT (practice_id, actor_id, patient_id) DO UPDATE SET
        relationship = EXCLUDED.relationship;
    `);
  }

  for (const consent of bonfireSeed.consents) {
    statements.push(`
      INSERT INTO consents (id, practice_id, patient_id, scope, status, recorded_at)
      VALUES (${sqlLiteral(consent.id)}, ${sqlLiteral(consent.practiceId)}, ${sqlLiteral(consent.patientId)}, ${sqlLiteral(consent.scope)}, ${sqlLiteral(consent.status)}, ${sqlLiteral(consent.recordedAt)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        patient_id = EXCLUDED.patient_id,
        scope = EXCLUDED.scope,
        status = EXCLUDED.status,
        recorded_at = EXCLUDED.recorded_at;
    `);
  }

  for (const note of bonfireSeed.notes) {
    statements.push(`
      INSERT INTO notes (id, practice_id, patient_id, author_actor_id, note_type, status, body)
      VALUES (${sqlLiteral(note.id)}, ${sqlLiteral(note.practiceId)}, ${sqlLiteral(note.patientId)}, ${sqlLiteral(note.authorActorId)}, ${sqlLiteral(note.noteType)}, ${sqlLiteral(note.status)}, ${sqlLiteral(note.body)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        patient_id = EXCLUDED.patient_id,
        author_actor_id = EXCLUDED.author_actor_id,
        note_type = EXCLUDED.note_type,
        status = EXCLUDED.status,
        body = EXCLUDED.body;
    `);
  }

  for (const chunk of bonfireSeed.noteChunks) {
    statements.push(`
      INSERT INTO note_chunks (id, practice_id, note_id, chunk_index, content)
      VALUES (${sqlLiteral(chunk.id)}, ${sqlLiteral(chunk.practiceId)}, ${sqlLiteral(chunk.noteId)}, ${sqlLiteral(chunk.chunkIndex)}, ${sqlLiteral(chunk.content)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        note_id = EXCLUDED.note_id,
        chunk_index = EXCLUDED.chunk_index,
        content = EXCLUDED.content;
    `);
  }

  for (const slot of bonfireSeed.embeddings) {
    statements.push(`
      INSERT INTO note_embeddings (id, practice_id, note_chunk_id, fixture_key, embedding_model, embedding)
      VALUES (${sqlLiteral(slot.id)}, ${sqlLiteral(slot.practiceId)}, ${sqlLiteral(slot.noteChunkId)}, ${sqlLiteral(slot.fixtureKey)}, ${sqlLiteral(slot.embeddingModel)}, ${vectorLiteral(slot.vector)}::vector)
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        note_chunk_id = EXCLUDED.note_chunk_id,
        fixture_key = EXCLUDED.fixture_key,
        embedding_model = EXCLUDED.embedding_model,
        embedding = EXCLUDED.embedding;
    `);
  }

  for (const draft of bonfireSeed.draftNotes) {
    statements.push(`
      INSERT INTO draft_notes (id, practice_id, patient_id, proposer_actor_id, note_type, proposed_text, status)
      VALUES (${sqlLiteral(draft.id)}, ${sqlLiteral(draft.practiceId)}, ${sqlLiteral(draft.patientId)}, ${sqlLiteral(draft.proposerActorId)}, ${sqlLiteral(draft.noteType)}, ${sqlLiteral(draft.proposedText)}, ${sqlLiteral(draft.status)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        patient_id = EXCLUDED.patient_id,
        proposer_actor_id = EXCLUDED.proposer_actor_id,
        note_type = EXCLUDED.note_type,
        proposed_text = EXCLUDED.proposed_text,
        status = EXCLUDED.status;
    `);
  }

  for (const code of bonfireSeed.terminologyCodes) {
    statements.push(`
      INSERT INTO terminology_codes (id, practice_id, code_system, code, display)
      VALUES (${sqlLiteral(code.id)}, ${sqlLiteral(code.practiceId)}, ${sqlLiteral(code.codeSystem)}, ${sqlLiteral(code.code)}, ${sqlLiteral(code.display)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        code_system = EXCLUDED.code_system,
        code = EXCLUDED.code,
        display = EXCLUDED.display;
    `);
  }

  for (const fhirImport of bonfireSeed.fhirImports) {
    statements.push(`
      INSERT INTO fhir_imports (id, practice_id, patient_id, bundle_type, bundle_hash, source_label, imported_at)
      VALUES (${sqlLiteral(fhirImport.id)}, ${sqlLiteral(fhirImport.practiceId)}, ${sqlLiteral(fhirImport.patientId)}, ${sqlLiteral(fhirImport.bundleType)}, ${sqlLiteral(fhirImport.bundleHash)}, ${sqlLiteral(fhirImport.sourceLabel)}, ${sqlLiteral(fhirImport.importedAt)})
      ON CONFLICT (id) DO UPDATE SET
        practice_id = EXCLUDED.practice_id,
        patient_id = EXCLUDED.patient_id,
        bundle_type = EXCLUDED.bundle_type,
        bundle_hash = EXCLUDED.bundle_hash,
        source_label = EXCLUDED.source_label,
        imported_at = EXCLUDED.imported_at;
    `);
  }

  for (const event of bonfireSeed.auditEvents) {
    const rowHash = hashPayload(event);
    statements.push(`
      INSERT INTO audit_events (id, practice_id, actor_id, action, target_type, target_id, decision, reason, prev_hash, row_hash, seed_key)
      VALUES (${sqlLiteral(event.id)}, ${sqlLiteral(event.practiceId)}, ${sqlLiteral(event.actorId)}, ${sqlLiteral(event.action)}, ${sqlLiteral(event.targetType)}, ${sqlLiteral(event.targetId)}, ${sqlLiteral(event.decision)}, ${sqlLiteral(event.reason)}, ${sqlLiteral(event.prevHash)}, ${sqlLiteral(rowHash)}, ${sqlLiteral(event.seedKey)})
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  const seedHash = hashPayload({
    seedVersion,
    seedCompleteKey,
    counts: {
      practices: bonfireSeed.practices.length,
      actors: bonfireSeed.actors.length,
      patients: bonfireSeed.patients.length,
      notes: bonfireSeed.notes.length,
      embeddings: bonfireSeed.embeddings.length
    }
  });

  statements.push(`
    INSERT INTO seed_state (seed_key, seed_version, row_hash)
    VALUES (${sqlLiteral(seedCompleteKey)}, ${sqlLiteral(seedVersion)}, ${sqlLiteral(seedHash)})
    ON CONFLICT (seed_key) DO UPDATE SET
      seed_version = EXCLUDED.seed_version,
      row_hash = EXCLUDED.row_hash;
  `);

  statements.push("COMMIT;");
  return statements.join("\n");
}

async function run(): Promise<void> {
  try {
    assertSyntheticEmails();
    await waitForDatabase();
    runPsql(["-f", "-"], seedSql());
    console.log(`seed: PASS ${seedCompleteKey}`);
  } catch (error) {
    console.error(`seed: FAIL ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

await run();
