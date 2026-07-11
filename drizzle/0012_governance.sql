-- BF-09 propose -> approve -> commit governance: event-sourced, append-only.
--
-- Three tables, ZERO update paths. State is DERIVED from events (a commit
-- event implies committed; an approve event implies approved; else proposed),
-- so "immutable after commit" is a PRIVILEGE-layer guarantee, not app logic:
-- the app role gets SELECT,INSERT only (BP-018 initdb default + belt REVOKE),
-- and there is no state column to mutate. Illegal transitions are rejected in
-- code (packages/core/src/governance) with the UNIQUE constraints below as the
-- structural backstop under concurrency: (practice_id, proposal_id, action)
-- pins at most ONE approve and ONE commit event per proposal, and the
-- signed-note (practice_id, proposal_id) UNIQUE pins one note per proposal —
-- a double-commit race loses with 23505 and rolls back.
--
-- BP-019: every key leads with practice_id (tenant-scoped identity; row ids
-- are server-generated gen_random_uuid, never client-influenceable), so
-- constraint enforcement transfers zero cross-tenant bits.
--
-- The event's audit_row_hash carries the BF-05 audit chain row_hash of the
-- SAME transaction's allow decision row, binding each governance event to the
-- tamper-evident chain. It cannot be a FK (audit_log has no row_hash UNIQUE
-- and audit/** is frozen); the bf09 evals join it against audit_log instead.
CREATE TABLE "governance_proposal" (
	"practice_id" uuid NOT NULL,
	"id" uuid NOT NULL DEFAULT gen_random_uuid(),
	"proposer_actor_id" text NOT NULL,
	"proposer_role" text NOT NULL,
	"resource" jsonb NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "governance_proposal_pkey" PRIMARY KEY ("practice_id", "id"),
	CONSTRAINT "governance_proposal_actor_nonempty" CHECK (length("proposer_actor_id") > 0),
	CONSTRAINT "governance_proposal_role_nonempty" CHECK (length("proposer_role") > 0)
);
--> statement-breakpoint
-- 'reject' is deliberately NOT in the action CHECK: the rejected state exists
-- only in the pure state machine (no persistence path ships in v0). Widening
-- this CHECK is a future migration — fail-closed by default.
CREATE TABLE "governance_event" (
	"practice_id" uuid NOT NULL,
	"id" uuid NOT NULL DEFAULT gen_random_uuid(),
	"proposal_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"audit_row_hash" text NOT NULL,
	"occurred_at" timestamptz NOT NULL,
	CONSTRAINT "governance_event_pkey" PRIMARY KEY ("practice_id", "id"),
	CONSTRAINT "governance_event_proposal_action_unique" UNIQUE ("practice_id", "proposal_id", "action"),
	CONSTRAINT "governance_event_proposal_fkey" FOREIGN KEY ("practice_id", "proposal_id")
		REFERENCES "governance_proposal" ("practice_id", "id"),
	CONSTRAINT "governance_event_action_check" CHECK ("action" IN ('approve', 'commit')),
	CONSTRAINT "governance_event_actor_nonempty" CHECK (length("actor_id") > 0),
	CONSTRAINT "governance_event_role_nonempty" CHECK (length("actor_role") > 0),
	CONSTRAINT "governance_event_audit_hash_nonempty" CHECK (length("audit_row_hash") > 0)
);
--> statement-breakpoint
CREATE TABLE "governance_signed_note" (
	"practice_id" uuid NOT NULL,
	"id" uuid NOT NULL DEFAULT gen_random_uuid(),
	"proposal_id" uuid NOT NULL,
	"fhir_resource_type" text NOT NULL,
	"fhir_resource_id" uuid NOT NULL,
	"fhir_version_id" text NOT NULL,
	"approver_actor_id" text NOT NULL,
	"approved_at" timestamptz NOT NULL,
	"committer_actor_id" text NOT NULL,
	"signed_at" timestamptz NOT NULL,
	"commit_audit_hash" text NOT NULL,
	CONSTRAINT "governance_signed_note_pkey" PRIMARY KEY ("practice_id", "id"),
	CONSTRAINT "governance_signed_note_proposal_unique" UNIQUE ("practice_id", "proposal_id"),
	CONSTRAINT "governance_signed_note_proposal_fkey" FOREIGN KEY ("practice_id", "proposal_id")
		REFERENCES "governance_proposal" ("practice_id", "id"),
	CONSTRAINT "governance_signed_note_approver_nonempty" CHECK (length("approver_actor_id") > 0),
	CONSTRAINT "governance_signed_note_committer_nonempty" CHECK (length("committer_actor_id") > 0),
	CONSTRAINT "governance_signed_note_audit_hash_nonempty" CHECK (length("commit_audit_hash") > 0)
);
--> statement-breakpoint
ALTER TABLE "governance_proposal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "governance_proposal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "governance_proposal_tenant_isolation" ON "governance_proposal"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
ALTER TABLE "governance_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "governance_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "governance_event_tenant_isolation" ON "governance_event"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
ALTER TABLE "governance_signed_note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "governance_signed_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "governance_signed_note_tenant_isolation" ON "governance_signed_note"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT ON "governance_proposal" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "governance_proposal" FROM "bonfire_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "governance_event" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "governance_event" FROM "bonfire_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "governance_signed_note" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "governance_signed_note" FROM "bonfire_app";
