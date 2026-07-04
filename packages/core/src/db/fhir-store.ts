/**
 * The ONE atomic write path for canonical FHIR: both functions run INSIDE a
 * withTenant transaction, so fhir_resources + history + write_inputs commit
 * or roll back together. practice_id is never caller input — it is derived in
 * SQL from the transaction-local GUC. Expected failures are typed Results;
 * database failures THROW so withTenant rolls the whole transaction back.
 */
import { z } from "zod";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import type { JsonObject, JsonValue } from "./canonical-json.js";
import { contentHash } from "./canonical-json.js";
import type { TenantSql } from "./tenant.js";

/** Recursive Zod boundary schema for any JSON value (parse, don't validate). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const fhirContentSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const insertInputSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  content: fhirContentSchema,
  rawPayload: z.string().min(1)
});

const updateInputSchema = z.object({
  id: z.uuid(),
  content: fhirContentSchema,
  expectedVersionId: z
    .string()
    .regex(/^[0-9]+$/)
    .optional()
});

const insertedRowSchema = z.object({ practice_id: z.string(), version_id: z.string() });
const currentRowSchema = z.object({
  type: z.string(),
  version_id: z.string(),
  practice_id: z.string()
});
const updatedRowSchema = z.object({ version_id: z.string() });

export type FhirStoreErrorCode = "INVALID_FHIR_INPUT" | "RESOURCE_NOT_FOUND" | "VERSION_CONFLICT";

export interface InsertFhirResourceInput {
  readonly id: string;
  readonly type: string;
  readonly content: JsonObject;
  readonly rawPayload: string;
}

export interface UpdateFhirResourceInput {
  readonly id: string;
  readonly content: JsonObject;
  readonly expectedVersionId?: string;
}

export interface FhirResourceRecord {
  readonly id: string;
  readonly type: string;
  readonly practiceId: string;
  readonly versionId: string;
  readonly contentHash: string;
}

type FhirStoreError = BonfireError<FhirStoreErrorCode>;

function invalidInput(error: z.ZodError): FhirStoreError {
  const path = error.issues[0]?.path.join(".");
  const where = path === undefined || path === "" ? "input" : path;
  return { code: "INVALID_FHIR_INPUT", message: `invalid FHIR write input at ${where}` };
}

function resourceTypeMismatch(type: string, content: JsonObject): FhirStoreError | undefined {
  if (content.resourceType === type) return undefined;
  return {
    code: "INVALID_FHIR_INPUT",
    message: "content.resourceType must match the resource type"
  };
}

/**
 * The canonical row id and the FHIR content.id must agree at WRITE time:
 * projections key vd_* rows by the projected getResourceKey() (= content.id)
 * while addressing them by fhir_resources.id, so a divergent pair strands
 * stale projection rows and splits the two writers (BP-028,
 * projection-key-divergence). The downstream upsert/rebuild guards refuse such
 * rows too; this check stops them from ever being persisted.
 */
function contentIdMismatch(id: string, content: JsonObject): FhirStoreError | undefined {
  if (content.id === id) return undefined;
  return {
    code: "INVALID_FHIR_INPUT",
    message: "content.id must equal the canonical resource id"
  };
}

/** Rows come back as postgres.js Row (untyped); parse, never cast. */
function parseRow<T>(schema: z.ZodType<T>, rows: readonly unknown[], context: string): T {
  const parsed = schema.safeParse(rows[0]);
  if (!parsed.success) throw new Error(`unexpected row shape from ${context}`);
  return parsed.data;
}

/**
 * Create version 1 of a resource: fhir_resources + history(v1) + write_inputs
 * (verbatim rawPayload, 1:1) in the caller's transaction.
 */
export async function insertFhirResourceTx(
  sql: TenantSql,
  input: InsertFhirResourceInput
): Promise<Result<FhirResourceRecord, FhirStoreError>> {
  const parsed = insertInputSchema.safeParse(input);
  if (!parsed.success) return err(invalidInput(parsed.error));
  const { id, type, content, rawPayload } = parsed.data;
  const mismatch = resourceTypeMismatch(type, content) ?? contentIdMismatch(id, content);
  if (mismatch !== undefined) return err(mismatch);
  const hash = contentHash(content);
  const inserted = await sql`
    insert into fhir_resources (id, type, practice_id, version_id, last_updated, content)
    values (${id}, ${type},
      (select safe_uuid(current_setting('app.current_practice_id', true))),
      1, now(), ${sql.json(content)})
    returning practice_id, version_id::text as version_id`;
  const head = parseRow(insertedRowSchema, inserted, "fhir_resources insert");
  await sql`
    insert into history (id, version_id, type, practice_id, content, content_hash, last_updated)
    values (${id}, 1, ${type}, ${head.practice_id},
      ${sql.json(content)}, ${hash}, now())`;
  await sql`
    insert into write_inputs (practice_id, fhir_resource_id, raw_payload)
    values (${head.practice_id}, ${id}, ${rawPayload})`;
  return ok({
    id,
    type,
    practiceId: head.practice_id,
    versionId: head.version_id,
    contentHash: hash
  });
}

/**
 * Append the next version: history gets version n+1 (the new content), then
 * the latest projection is updated — no history row is ever rewritten.
 * A stale expectedVersionId is a typed VERSION_CONFLICT and writes nothing.
 */
export async function updateFhirResourceTx(
  sql: TenantSql,
  input: UpdateFhirResourceInput
): Promise<Result<FhirResourceRecord, FhirStoreError>> {
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) return err(invalidInput(parsed.error));
  const { id, content, expectedVersionId } = parsed.data;
  const current = await sql`
    select type, version_id::text as version_id, practice_id
    from fhir_resources where id = ${id} for update`;
  if (current.length === 0) {
    // RLS scopes the SELECT: another practice's resource is indistinguishable
    // from a missing one — fail-closed, no cross-tenant existence oracle.
    return err({ code: "RESOURCE_NOT_FOUND", message: "no such resource in this practice" });
  }
  const head = parseRow(currentRowSchema, current, "fhir_resources select for update");
  if (expectedVersionId !== undefined && expectedVersionId !== head.version_id) {
    return err({ code: "VERSION_CONFLICT", message: "expectedVersionId is stale" });
  }
  const mismatch = resourceTypeMismatch(head.type, content) ?? contentIdMismatch(id, content);
  if (mismatch !== undefined) return err(mismatch);
  const hash = contentHash(content);
  await sql`
    insert into history (id, version_id, type, practice_id, content, content_hash, last_updated)
    values (${id}, ${head.version_id}::bigint + 1, ${head.type}, ${head.practice_id},
      ${sql.json(content)}, ${hash}, now())`;
  const updated = await sql`
    update fhir_resources
    set version_id = version_id + 1, content = ${sql.json(content)},
      last_updated = now()
    where id = ${id}
    returning version_id::text as version_id`;
  const next = parseRow(updatedRowSchema, updated, "fhir_resources update");
  return ok({
    id,
    type: head.type,
    practiceId: head.practice_id,
    versionId: next.version_id,
    contentHash: hash
  });
}
