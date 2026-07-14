/**
 * The search projection primitive, invoked inside a tenant transaction. The
 * composed projected writer calls it synchronously after the typed views and
 * spidx; operators can also call it to re-index an existing canonical row.
 * It reads one `fhir_resources` row (RLS-scoped — an invisible resource is a
 * typed error, never an invented row), extracts searchable text, embeds it with
 * the self-hosted provider, and re-materializes the `search_doc` sidecar row
 * (DELETE-by-resource_id + INSERT, so re-indexing is idempotent). `practice_id`
 * is stamped from the GUC in SQL (never caller input), like every tenant write,
 * and `source_version_id`/`last_updated` are the indexed row's version
 * (freshness = projection as-of). `search_doc` survives projections:rebuild;
 * that independent rebuild lifecycle does not make governed writes dual-write.
 */
import { z } from "zod";
import { jsonValueSchema } from "../db/fhir-store.js";
import type { TenantSql } from "../db/tenant.js";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import { isSearchableType } from "./derive-scope.js";
import { devEmbedder } from "./dev-embedder.js";
import { extractSearchText } from "./extract-text.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "./schemas.js";

export type IndexErrorCode = "INDEX_INVALID_INPUT" | "INDEX_RESOURCE_NOT_FOUND";

export interface IndexSummary {
  /** False when the resource type is not searchable or yields no text (skipped). */
  readonly indexed: boolean;
}

const resourceIdSchema = z.uuid();
// The indexer's own row boundary (search_doc write path). Fields validate the
// canonical row read in-tenant: content for text extraction, version/timestamp
// for freshness-as-of, type for the searchable gate.
const canonicalRowSchema = z.object({
  content: z.record(z.string(), jsonValueSchema),
  last_updated: z.string().min(1),
  version_id: z.string().min(1),
  type: z.string().min(1)
});

/** Serialize a JS vector to pgvector's text form (`[a,b,c]`) — bound + cast ::vector. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export async function indexResourceTx(
  sql: TenantSql,
  resourceId: string,
  embedder: EmbeddingProvider = devEmbedder
): Promise<Result<IndexSummary, BonfireError<IndexErrorCode>>> {
  const parsedId = resourceIdSchema.safeParse(resourceId);
  if (!parsedId.success) {
    return err({ code: "INDEX_INVALID_INPUT", message: "resourceId must be a UUID" });
  }
  const rows = await sql`
    select type, version_id::text as version_id, last_updated::text as last_updated, content
    from fhir_resources where id = ${parsedId.data}`;
  const parsed = canonicalRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    return err({
      code: "INDEX_RESOURCE_NOT_FOUND",
      message: "resource not visible in this tenant"
    });
  }
  const { type, version_id: versionId, last_updated: lastUpdated, content } = parsed.data;
  // Replacement semantics include the empty case: an update that removes all
  // searchable content must not leave the prior version's text retrievable.
  await sql`delete from search_doc where resource_id = ${parsedId.data}`;
  if (!isSearchableType(type)) return ok({ indexed: false });
  const extracted = extractSearchText(type, content);
  if (extracted.text.length === 0) return ok({ indexed: false });
  if (embedder.dimension !== EMBEDDING_DIM) throw new Error("embedder dimension must be 384");
  const vector = await embedder.embed(extracted.text);
  if (vector.length !== EMBEDDING_DIM) throw new Error("embedding dimension mismatch");
  const vectorLiteral = toVectorLiteral(vector);
  const practice = sql`(select safe_uuid(current_setting('app.current_practice_id', true)))`;
  await sql`
    insert into search_doc
      (practice_id, resource_id, resource_type, source_path, content_text,
       embedding, model_id, source_version_id, last_updated)
    values (${practice}, ${parsedId.data}, ${type}, ${extracted.path}, ${extracted.text},
      ${vectorLiteral}::vector, ${embedder.modelId}, ${versionId}::bigint, ${lastUpdated}::timestamptz)`;
  return ok({ indexed: true });
}
