-- BP-019 (unique-constraint-existence-oracle): PK/UNIQUE/FK enforcement bypasses
-- RLS BY DESIGN (Postgres docs: unique and referential constraints "always
-- bypass row security" — a documented covert channel). A tenant supplying its
-- own resource id got a distinguishable 23505 when that id existed in ANOTHER
-- practice: a cross-tenant id-existence probe + id-squatting DoS.
--
-- Fix: tenant-scoped identity. Every uniqueness scope on a client-influenceable
-- value now leads with practice_id, so each practice is its own FHIR logical-id
-- namespace (matching FHIR's per-server id scope and the partitioned-tenant
-- model of the major hosted FHIR platforms). A cross-tenant duplicate id simply
-- SUCCEEDS as the probing tenant's own row — the probe transfers zero bits.
--
-- history and write_inputs are re-keyed too: fixing only fhir_resources would
-- MOVE the oracle down one table (history PK (id, version_id); write_inputs
-- UNIQUE (fhir_resource_id)), not close it. The write_inputs FK becomes
-- composite so referential checks cannot see across tenants either.
ALTER TABLE "write_inputs" DROP CONSTRAINT "write_inputs_fhir_resource_id_fkey";
--> statement-breakpoint
ALTER TABLE "write_inputs" DROP CONSTRAINT "write_inputs_fhir_resource_id_unique";
--> statement-breakpoint
ALTER TABLE "fhir_resources" DROP CONSTRAINT "fhir_resources_type_id_unique";
--> statement-breakpoint
ALTER TABLE "fhir_resources" DROP CONSTRAINT "fhir_resources_pkey";
--> statement-breakpoint
ALTER TABLE "fhir_resources" ADD CONSTRAINT "fhir_resources_pkey" PRIMARY KEY ("practice_id", "id");
--> statement-breakpoint
ALTER TABLE "history" DROP CONSTRAINT "history_pkey";
--> statement-breakpoint
ALTER TABLE "history" ADD CONSTRAINT "history_pkey" PRIMARY KEY ("practice_id", "id", "version_id");
--> statement-breakpoint
ALTER TABLE "write_inputs" ADD CONSTRAINT "write_inputs_practice_fhir_resource_unique" UNIQUE ("practice_id", "fhir_resource_id");
--> statement-breakpoint
ALTER TABLE "write_inputs" ADD CONSTRAINT "write_inputs_fhir_resource_id_fkey" FOREIGN KEY ("practice_id", "fhir_resource_id") REFERENCES "fhir_resources" ("practice_id", "id");
--> statement-breakpoint
-- The PK now leads with practice_id; the single-column tenant index is redundant.
DROP INDEX "fhir_resources_practice_id_idx";
