/**
 * Rebuildable explicit-reference projection for one canonical resource.
 * This stays inside the caller's tenant transaction and derives practice_id
 * from the RLS GUC; callers cannot stamp another tenant onto an edge.
 */
import { z } from "zod";
import type { JsonObject } from "../db/canonical-json.js";
import { canonicalizeJson, sha256Hex } from "../db/canonical-json.js";
import { jsonValueSchema } from "../db/fhir-store.js";
import type { TenantSql } from "../db/tenant.js";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import { extractExplicitReferences, type ExplicitReference } from "./extract.js";

export type ReferenceProjectionErrorCode =
  | "REFERENCE_INVALID_INPUT"
  | "REFERENCE_RESOURCE_NOT_FOUND"
  | "REFERENCE_KEY_MISMATCH";

export interface ReferenceProjectionSummary {
  readonly edgeCount: number;
  readonly sourceVersionId: string;
  readonly digest: string;
}

export interface ReferenceProjectionComparison {
  readonly equal: boolean;
  readonly headPresent: boolean;
  readonly storedEdgeCount: number;
  readonly freshEdgeCount: number;
  readonly storedDigest: string;
  readonly freshDigest: string;
  readonly sourceVersionId: string;
  readonly storedSourceVersionId: string | null;
}

type ReferenceProjectionError = BonfireError<ReferenceProjectionErrorCode>;

const resourceIdSchema = z.uuid();
const canonicalRowSchema = z.object({
  type: z.string().min(1),
  version_id: z.string().regex(/^[0-9]+$/),
  content: z.record(z.string(), jsonValueSchema)
});
const storedEdgeSchema = z.object({
  source_resource_type: z.string().min(1),
  source_version_id: z.string().regex(/^[0-9]+$/),
  json_path: z.string().min(1),
  target_resource_type: z.string().min(1),
  target_resource_id: z.string().min(1),
  target_version_id: z.string().nullable(),
  edge_kind: z.string().min(1)
});
const projectionHeadSchema = z.object({
  source_resource_type: z.string().min(1),
  source_version_id: z.string().regex(/^[0-9]+$/),
  edge_count: z.number().int().nonnegative(),
  projection_digest: z.string().regex(/^[0-9a-f]{64}$/)
});

function digestProjection(
  sourceResourceType: string,
  sourceVersionId: string,
  edges: readonly ExplicitReference[]
): string {
  return sha256Hex(
    canonicalizeJson({
      sourceResourceType,
      sourceVersionId,
      edgeKind: "explicit",
      edges
    } as unknown as JsonObject)
  );
}

async function fetchCanonical(
  sql: TenantSql,
  resourceId: string
): Promise<Result<z.infer<typeof canonicalRowSchema>, ReferenceProjectionError>> {
  const rows = await sql`
    select type, version_id::text as version_id, content
    from fhir_resources where id = ${resourceId}`;
  const parsed = canonicalRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    return err({
      code: "REFERENCE_RESOURCE_NOT_FOUND",
      message: "resource is not visible in this tenant transaction"
    });
  }
  if (parsed.data.content.id !== resourceId || parsed.data.content.resourceType !== parsed.data.type) {
    return err({
      code: "REFERENCE_KEY_MISMATCH",
      message: "canonical content identity does not match the fhir_resources row"
    });
  }
  return ok(parsed.data);
}

interface StoredProjection {
  readonly edges: readonly ExplicitReference[];
  readonly metadataMatches: boolean;
  readonly head: z.infer<typeof projectionHeadSchema> | null;
}

async function readStoredProjection(
  sql: TenantSql,
  resourceId: string,
  expectedType: string,
  expectedVersionId: string
): Promise<StoredProjection> {
  const rows = await sql`
    select source_resource_type, source_version_id::text as source_version_id,
      json_path, target_resource_type, target_resource_id, target_version_id, edge_kind
    from fhir_reference_edges
    where source_resource_id = ${resourceId}
    order by json_path, target_resource_type, target_resource_id`;
  const parsedRows = rows.map((row) => storedEdgeSchema.parse(row));
  const edges = parsedRows.map((row) => ({
    jsonPath: row.json_path,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    targetVersionId: row.target_version_id
  }));
  const metadataMatches = parsedRows.every(
    (row) =>
      row.source_resource_type === expectedType &&
      row.source_version_id === expectedVersionId &&
      row.edge_kind === "explicit"
  );
  const headRows = await sql`
    select source_resource_type, source_version_id::text as source_version_id,
      edge_count, projection_digest
    from fhir_reference_projection_heads
    where source_resource_id = ${resourceId}`;
  const parsedHead = projectionHeadSchema.safeParse(headRows[0]);
  return { edges, metadataMatches, head: parsedHead.success ? parsedHead.data : null };
}

/** Replace every projected reference for the current canonical version. */
export async function replaceReferenceEdgesTx(
  sql: TenantSql,
  resourceId: string
): Promise<Result<ReferenceProjectionSummary, ReferenceProjectionError>> {
  const parsedId = resourceIdSchema.safeParse(resourceId);
  if (!parsedId.success) {
    return err({ code: "REFERENCE_INVALID_INPUT", message: "resourceId must be a UUID" });
  }
  const fetched = await fetchCanonical(sql, parsedId.data);
  if (!fetched.ok) return fetched;
  const edges = extractExplicitReferences(fetched.data.content);
  const digest = digestProjection(fetched.data.type, fetched.data.version_id, edges);

  // Extraction and identity checks complete before the first DML statement.
  // From here, a database failure throws and the tenant transaction rolls back.
  await sql`delete from fhir_reference_edges where source_resource_id = ${parsedId.data}`;
  await sql`
    delete from fhir_reference_projection_heads
    where source_resource_id = ${parsedId.data}`;
  const practice = sql`(select safe_uuid(current_setting('app.current_practice_id', true)))`;
  for (const edge of edges) {
    await sql`
      insert into fhir_reference_edges
        (practice_id, source_resource_id, source_resource_type, source_version_id,
         json_path, target_resource_type, target_resource_id, target_version_id, edge_kind)
      values (${practice}, ${parsedId.data}, ${fetched.data.type},
        ${fetched.data.version_id}::bigint, ${edge.jsonPath}, ${edge.targetResourceType},
        ${edge.targetResourceId}, ${edge.targetVersionId}, 'explicit')`;
  }
  await sql`
    insert into fhir_reference_projection_heads
      (practice_id, source_resource_id, source_resource_type, source_version_id,
       edge_count, projection_digest)
    values (${practice}, ${parsedId.data}, ${fetched.data.type},
      ${fetched.data.version_id}::bigint, ${edges.length}, ${digest})`;
  return ok({
    edgeCount: edges.length,
    sourceVersionId: fetched.data.version_id,
    digest
  });
}

/**
 * Zero-model parity receipt: compare materialized rows with a fresh extraction
 * from canonical JSON, byte-for-byte after deterministic canonicalization.
 */
export async function compareReferenceProjectionTx(
  sql: TenantSql,
  resourceId: string
): Promise<Result<ReferenceProjectionComparison, ReferenceProjectionError>> {
  const parsedId = resourceIdSchema.safeParse(resourceId);
  if (!parsedId.success) {
    return err({ code: "REFERENCE_INVALID_INPUT", message: "resourceId must be a UUID" });
  }
  const fetched = await fetchCanonical(sql, parsedId.data);
  if (!fetched.ok) return fetched;
  const fresh = extractExplicitReferences(fetched.data.content);
  const stored = await readStoredProjection(
    sql,
    parsedId.data,
    fetched.data.type,
    fetched.data.version_id
  );
  const storedSourceType = stored.head?.source_resource_type ?? fetched.data.type;
  const storedSourceVersion = stored.head?.source_version_id ?? fetched.data.version_id;
  const storedDigest = digestProjection(storedSourceType, storedSourceVersion, stored.edges);
  const freshDigest = digestProjection(fetched.data.type, fetched.data.version_id, fresh);
  const headMatches =
    stored.head !== null &&
    stored.head.source_resource_type === fetched.data.type &&
    stored.head.source_version_id === fetched.data.version_id &&
    stored.head.edge_count === stored.edges.length &&
    stored.head.projection_digest === storedDigest;
  return ok({
    equal: stored.metadataMatches && headMatches && storedDigest === freshDigest,
    headPresent: stored.head !== null,
    storedEdgeCount: stored.edges.length,
    freshEdgeCount: fresh.length,
    storedDigest,
    freshDigest,
    sourceVersionId: fetched.data.version_id,
    storedSourceVersionId: stored.head?.source_version_id ?? null
  });
}
