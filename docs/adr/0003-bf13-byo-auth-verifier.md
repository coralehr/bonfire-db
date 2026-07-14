# ADR 0003 — BF-13: BYO-auth verifier (external OIDC/JWT → membership → RLS)

Status: accepted · Date: 2026-07-07 · Slice: BF-13

Bonfire consumes verified identity; it is not an authorization server. This ADR
records the load-bearing line that connects external authentication to BF-01's
fail-closed RLS: a `verifyToken` boundary, an `(iss,sub) → membership` server-side
mapping, and the transaction-local tenant context that makes multi-tenancy real.

## Decisions

1. **The `alg` comes from configuration, never the token header.** `verifyToken`
   passes a POSITIVE allow-list (`RS256/ES256/EdDSA`) to `jose.jwtVerify`. A
   token with `alg:none`, or an RS256 token re-signed as HS256 with the public
   key as the HMAC secret, is rejected with `ALG_NOT_ALLOWED` before any key is
   consulted. The token header's `alg` is never read to choose an algorithm —
   this is what defeats algorithm-confusion.

2. **Verification fails closed and never throws across the boundary.** Every
   `jose` throw is caught and mapped — via a `Record<string, AuthErrorCode>` with
   a `VERIFY_FAILED` default (not a fat switch, so an unmapped future jose error
   still denies) — to a typed `err(AuthError)`. iss/aud/exp are asserted; an
   unknown kid, a bad signature, or a missing `sub` (re-parsed at a Zod output
   boundary) all deny. A catch never returns `ok`. A verification failure sets NO
   tenant GUC, so BF-01's default-deny RLS stays at zero rows.

3. **Claims are NOT trusted for authorization scope.** `practice_id` and `role`
   come ONLY from the server-side `membership` table via `resolveMembership(iss,
   sub)`. This is structural, not just a rule: `VerifiedIdentity` carries no
   `practiceId`/`role` field, so any attempt to read a tenant/role off a verified
   token is a COMPILE error. A `sub` with no membership row is denied (no tenant
   context). Two guards back this up: `sgrules/no-authz-attr-from-request`
   (bans reading `practiceId`/`practice_id`/`role` off a request/claims/token
   object) and the membership table's `REVOKE INSERT FROM bonfire_app`.

4. **The `(iss,sub) → membership` table is the trust anchor.** It is read PRE-AUTH
   with no tenant GUC (chicken-and-egg: you read this row to LEARN the
   practice_id), so it has a deliberate, documented `USING(true)` SELECT policy
   for `bonfire_app` and carries no PHI. Writes are OWNER-ONLY: RLS default-denies
   INSERT and an explicit `REVOKE INSERT` is the privilege-layer belt. If the app
   could self-provision a membership it could self-assign any `(practice_id,
   role)` — a total ABAC bypass — so provisioning is a migration/admin action.

5. **RLS context is applied transaction-locally, reusing `withTenant`.** The
   resolved `practice_id` is set with `set_config('app.current_practice_id', $1,
   true)` inside the per-request transaction (BF-01's wrapper). The auth code
   never sets an `app.*` GUC itself — the semgrep `bonfire-session-set-app-guc`
   rule bans session-level `SET`. This closes BP-005 (pooled-connection context
   bleed): request B on the physical connection request A just released sees only
   B, and a no-identity connection returns zero rows (proved at both the TenantDb
   and HTTP layers on a `max:1` pool).

6. **Every authentication decision emits exactly one hash-chained audit row.**
   Success is audited on the RESOLVED practice's chain (`decision:"allow"`,
   `actorId:JSON.stringify([iss, sub])`, an injective tuple encoding). A failure
   has no tenant, so it is audited on a
   reserved SYSTEM practice (`00000000-0000-4000-8000-000000000000`) with its own
   genesis-anchored chain (`decision:"deny"`, receipt `practiceId:"unknown"` which
   BF-05's mis-attribution guard whitelists). RLS keeps SYSTEM rows invisible to
   every real tenant. The success audit commits in its OWN transaction BEFORE the
   request handler runs, so a throwing handler rolls back only its own work — the
   authentication record survives.

7. **BYO-IdP by config; SMART vocabulary adopted, SMART server deferred.** One
   OIDC adapter ships in v0 (`loadOidcConfig`: issuer + JWKS URL + audience +
   claim-name map, Zod-parsed, fail-closed). No auth-vendor SDK is bundled. The
   identity claim is named per the SMART vocabulary (`fhirUser`) so SMART becomes
   a later ADDITIVE adapter, but the SMART authorization-server endpoints
   (`authorize` / `token` / `.well-known/smart-configuration`) are deliberately
   NOT implemented.

## Deferred (explicitly out of scope for this slice)

- **Production wiring of `app.ts` / `server.ts`.** The middleware ships as an
  injectable `runAuthenticated(request, reply, { verifier, tenantDb }, handler)`
  proven via a test-constructed Fastify app. Wiring it into the live server
  (constructing the prod verifier via `buildVerifier`, registering the hook on
  the real routes) is a follow-up: those files were outside this slice's write
  scope, and the boundary is complete and injectable without them.
- **SMART authorization-server endpoints** and a break-glass / role-elevation
  flow (BF-05 already parses but does not grant `ETREAT`).
- **Patient compartment role.** v0 `ROLES` are the workforce set
  (`clinician`/`biller`/`operations`/`researcher`), and `membership_role_check`
  mirrors it. The SMART patient-vs-clinician *compartment* distinction needs a
  `patient` principal, which only arrives via the SMART patient-launch flow —
  deferred above with the SMART authorization server. Adding a `patient` role +
  compartment scoping is an additive follow-up (a new enum value, a
  `membership_role_check` migration, and compartment predicates) when that flow
  lands; introducing an unused `patient` role now would be dead authority with no
  consumer. The SMART *vocabulary* (`fhirUser`) is adopted today so the later
  adapter is additive, not a rewrite.
- **Membership admin/provisioning UX.** v0 provisions rows as the migration owner.
- **SYSTEM-chain write throughput.** Every failed authentication appends to ONE
  shared SYSTEM hash chain. Appends are optimistic (read tip, write tip.seq+1) and
  `auditAuthSuccess`/`auditAuthFailure` bounded-retry the transient
  `(practice_id, seq)` conflicts that concurrent appends produce, which keeps
  "one audit row per decision" true under normal concurrency. Under SUSTAINED high
  concurrency a hot chain can still exhaust the retry bound (the loser keeps
  colliding with freshly-committed tips). Hardening the append primitive itself
  (a per-practice sequence source, or serializing the SYSTEM chain) lives in the
  audit module (BF-05) and is a tracked follow-up — the deny is always fail-closed
  regardless; only the audit row can be dropped in that pathological window.

## Consequences

- The verified-identity → practice_id bridge is now the single audited line every
  tenant-scoped read/write depends on; a future route need only wrap its handler
  in `runAuthenticated` to inherit fail-closed multi-tenancy.
- All test keys are synthetic and generated in-test (`generateKeyPair` →
  `exportJWK` → `createLocalJWKSet`); no key or secret is committed, and no test
  performs a real network fetch.
