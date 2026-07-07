-- BF-06 search_doc: the hybrid cited-search index surface (one sidecar table).
--
-- The typed vd_* projections carry almost no free clinical TEXT (names, MRNs,
-- units, URLs — no code displays, no notes), so cited search indexes its own
-- sidecar sourced from fhir_resources.content by an offline owner-run indexer.
-- ONE table holds BOTH arms of the hybrid: `content_tsv` (GIN) for the lexical
-- arm and `embedding` (HNSW) for the semantic arm, so a single RRF query fuses
-- them in one RLS-scoped plan. Deliberately NOT named vd_* / spidx*: the
-- projections:rebuild task pattern-DROPs those, and search_doc must survive a
-- rebuild — so it also does NOT inherit the 0004/0005 projection-RLS event
-- trigger (which only stamps vd_*/spidx*) and stamps its own FORCE-RLS below.
--
-- `embedding vector(384)` depends on the pgvector extension created at initdb
-- (docker/initdb/010-roles.sh) — the same initdb contract every migration
-- relies on for roles + safe_uuid's schema. `content_tsv` is a STORED generated
-- column: the 2-arg to_tsvector('simple', ...) is MANDATORY (the 1-arg form is
-- only STABLE and is rejected in a generated column). 'simple' (not 'english')
-- keeps exact codes/MRNs as precise lexemes — paraphrase is the vector arm's job.
--
-- Freshness is "projection as-of": last_updated / source_version_id are the
-- INDEXED resource's version, not live canonical (honest-scope, BF-04 precedent).
-- `model_id` scopes every read to one embedding space (never fuse across models)
-- and makes a future real self-hosted model a coexistence re-embed, not a break.
CREATE TABLE "search_doc" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"practice_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"source_path" text NOT NULL,
	"content_text" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"model_id" text NOT NULL,
	"source_version_id" bigint NOT NULL,
	"last_updated" timestamptz NOT NULL,
	"content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content_text")) STORED,
	-- A zero-length document embeds to a zero vector whose cosine distance is
	-- NaN (nondeterministic sort); forbid it at the DB layer.
	CONSTRAINT "search_doc_content_nonempty" CHECK (length("content_text") > 0)
);
--> statement-breakpoint
-- Semantic arm: HNSW over cosine distance. The scope/RLS predicate is applied
-- POST-scan (an HNSW index carries only the <=> order, never a scalar Index
-- Cond); pgvector 0.8 iterative index scans (set transaction-locally by the
-- search path) backfill top-k past that filter so a sparse tenant sharing the
-- table never silently under-returns.
CREATE INDEX "search_doc_hnsw" ON "search_doc" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- Lexical arm: GIN over the generated tsvector (ts_rank_cd cover-density rank).
CREATE INDEX "search_doc_tsv_gin" ON "search_doc" USING gin ("content_tsv");
--> statement-breakpoint
-- Verbatim BF-02/spidx tenant template: a garbage/unset GUC folds through
-- safe_uuid to NULL => the predicate is NULL => zero rows (fail-closed), never
-- an error channel. FORCE so the table owner is subject to it too; only the
-- superuser migration role (NOBYPASSRLS is false) is exempt.
ALTER TABLE "search_doc" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "search_doc" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "search_doc_tenant_isolation" ON "search_doc"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
-- BP-018: the flipped initdb ALTER DEFAULT PRIVILEGES grants SELECT,INSERT only.
-- search_doc is RE-EMBEDDABLE (the indexer DELETEs-by-resource_id + re-INSERTs),
-- so it needs UPDATE,DELETE explicitly — append-only immutability does not apply.
GRANT SELECT, INSERT, UPDATE, DELETE ON "search_doc" TO "bonfire_app";
