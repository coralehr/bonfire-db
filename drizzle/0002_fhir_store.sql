-- BF-02 canonical FHIR store: fhir_resources (latest) + history (append-only,
-- one row per version including v1) + write_inputs (verbatim raw payload, 1:1
-- with fhir_resources) + seed_completions (manifest-hash seed marker).
--
-- Every table: practice_id uuid NOT NULL, ENABLE + FORCE ROW LEVEL SECURITY,
-- ONE permissive policy FOR ALL TO bonfire_app on the InitPlan safe_uuid
-- template (garbage/unset tenant context folds to NULL => ZERO rows, never an
-- error, never all rows).
--
-- Append-only is a PRIVILEGE-layer guarantee: the initdb ALTER DEFAULT
-- PRIVILEGES pre-grants UPDATE/DELETE to bonfire_app on every new table, so
-- the explicit REVOKEs on history / write_inputs / seed_completions below are
-- load-bearing, not decorative.
CREATE TABLE "fhir_resources" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"practice_id" uuid NOT NULL,
	"version_id" bigint NOT NULL,
	"last_updated" timestamptz NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "fhir_resources_type_id_unique" UNIQUE ("type", "id")
);
--> statement-breakpoint
CREATE TABLE "history" (
	"id" uuid NOT NULL,
	"version_id" bigint NOT NULL,
	"type" text NOT NULL,
	"practice_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"last_updated" timestamptz NOT NULL,
	CONSTRAINT "history_pkey" PRIMARY KEY ("id", "version_id")
);
--> statement-breakpoint
CREATE TABLE "write_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"practice_id" uuid NOT NULL,
	"fhir_resource_id" uuid NOT NULL,
	"raw_payload" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "write_inputs_fhir_resource_id_unique" UNIQUE ("fhir_resource_id"),
	CONSTRAINT "write_inputs_fhir_resource_id_fkey" FOREIGN KEY ("fhir_resource_id") REFERENCES "fhir_resources" ("id")
);
--> statement-breakpoint
CREATE TABLE "seed_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"practice_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"completed_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "seed_completions_practice_manifest_unique" UNIQUE ("practice_id", "manifest_hash")
);
--> statement-breakpoint
CREATE INDEX "fhir_resources_practice_id_idx" ON "fhir_resources" ("practice_id");
--> statement-breakpoint
CREATE INDEX "fhir_resources_practice_type_updated_idx" ON "fhir_resources" ("practice_id", "type", "last_updated");
--> statement-breakpoint
CREATE INDEX "history_practice_id_idx" ON "history" ("practice_id");
--> statement-breakpoint
CREATE INDEX "write_inputs_practice_id_idx" ON "write_inputs" ("practice_id");
--> statement-breakpoint
ALTER TABLE "fhir_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fhir_resources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "write_inputs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "write_inputs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "seed_completions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "seed_completions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fhir_resources_tenant_isolation" ON "fhir_resources"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
CREATE POLICY "history_tenant_isolation" ON "history"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
CREATE POLICY "write_inputs_tenant_isolation" ON "write_inputs"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
CREATE POLICY "seed_completions_tenant_isolation" ON "seed_completions"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fhir_resources" TO "bonfire_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "history" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "history" FROM "bonfire_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "write_inputs" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "write_inputs" FROM "bonfire_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "seed_completions" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "seed_completions" FROM "bonfire_app";
