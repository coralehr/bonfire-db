-- BP-014 hardening (operator prep commit, BEFORE BF-02 stamps the policy
-- template onto fhir_resources/history/write_inputs).
--
-- Failure class: a garbage (non-UUID, non-empty) app.current_practice_id made
-- the bare ::uuid cast in the policy predicate raise 22P02 on every query —
-- tenant scoping degraded into an error channel. Invariant: garbage tenant
-- context folds to NULL, and a NULL predicate returns ZERO rows, never an
-- error.
--
-- safe_uuid is STABLE to match pg_input_is_valid's volatility. The (SELECT ...)
-- wrap in the policy makes the predicate an InitPlan — computed once per query,
-- not per row — the caching pattern the plan locks.
CREATE FUNCTION "safe_uuid"(value text) RETURNS uuid
	LANGUAGE sql STABLE PARALLEL SAFE
	RETURN CASE WHEN value IS NULL THEN NULL
		WHEN pg_input_is_valid(value, 'uuid') THEN value::uuid
		ELSE NULL END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "safe_uuid"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "safe_uuid"(text) TO "bonfire_app";
--> statement-breakpoint
DROP POLICY "rls_scaffold_tenant_isolation" ON "rls_scaffold";
--> statement-breakpoint
CREATE POLICY "rls_scaffold_tenant_isolation" ON "rls_scaffold"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
