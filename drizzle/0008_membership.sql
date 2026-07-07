-- BF-13 external-identity membership: the ONLY producer of (practice_id, role).
--
-- A global tenant DIRECTORY mapping a verified external identity (iss, sub) to
-- exactly one practice + role. It is read PRE-AUTH, before any tenant GUC
-- exists (chicken-and-egg: you need practice_id to scope data, but you read
-- this row to LEARN practice_id) — so its SELECT policy is a DELIBERATE,
-- documented USING(true) for bonfire_app. An RLS row-predicate cannot key off
-- the query's WHERE terms and there is no tenant context yet, so row filtering
-- is done by the parameterized (iss=,sub=) equality in resolveMembership, not
-- by RLS. This is safe because membership carries NO PHI — only external
-- identity handles + a practice UUID + a role; the sensitive asset
-- (fhir_resources) stays GUC-scoped. Blast radius of the app role reading the
-- whole directory is enumeration of identity handles, not patient data.
--
-- Writes are OWNER-ONLY: no INSERT/UPDATE/DELETE policy (RLS default-denies)
-- AND an explicit REVOKE INSERT belt over the BP-018 flipped S/I default. This
-- is the load-bearing trust anchor: if the app could self-INSERT a membership
-- it could self-assign any (practice_id, role) — a total ABAC bypass.
-- Provisioning happens as the migration owner (seed/admin), never the app.
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"iss" text NOT NULL,
	"sub" text NOT NULL,
	"practice_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "membership_iss_sub_unique" UNIQUE ("iss", "sub"),
	CONSTRAINT "membership_iss_nonempty" CHECK (length("iss") > 0),
	CONSTRAINT "membership_sub_nonempty" CHECK (length("sub") > 0),
	CONSTRAINT "membership_role_check"
		CHECK ("role" IN ('clinician', 'biller', 'operations', 'researcher')),
	-- Defense-in-depth on the trust anchor: no real identity may be provisioned
	-- onto the reserved SYSTEM practice (the global failed-auth audit chain). The
	-- app role already cannot INSERT here (REVOKE INSERT), but this stops an
	-- owner-side mistake from scoping a live (iss,sub) onto the SYSTEM chain,
	-- which would enumerate identity handles across tenants.
	CONSTRAINT "membership_not_system_practice"
		CHECK ("practice_id" <> '00000000-0000-4000-8000-000000000000')
);
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Bootstrap SELECT policy: readable by the app role with NO GUC dependency.
-- Resolution must happen before a tenant context exists, and an RLS predicate
-- cannot express "the row matching the caller's (iss,sub)" (it never sees the
-- WHERE), so the only coherent posture is USING(true) restricted to SELECT +
-- bonfire_app. The exact-match filtering is the parameterized query.
CREATE POLICY "membership_app_resolve" ON "membership"
	AS PERMISSIVE FOR SELECT TO "bonfire_app"
	USING (true);
--> statement-breakpoint
GRANT SELECT ON "membership" TO "bonfire_app";
--> statement-breakpoint
-- Belt over the BP-018 flipped initdb default (auto-GRANTs SELECT,INSERT). The
-- app must NEVER mint its own membership — that is the trust anchor for
-- practice_id + role. RLS already default-denies INSERT (no WITH CHECK policy),
-- this REVOKE is the privilege-layer suspenders.
REVOKE INSERT ON "membership" FROM "bonfire_app";
