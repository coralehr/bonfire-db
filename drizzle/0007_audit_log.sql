-- BF-05 tamper-evident audit log: append-only, hash-chained, tenant-scoped.
--
-- One PER-PRACTICE hash chain: each practice_id has its own chain (seq from 1,
-- seq=1 chains from a fixed domain-separated genesis). Per-practice (not one
-- global chain) so a tenant can verify its whole chain under RLS — a global
-- chain's prev_hash would link to rows the tenant cannot read.
--
-- Append-only is a PRIVILEGE-layer guarantee: GRANT SELECT,INSERT only, then
-- REVOKE UPDATE,DELETE (belt over the BP-018 initdb default, which now also
-- grants S/I only). The app role can never mutate a committed row (proven:
-- 42501). The MIGRATION OWNER can — by design — so the tamper-detection eval
-- mutates a committed row as the owner to prove the chain catches it.
--
-- The two UNIQUE constraints are the fail-closed backstop under the append
-- advisory lock: (practice_id, seq) forbids a forked/duplicate chain position
-- and pins a single seq=1; (practice_id, prev_hash) lets each parent hash be
-- extended exactly once, so two children of one parent (a fork) cannot persist.
--
-- RESIDUAL (accepted for v0, documented): a pure hash chain has no external
-- anchor, so an owner/superuser with UPDATE on every row could rewrite the
-- whole chain forward from genesis and produce a valid chain; and a tip-only
-- tamper (delete or mutate+rehash the last row, no successor to break) is
-- invisible to the chain alone. v0 detects all PARTIAL tampering + relies on
-- the append-only REVOKE for the app path. External anchoring / HMAC signing
-- with an owner-held-out key is future (v1+) work.
CREATE TABLE "audit_log" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"practice_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"actor_id" text NOT NULL,
	"decision" text NOT NULL,
	"resource_type" text NOT NULL,
	"purpose_of_use" text NOT NULL,
	"matched_rule_id" text,
	"reason" text NOT NULL,
	"occurred_at" timestamptz NOT NULL,
	"prev_hash" text NOT NULL,
	"row_hash" text NOT NULL,
	CONSTRAINT "audit_log_practice_seq_unique" UNIQUE ("practice_id", "seq"),
	CONSTRAINT "audit_log_practice_prev_hash_unique" UNIQUE ("practice_id", "prev_hash"),
	CONSTRAINT "audit_log_decision_check" CHECK ("decision" IN ('allow', 'deny')),
	CONSTRAINT "audit_log_seq_positive" CHECK ("seq" >= 1)
);
--> statement-breakpoint
CREATE INDEX "audit_log_practice_seq_idx" ON "audit_log" ("practice_id", "seq");
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
	AS PERMISSIVE FOR ALL TO "bonfire_app"
	USING ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))))
	WITH CHECK ("practice_id" = (SELECT safe_uuid(current_setting('app.current_practice_id', true))));
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO "bonfire_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM "bonfire_app";
