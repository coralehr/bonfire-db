-- A head row makes an intentionally empty projection distinguishable from a
-- resource that was never projected, and binds parity to the canonical source
-- version even when a version update leaves its references unchanged.
CREATE TABLE "fhir_reference_projection_heads" (
	"practice_id" uuid NOT NULL,
	"source_resource_id" uuid NOT NULL,
	"source_resource_type" text NOT NULL,
	"source_version_id" bigint NOT NULL,
	"edge_count" integer NOT NULL,
	"projection_digest" text NOT NULL,
	CONSTRAINT "fhir_reference_projection_heads_pkey" PRIMARY KEY ("practice_id", "source_resource_id"),
	CONSTRAINT "fhir_reference_projection_heads_source_fkey" FOREIGN KEY ("practice_id", "source_resource_id") REFERENCES "fhir_resources" ("practice_id", "id") ON DELETE CASCADE,
	CONSTRAINT "fhir_reference_projection_heads_type_nonempty" CHECK (length("source_resource_type") > 0),
	CONSTRAINT "fhir_reference_projection_heads_count_nonnegative" CHECK ("edge_count" >= 0),
	CONSTRAINT "fhir_reference_projection_heads_digest_sha256" CHECK ("projection_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fhir_reference_projection_heads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fhir_reference_projection_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fhir_reference_projection_heads_tenant_isolation" ON "fhir_reference_projection_heads"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "fhir_reference_projection_heads" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE ON "fhir_reference_projection_heads" FROM "bonfire_app";
