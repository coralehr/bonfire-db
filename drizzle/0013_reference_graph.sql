-- BF-10 reference graph projection: a rebuildable, tenant-scoped index of
-- same-server explicit FHIR Reference values. Canonical FHIR JSON remains the
-- source of truth; this table only makes bounded, cited traversal efficient.
--
-- The source FK is tenant-composite so referential checks cannot become a
-- cross-practice resource-id existence oracle (BP-019). Targets deliberately
-- have no FK: dangling FHIR references are valid evidence about missing data,
-- and checking them at write time would both reject canonical input and create
-- another existence side channel.
CREATE TABLE "fhir_reference_edges" (
	"practice_id" uuid NOT NULL,
	"source_resource_id" uuid NOT NULL,
	"source_resource_type" text NOT NULL,
	"source_version_id" bigint NOT NULL,
	"json_path" text NOT NULL,
	"target_resource_type" text NOT NULL,
	"target_resource_id" text NOT NULL,
	"target_version_id" text,
	"edge_kind" text DEFAULT 'explicit' NOT NULL,
	CONSTRAINT "fhir_reference_edges_pkey" PRIMARY KEY ("practice_id", "source_resource_id", "json_path"),
	CONSTRAINT "fhir_reference_edges_source_fkey" FOREIGN KEY ("practice_id", "source_resource_id") REFERENCES "fhir_resources" ("practice_id", "id") ON DELETE CASCADE,
	CONSTRAINT "fhir_reference_edges_source_type_nonempty" CHECK (length("source_resource_type") > 0),
	CONSTRAINT "fhir_reference_edges_json_path_pointer" CHECK (left("json_path", 1) = '/'),
	CONSTRAINT "fhir_reference_edges_target_type_nonempty" CHECK (length("target_resource_type") > 0),
	CONSTRAINT "fhir_reference_edges_target_id_nonempty" CHECK (length("target_resource_id") > 0),
	CONSTRAINT "fhir_reference_edges_explicit_only" CHECK ("edge_kind" = 'explicit')
);
--> statement-breakpoint
CREATE INDEX "fhir_reference_edges_source_idx" ON "fhir_reference_edges" ("practice_id", "source_resource_type", "source_resource_id");
--> statement-breakpoint
CREATE INDEX "fhir_reference_edges_target_idx" ON "fhir_reference_edges" ("practice_id", "target_resource_type", "target_resource_id");
--> statement-breakpoint
ALTER TABLE "fhir_reference_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fhir_reference_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fhir_reference_edges_tenant_isolation" ON "fhir_reference_edges"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "fhir_reference_edges" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE ON "fhir_reference_edges" FROM "bonfire_app";
