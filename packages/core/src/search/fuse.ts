/**
 * The ONE fused hybrid retrieval query: a BM25-style lexical arm (ts_rank_cd over
 * the GIN tsvector) and a pgvector HNSW semantic arm, combined by Reciprocal Rank
 * Fusion in SQL. The scope predicate (`resource_type = any(allowed)`) is INLINE in
 * each arm's base WHERE — RLS supplies the practice_id predicate automatically
 * (search_doc is FORCE-RLS), so this never writes `where practice_id`. BOTH arms
 * and the final join filter `model_id` to the ACTIVE embedder's model, so the
 * semantic space is never mixed and a non-default embedder is not silently zeroed.
 *
 * Trap-hardened (each proven on-host): each arm wraps a nested ORDER BY..LIMIT
 * subquery in row_number() (so the HNSW/GIN index drives the scan); RRF uses FLOAT
 * `1.0/` division; the scope filter is inlined (never a materialized CTE); the
 * query vector is bound as a text literal and cast ::vector; the semantic arm is
 * dropped entirely for a zero-norm query. The row_number() windows and the final
 * fusion ORDER BY carry the `resource_id` tiebreak for a total, deterministic
 * order; the inner per-arm ORDER BY is the bare index-driving expression (the
 * `<=>` distance / `ts_rank_cd`) so HNSW/GIN serve it, and every ORDER BY key is a
 * real column, never a text output alias (BP-033).
 */
import type { Fragment } from "postgres";
import { z } from "zod";
import type { TenantSql } from "../db/tenant.js";

/** RRF constant: score = sum(1.0 / (K + rank)). */
const RRF_K = 60;
/** Per-arm candidate cap before fusion. */
const ARM_LIMIT = 40;
/** pgvector iterative-scan working set, set transaction-locally. */
const HNSW_EF_SEARCH = "100";

export interface FusedHit {
  readonly resourceId: string;
  readonly resourceType: string;
  readonly sourcePath: string;
  readonly versionId: string;
  readonly lastUpdated: string;
  readonly score: number;
}

const fusedRowSchema = z.object({
  resource_id: z.uuid(),
  resource_type: z.string(),
  source_path: z.string(),
  source_version_id: z.string(),
  last_updated: z.string(),
  rrf_score: z.number()
});

function toFusedHit(row: unknown): FusedHit {
  const r = fusedRowSchema.parse(row);
  return {
    resourceId: r.resource_id,
    resourceType: r.resource_type,
    sourcePath: r.source_path,
    versionId: r.source_version_id,
    lastUpdated: r.last_updated,
    score: r.rrf_score
  };
}

/** Lexical arm: GIN @@ filter + ts_rank_cd, index-driven via the nested LIMIT. */
function lexicalCte(
  sql: TenantSql,
  query: string,
  allowed: readonly string[],
  modelId: string
): Fragment {
  return sql`lexical as (
    select resource_id, row_number() over (order by score desc, resource_id) as rank
    from (
      select search_doc.resource_id as resource_id,
        ts_rank_cd(search_doc.content_tsv, q) as score
      from search_doc, websearch_to_tsquery('simple', ${query}) q
      where search_doc.resource_type = any(${[...allowed]}::text[])
        and search_doc.model_id = ${modelId}
        and search_doc.content_tsv @@ q
      order by score desc, search_doc.resource_id
      limit ${ARM_LIMIT}
    ) lex
  )`;
}

/** Semantic arm (or empty for a zero-norm query): HNSW <=> over one model space. */
function semanticCte(
  sql: TenantSql,
  qvec: string | null,
  allowed: readonly string[],
  modelId: string
): Fragment {
  if (qvec === null) return sql``;
  return sql`, semantic as (
    select resource_id, row_number() over (order by dist asc, resource_id) as rank
    from (
      select search_doc.resource_id as resource_id,
        search_doc.embedding <=> ${qvec}::vector as dist
      from search_doc
      where search_doc.resource_type = any(${[...allowed]}::text[])
        and search_doc.model_id = ${modelId}
      order by search_doc.embedding <=> ${qvec}::vector
      limit ${ARM_LIMIT}
    ) sem
  )`;
}

function armsUnion(sql: TenantSql, withVector: boolean): Fragment {
  const lexical = sql`select resource_id, rank from lexical`;
  return withVector ? sql`${lexical} union all select resource_id, rank from semantic` : lexical;
}

/**
 * Run the fused search inside the caller's tenant tx. Sets the HNSW scan tuning
 * transaction-locally (never a session SET — pooled bleed, BP-005).
 */
export async function fuseSearch(
  sql: TenantSql,
  params: {
    readonly query: string;
    /** Pre-serialized `[a,b,c]` query vector, or null for a lexical-only search. */
    readonly qvec: string | null;
    readonly allowed: readonly string[];
    /** The active embedder's model id — both arms + the join scope to this space. */
    readonly modelId: string;
    readonly topN: number;
  }
): Promise<readonly FusedHit[]> {
  await sql`select set_config('hnsw.iterative_scan', 'strict_order', true)`;
  await sql`select set_config('hnsw.ef_search', ${HNSW_EF_SEARCH}, true)`;
  const rows = await sql`
    with ${lexicalCte(sql, params.query, params.allowed, params.modelId)}${semanticCte(sql, params.qvec, params.allowed, params.modelId)},
    fused as (
      select resource_id, sum(1.0 / (${RRF_K} + rank)) as rrf_score
      from (${armsUnion(sql, params.qvec !== null)}) arms
      group by resource_id
    )
    select sd.resource_id::text as resource_id, sd.resource_type,
      sd.source_path, sd.source_version_id::text as source_version_id,
      sd.last_updated::text as last_updated, fused.rrf_score::float8 as rrf_score
    from fused
    join search_doc sd
      on sd.resource_id = fused.resource_id and sd.model_id = ${params.modelId}
    order by fused.rrf_score desc, sd.resource_id
    limit ${params.topN}`;
  return rows.map(toFusedHit);
}
