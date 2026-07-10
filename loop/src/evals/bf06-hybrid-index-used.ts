/**
 * Execution eval bf06-hybrid-index-used (BF-06 acceptance 2/8; architecture guard).
 *
 * An INDEPENDENT oracle re-derives the documented fused RRF query shape (lexical
 * ts_rank_cd over the GIN tsvector, semantic <=> over HNSW, UNION ALL + sum(1.0/
 * (K+rank))) and asserts, over the LIVE stack as bonfire_app with enable_seqscan
 * =off, that: the HNSW index IS in the plan (the semantic arm is genuinely index-
 * driven), the lexical arm is wired to the GIN-backed `content_tsv @@` predicate,
 * RRF float fusion is applied, the inline resource_type scope predicate and the
 * RLS safe_uuid GUC predicate are both in the retrieval, and NO scan touches
 * fhir_resources. Both physical indexes are also confirmed present in the catalog.
 *
 * HONEST-SCOPE (on-host de-risk + critic C2): at a golden-fixture corpus the
 * planner SEQ-scans the lexical arm even with enable_seqscan=off — a GIN bitmap
 * over a tiny table costs more than the penalized seq scan — so whether the GIN
 * index is *chosen* is a production-scale property, not assertable here. The HNSW
 * index IS reliably chosen (proven live). We therefore pin the HNSW plan node, the
 * GIN-backed lexical predicate, and the catalog presence of both indexes.
 *
 * Inversion: dropping the HNSW index (or a row_number-over-the-table rewrite that
 * drops it), removing content_tsv, or dropping the scope/RLS predicate -> red.
 */
import postgres from "postgres";
import { observation, seed } from "./bf06-search-util.js";
import { appUrl, fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-hybrid-index-used";
const DIM = 384;
const CORPUS_SIZE = 20;
const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practice = crypto.randomUUID();
const qvec = `[${Array.from({ length: DIM }, (_unused, i) => (i === 0 ? 1 : 0)).join(",")}]`;
const rareTerm = "zzselective42";

try {
  const corpus = Array.from({ length: CORPUS_SIZE }, (_unused, i) =>
    observation(i === 0 ? rareTerm : `zzfiller${String(i)}`, "shared clinical filler note text")
  );
  seed(EVAL_ID, practice, corpus);

  // Both physical indexes must exist (the 0009 migration created them).
  const idx = (await app`select indexname from pg_indexes where tablename = 'search_doc'`).map(
    (r) => (r as { indexname: string }).indexname
  );
  for (const name of ["search_doc_hnsw", "search_doc_tsv_gin"]) {
    if (!idx.includes(name))
      fail(EVAL_ID, `index ${name} is missing from search_doc: ${JSON.stringify(idx)}`);
  }

  const plan = await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', ${practice}, true)`;
    await sql`set local enable_seqscan = off`;
    const rows = await sql`explain (costs off)
      with lexical as (
        select resource_id, row_number() over (order by score desc, resource_id) as rank from (
          select search_doc.resource_id, ts_rank_cd(search_doc.content_tsv, q) as score
          from search_doc, websearch_to_tsquery('simple', ${rareTerm}) q
          where search_doc.resource_type = any(array['Observation']::text[])
            and search_doc.model_id = 'dev-hash-v1' and search_doc.content_tsv @@ q
          order by score desc, search_doc.resource_id limit 40) lex),
      semantic as (
        select resource_id, row_number() over (order by dist asc, resource_id) as rank from (
          select search_doc.resource_id, search_doc.embedding <=> ${qvec}::vector as dist
          from search_doc where search_doc.resource_type = any(array['Observation']::text[])
            and search_doc.model_id = 'dev-hash-v1'
          order by search_doc.embedding <=> ${qvec}::vector limit 40) sem),
      fused as (select resource_id, sum(1.0/(60+rank)) as rrf from (
        select resource_id, rank from lexical union all select resource_id, rank from semantic) a group by resource_id)
      select sd.resource_id from fused join search_doc sd
        on sd.resource_id = fused.resource_id and sd.model_id = 'dev-hash-v1'
      order by fused.rrf desc, sd.resource_id limit 20`;
    return (rows as unknown as { ["QUERY PLAN"]: string }[]).map((r) => r["QUERY PLAN"]).join("\n");
  });

  const checks: [string, boolean][] = [
    ["HNSW index in the semantic arm", plan.includes("Index Scan using search_doc_hnsw")],
    ["lexical arm wired to the GIN content_tsv predicate", plan.includes("content_tsv @@")],
    // The only aggregate ("Aggregate" excludes the row_number WindowAgg) computes
    // the fused score. Plan shape follows the SHARED search_doc's stats, so the
    // planner renders the fused Sort Key as either the `rrf` alias or an inlined
    // `sum(1.0/...)`; the old literal-`1.0`+`Hash|GroupAggregate` check went falsely
    // red on the alias form. Float-vs-int RRF (T1) is covered by the ranking evals.
    [
      "RRF fusion aggregate",
      plan.includes("Aggregate") && (plan.includes("rrf") || plan.includes("1.0"))
    ],
    ["inline resource_type scope predicate", plan.includes("resource_type")],
    ["RLS safe_uuid GUC predicate", /InitPlan|safe_uuid|current_setting/.test(plan)],
    ["no fhir_resources scan", !plan.includes("fhir_resources")]
  ];
  const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failures.length > 0)
    fail(EVAL_ID, `plan missing: ${failures.join("; ")}\n--- plan ---\n${plan}`);

  pass(
    EVAL_ID,
    "HNSW index driven + GIN content_tsv predicate + RRF fusion + inline scope + RLS; both indexes present; no fhir_resources scan"
  );
} finally {
  await app.end({ timeout: 5 });
}
