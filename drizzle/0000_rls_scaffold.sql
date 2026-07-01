-- BF-01 row-zero RLS scaffolding: fail-closed default-deny tenant isolation.
--
-- ONE policy, FOR ALL TO bonfire_app, with BOTH USING and WITH CHECK pinned to
-- the transaction-local GUC app.current_practice_id. The NULLIF wrap is
-- mandatory: an unset GUC yields NULL and an explicitly-empty GUC yields ''
-- which NULLIF folds to NULL — either way the predicate is NULL => ZERO rows,
-- never an error, never all rows. No other policies exist (default-deny).
CREATE TABLE "rls_scaffold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"practice_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "rls_scaffold_practice_id_created_at_idx" ON "rls_scaffold" ("practice_id", "created_at");
--> statement-breakpoint
ALTER TABLE "rls_scaffold" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rls_scaffold" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rls_scaffold_tenant_isolation" ON "rls_scaffold"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = NULLIF(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK ("practice_id" = NULLIF(current_setting('app.current_practice_id', true), '')::uuid);
