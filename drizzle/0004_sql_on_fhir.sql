-- BF-04 SQL-on-FHIR read surface (operator prep — drizzle/** is off the maker
-- floor).
--
-- 1) spidx: ONE tall fixed-schema search-parameter index over the supported
--    US Core params of the scribe resources (v0 scope: subject/patient
--    REFERENCE params + code/clinical-status/identifier TOKEN params; the
--    date_low/date_high columns are schema-reserved but date-range, partial-
--    date and composite params are declared OUT OF SCOPE — see the SQL-on-FHIR
--    ADRs). Rows are derived from canonical fhir_resources and rebuilt by the
--    offline projections:rebuild task; equality-lookup parity with a JSONB
--    scan is test-enforced.
--
--    vd_* and spidx are WRITABLE projections (rebuilt offline AND upserted
--    inside the canonical write tx), so the initdb ALTER DEFAULT PRIVILEGES
--    S/I/U/D pre-grant STAYS — do NOT copy the append-only REVOKE lines used
--    by history/write_inputs. Tenant safety is the verbatim BF-02 template:
--    practice_id NOT NULL + ENABLE+FORCE RLS + ONE permissive policy on the
--    InitPlan safe_uuid GUC predicate (garbage/unset context folds to NULL =>
--    ZERO rows, never an error, never all rows) with WITH CHECK.
CREATE TABLE "spidx" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"practice_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"param_name" text NOT NULL,
	"param_type" text NOT NULL,
	"token_system" text,
	"token_code" text,
	"ref_value" text,
	"date_low" text,
	"date_high" text
);
--> statement-breakpoint
-- Partial btrees: one per supported param_type, practice_id-first so the RLS
-- InitPlan predicate rides the index; plus the rebuild/upsert delete path.
CREATE INDEX "spidx_token_idx" ON "spidx"
	("practice_id", "resource_type", "param_name", "token_code", "token_system")
	WHERE "param_type" = 'token';
--> statement-breakpoint
CREATE INDEX "spidx_reference_idx" ON "spidx"
	("practice_id", "resource_type", "param_name", "ref_value")
	WHERE "param_type" = 'reference';
--> statement-breakpoint
CREATE INDEX "spidx_resource_idx" ON "spidx" ("practice_id", "resource_id");
--> statement-breakpoint
ALTER TABLE "spidx" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spidx" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "spidx_tenant_isolation" ON "spidx"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "spidx" TO "bonfire_app";
--> statement-breakpoint
-- 2) projection_rls_ratchet: ddl_command_end event trigger stamping
--    ENABLE+FORCE RLS and the tenant-isolation policy onto EVERY runtime-
--    created public.vd_* / public.spidx* table. The vd_* DDL runs as the
--    migration owner inside the offline projections:rebuild task; if that DDL
--    generator ever forgets the RLS template, this trigger closes the gap
--    structurally (belt-and-suspenders to the catalog-invariant gate test in
--    tests/sql-on-fhir; also pins the ADP fail-open class for projections). A
--    projection table WITHOUT a practice_id column fails the policy CREATE and
--    therefore fails its own CREATE TABLE — fail-closed by construction.
--    Event triggers are superuser-only DDL, so this MUST live in a migration
--    (owner-run), never in app code. The policy guard checks for ANY existing
--    policy on the table so a future template change cannot double-create.
CREATE FUNCTION "enforce_projection_rls"() RETURNS event_trigger
	LANGUAGE plpgsql AS $trg$
DECLARE
	obj record;
	tbl text;
BEGIN
	FOR obj IN
		SELECT object_identity FROM pg_event_trigger_ddl_commands()
		WHERE command_tag = 'CREATE TABLE'
			AND object_identity ~ '^public\.(vd_|spidx)'
	LOOP
		tbl := split_part(obj.object_identity, '.', 2);
		EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
		EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.object_identity);
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl
		) THEN
			EXECUTE format(
				'CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO "bonfire_app"
					USING ("practice_id" = (SELECT safe_uuid(current_setting(''app.current_practice_id'', true))))
					WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting(''app.current_practice_id'', true))))',
				tbl || '_tenant_isolation',
				obj.object_identity
			);
		END IF;
	END LOOP;
END
$trg$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "enforce_projection_rls"() FROM PUBLIC;
--> statement-breakpoint
CREATE EVENT TRIGGER "projection_rls_ratchet" ON ddl_command_end
	WHEN TAG IN ('CREATE TABLE')
	EXECUTE FUNCTION "enforce_projection_rls"();
