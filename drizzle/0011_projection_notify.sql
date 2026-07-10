-- BF-08 reactivity substrate (operator prep — drizzle/** is off the maker
-- floor): every vd_* projection change emits a wake-up NOTIFY on ONE channel,
-- 'bonfire_projection_change', whose payload is ONLY the table name.
--
-- Why a constant, tenant-free payload: LISTEN channels have no ACLs and any
-- connected role can pg_notify any channel (spoofable), so a payload carrying
-- practice_id would (a) broadcast cross-tenant activity timing to every
-- listener and (b) invite payload-trust bugs in subscribers. Subscribers treat
-- the notification as a wake-up ONLY and re-query through their own RLS-scoped
-- tenant transaction — tenant scoping of DATA is enforced by RLS, never by the
-- wire; a spoofed NOTIFY is a harmless re-query.
--
-- Why FOR EACH STATEMENT: NOTIFY dedups identical payloads within a
-- transaction, so a full projections:rebuild collapses to one delivery per
-- table per transaction and the cluster-wide NOTIFY commit lock stays cold.
--
-- Why an event trigger (0004/0005 ratchet pattern): projections:rebuild
-- DROPs and recreates vd_* tables, which would silently shed a hand-attached
-- trigger. Stamping on ddl_command_end keeps every current AND future vd_*
-- projection reactive with no per-view migration. Strict posture (a failed
-- attach rolls back the DDL) matches projection_rls_ratchet: a vd_* table
-- without its notify trigger is a silent-staleness bug we refuse to create.
-- Proven live 2026-07-10: trigger survives rebuild; delivery at commit only;
-- ~2ms listener latency at dev scale.
CREATE OR REPLACE FUNCTION "notify_projection_change"() RETURNS trigger
	LANGUAGE plpgsql AS $fn$
BEGIN
	PERFORM pg_notify('bonfire_projection_change', TG_TABLE_NAME);
	RETURN NULL;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "notify_projection_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "attach_projection_notify"() RETURNS event_trigger
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
			AND lower(c.relname) ~ '^vd_'
	LOOP
		EXECUTE format(
			'CREATE OR REPLACE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
				FOR EACH STATEMENT EXECUTE FUNCTION "notify_projection_change"()',
			obj.relname || '_notify',
			obj.relname
		);
	END LOOP;
END
$trg$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "attach_projection_notify"() FROM PUBLIC;
--> statement-breakpoint
DROP EVENT TRIGGER IF EXISTS "projection_notify_ratchet";
--> statement-breakpoint
CREATE EVENT TRIGGER "projection_notify_ratchet" ON ddl_command_end
	WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
	EXECUTE FUNCTION "attach_projection_notify"();
--> statement-breakpoint
DO $backfill$
DECLARE
	obj record;
BEGIN
	FOR obj IN
		SELECT c.relname
		FROM pg_class c
		WHERE c.relnamespace = 'public'::regnamespace
			AND c.relkind IN ('r', 'p')
			AND lower(c.relname) ~ '^vd_'
	LOOP
		EXECUTE format(
			'CREATE OR REPLACE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
				FOR EACH STATEMENT EXECUTE FUNCTION "notify_projection_change"()',
			obj.relname || '_notify',
			obj.relname
		);
	END LOOP;
END
$backfill$;
