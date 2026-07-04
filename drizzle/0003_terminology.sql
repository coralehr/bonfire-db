-- BF-03 terminology reference tables (operator prep — drizzle/** is off the
-- maker floor). GLOBAL reference data: vocabularies are shared, NOT tenant PHI,
-- so these tables carry NO practice_id and NO RLS (the fail-closed RLS posture
-- is for tenant rows; reference data is world-readable within the DB).
--
-- The app role gets SELECT ONLY. initdb's ALTER DEFAULT PRIVILEGES pre-grants
-- bonfire_app INSERT/UPDATE/DELETE on every future table, so the REVOKEs are
-- load-bearing: the terminology loader connects as the migration owner to
-- populate these, and the runtime app role can only read them (validate-on-write
-- is a pure membership SELECT, never a write).
CREATE TABLE "terminology_pack" (
	"name" text PRIMARY KEY,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text NOT NULL,
	"license" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminology_concept" (
	"system" text NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"version" text NOT NULL,
	PRIMARY KEY ("system", "code")
);
--> statement-breakpoint
CREATE INDEX "terminology_concept_system_idx" ON "terminology_concept" ("system");
--> statement-breakpoint
GRANT SELECT ON "terminology_pack" TO "bonfire_app";
--> statement-breakpoint
GRANT SELECT ON "terminology_concept" TO "bonfire_app";
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "terminology_pack" FROM "bonfire_app";
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "terminology_concept" FROM "bonfire_app";
