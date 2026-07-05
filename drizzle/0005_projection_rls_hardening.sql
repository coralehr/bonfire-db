-- BF-04 close-out hardening of the 0004 projection-RLS ratchet (operator —
-- drizzle/** is off the maker floor). Pins ratchet BP-029.
--
-- 0004 matched on the STRING object_identity ('^public\.(vd_|spidx)'), which a
-- quoted or mixed-case relname (public."VD_Evil") silently evades — and
-- split_part() kept the quotes, corrupting the policy lookup. Its WHEN TAG IN
-- ('CREATE TABLE') also never fired for CREATE TABLE AS / SELECT INTO. All
-- owner-only dodges (bonfire_app has no CREATE), closed here as
-- defense-in-depth: resolve relations via objid -> pg_class (never string
-- parsing), match lower(relname) case-insensitively, scope by relnamespace +
-- relkind, and widen the trigger tags. CREATE OR REPLACE preserves 0004's
-- REVOKE on the function; event triggers have no OR REPLACE form, so the
-- trigger itself is DROP + CREATE. Residual (accepted, owner-only): ALTER
-- TABLE ... RENAME TO vd_x / SET SCHEMA public are not covered by tags — the
-- widened catalog sweep in tests/sql-on-fhir/rls-vd.test.ts remains the
-- mandatory structural control for those.
CREATE OR REPLACE FUNCTION "enforce_projection_rls"() RETURNS event_trigger
	LANGUAGE plpgsql AS $trg$
DECLARE
	obj record;
BEGIN
	FOR obj IN
		SELECT c.relname
		FROM pg_event_trigger_ddl_commands() cmd
		JOIN pg_class c ON c.oid = cmd.objid
		WHERE cmd.classid = 'pg_class'::regclass
			AND c.relnamespace = 'public'::regnamespace
			AND c.relkind IN ('r', 'p')
			AND lower(c.relname) ~ '^(vd_|spidx)'
	LOOP
		EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', obj.relname);
		EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', obj.relname);
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE schemaname = 'public' AND tablename = obj.relname
		) THEN
			EXECUTE format(
				'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO "bonfire_app"
					USING ("practice_id" = (SELECT safe_uuid(current_setting(''app.current_practice_id'', true))))
					WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting(''app.current_practice_id'', true))))',
				obj.relname || '_tenant_isolation',
				obj.relname
			);
		END IF;
	END LOOP;
END
$trg$;
--> statement-breakpoint
DROP EVENT TRIGGER IF EXISTS "projection_rls_ratchet";
--> statement-breakpoint
CREATE EVENT TRIGGER "projection_rls_ratchet" ON ddl_command_end
	WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
	EXECUTE FUNCTION "enforce_projection_rls"();
