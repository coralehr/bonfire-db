// The BF-01..BF-13 slice registry. Human-authored data (loop-harness-plan.md
// H1: no prose auto-parsing). Drafted from docs/plans/mvp-demo-plan.md (v3),
// reconciled to its canonical layout (packages/{core,sdk,mcp}, apps/{api,demo},
// drizzle/, seed/) and reviewed against it. The secrets/real-data/gates/harness
// floor is global (allowed-paths.ts GLOBAL_FORBIDDEN_PATHS); forbiddenPaths here
// holds only slice-specific extras. Validated at load by registry.ts.
import type { SliceContract } from "./slice-contract.js";

export const tasks: readonly SliceContract[] = [
  {
    id: "BF-01",
    title:
      "Bun workspace + Docker compose + Postgres 18/pgvector boot + /health; RLS scaffolding from row zero",
    profile: "foundation",
    goal: "Boot a clean clone with `docker compose up` and zero API keys: Postgres 18 + pgvector come up healthy and a typed `/health` endpoint reports DB and pgvector status as a Result. Establish RLS fail-closed scaffolding (practice_id session GUC, FORCE ROW LEVEL SECURITY, default-deny policy, non-superuser runtime role) from row zero so multi-tenant isolation is the foundation, not a later retrofit.",
    why: 'Retrofitting security is how you leak, and a cross-tenant leak is one dead company. Proving zero-key reproducible boot and RLS fail-closed default-deny tenant isolation in the very first slice makes "practice_id + RLS on every row" and "DB health is a typed Result, not a throw" the non-negotiable substrate that every later clinical, vector, audit, and agent path builds on.',
    dependsOn: [],
    allowedPaths: [
      "docker-compose.yml",
      "docker/**",
      "apps/api/**",
      "packages/core/**",
      "drizzle/**",
      "seed/**",
      ".env.example",
      "docs/adr/**",
      "package.json",
      // Dependency additions must record their lockfile change (lockfile gate).
      "bun.lock",
      "turbo.json",
      "tsconfig.json"
    ],
    forbiddenPaths: ["sgrule-tests/**", "packages/fhir/**", "LICENSE"],
    acceptance: [
      "`docker compose config -q` is valid and `docker compose up -d --wait` exits 0 on a clean clone using only `.env.example` defaults \u2014 no API keys and no manual secret entry required to boot.",
      "The Postgres service reports server major version 18 (`SHOW server_version_num` returns a value >= 180000).",
      "The pgvector extension is installed and queryable: `SELECT extversion FROM pg_extension WHERE extname='vector'` returns exactly one row.",
      '`GET /health` returns HTTP 200 with a JSON success Result (`{ ok: true, ... }`) reporting `db: "up"` and `pgvector: "present"` when Postgres is reachable.',
      "`GET /health` returns a non-2xx status with a typed error Result (`{ ok: false, ... }`) \u2014 never an uncaught exception, 500 stack trace, or hang \u2014 when Postgres is unreachable (verified by stopping the db container). CQ2: Result at the boundary, fail-closed.",
      "A row-zero migration creates a tenant-scoped scaffold table declared with both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` and a default-deny policy keyed on `current_setting('app.current_practice_id', true)`.",
      "With no `app.current_practice_id` session GUC set, `SELECT` on the scaffold table returns 0 rows (fail-closed default-deny, not all rows).",
      "With `app.current_practice_id` set to practice A's id, the scaffold query returns only practice A's seeded rows and never practice B's rows (cross-tenant isolation).",
      "The application connects to Postgres as a dedicated role with `rolsuper = false` and `rolbypassrls = false` (verified via `pg_roles`), so RLS cannot be silently bypassed.",
      "`bun run gate` passes (typecheck + lint + test + build + anti-slop gate); no new file introduces `any`, `@ts-ignore`, or `eslint-disable`, and every exported function has an explicit return type (NodeNext ESM, Zod 4 at boundaries).",
      "Synthetic-only invariant holds: no `.env`, no real PHI, and no real secrets are committed; only `.env.example` and synthetic seed data are present."
    ],
    verify: [
      "docker compose config -q",
      "docker compose up -d --wait",
      "bun run db:migrate",
      "bun test packages/core",
      "bun test apps/api",
      "curl -fsS http://localhost:8080/health | grep -q '\"ok\":true'",
      "bun run gate",
      "docker compose down -v"
    ],
    evals: [
      "boot-health-green: `docker compose up -d --wait` brings the stack up and `/health` returns 200 with `{ ok:true, db:'up', pgvector:'present' }` within the compose healthcheck window on a clean clone with zero API keys.",
      "health-fail-closed: with Postgres stopped/unreachable, `/health` returns a typed error Result (ok:false, non-2xx) and never throws an uncaught exception, leaks a stack trace, or hangs (CQ2 default-deny at the boundary).",
      "rls-default-deny-zero-rows: with no `app.current_practice_id` GUC set, a SELECT on the RLS scaffold table returns 0 rows (fail-closed proof against fail-open-authz).",
      "rls-cross-tenant-isolation: with `app.current_practice_id` = practice A, only practice-A rows are visible and practice-B rows are never returned (cross-tenant-leak proof).",
      "runtime-role-not-superuser: the runtime DB role has rolsuper=false and rolbypassrls=false and scaffold tables are FORCE ROW LEVEL SECURITY, so even the table owner is subject to RLS."
    ],
    dangerChecks: ["cross-tenant-leak", "fail-open-authz"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-02",
    title:
      "Canonical FHIR store (fhir_resources JSONB) + history + write_inputs + Drizzle migrations + idempotent synthetic seed + synthetic-only scanner + RLS fail-closed on every row",
    profile: "data",
    goal: "Establish the canonical persistence layer: a `fhir_resources` JSONB store of canonical FHIR R4 plus `history` and `write_inputs`, created via forward-only Drizzle migrations, populated by an idempotent synthetic-only seed, and guarded by Postgres Row-Level Security that is fail-closed on every row from row zero.",
    why: "FHIR R4 stored as JSONB is the single source of truth the entire product reads, projects, and re-derives from, so the storage shape and the raw `write_inputs` replay payload must be correct before any read or mapping slice is built. Tenant isolation and PHI hygiene are non-negotiable at row zero: a cross-`practice_id` leak is a company-ending event and retrofitting RLS or synthetic-only discipline later is exactly how clinical systems leak \u2014 this slice makes fail-closed isolation and synthetic-only the structural default, not an afterthought.",
    dependsOn: ["BF-01"],
    allowedPaths: [
      "packages/core/**",
      "drizzle/**",
      "drizzle.config.ts",
      "seed/**",
      "fixtures/synthetic/**",
      "scripts/synthetic-scan/**",
      "package.json",
      "bun.lock"
    ],
    forbiddenPaths: [
      "apps/**",
      "packages/sdk/**",
      "packages/mcp/**",
      "docker-compose.yml",
      "docs/plans/**"
    ],
    acceptance: [
      "A forward-only Drizzle migration creates `fhir_resources` (canonical FHIR R4 in a JSONB content column), `history`, and `write_inputs`; `information_schema.tables`/`columns` confirms each table exists with a NOT NULL `practice_id` and a JSONB content column on `fhir_resources`.",
      "`bun run db:migrate` applies from an empty Postgres to green, is forward-only with a tracked migration journal under `drizzle/`, and is idempotent \u2014 a second consecutive run exits 0 and produces no schema change.",
      "RLS is ENABLED and FORCEd on every table created by this slice, and the application connects via a non-superuser role that lacks BYPASSRLS (verified against `pg_roles`), so the table owner cannot silently bypass the policy.",
      "Fail-closed default-deny: a session with no `app.current_practice_id` set (or an empty/invalid value) returns 0 rows from every table on SELECT and affects 0 rows on UPDATE/DELETE \u2014 the negative test asserts zero rows returned, not a swallowed error.",
      "Cross-tenant isolation: a row written under practice A returns 0 rows / 0 rows affected for a session scoped to practice B across SELECT, UPDATE, and DELETE.",
      "One atomic write path: a write of `fhir_resources` + `history` + `write_inputs` occurs in a single transaction, and an injected mid-write failure rolls back all three with no partial rows remaining (asserted by a rollback test).",
      "`write_inputs` persists the verbatim originating raw typed payload 1:1 with each `fhir_resources` row (FK + row-count parity), so canonical FHIR can be re-derived by BF-03 from the stored input.",
      "`history` is append-only: updating a seeded resource inserts a new version row with a monotonically increasing `version_id` that preserves the prior `content`, with no in-place destructive overwrite of an existing history row.",
      "The seed is idempotent and synthetic-only: `bun run seed` run twice yields identical row counts (no duplicate rows) and writes/honors a completion marker so the second run is a no-op; the semantic synthetic-only scanner exits 0 on the seed corpus and fixtures and exits non-zero on a planted real-PHI fixture (proving the tripwire fires)."
    ],
    verify: [
      "docker compose up -d",
      "bun install --frozen-lockfile",
      "bun run db:migrate",
      "bun run seed",
      "bun run scan:synthetic",
      "bun test packages/core",
      "bun run gate"
    ],
    evals: [
      "eval:bf02-rls-fail-closed \u2014 a connection with no/empty practice context returns 0 rows from every table created by this slice (fail-closed, asserts zero rows not an error)",
      "eval:bf02-cross-tenant-leak \u2014 a row inserted under practice A is invisible (0 rows / 0 affected) to a session scoped to practice B across SELECT/UPDATE/DELETE",
      "eval:bf02-rls-forced-no-bypass \u2014 RLS is FORCEd and the app role lacks BYPASSRLS, so owner/superuser bypass cannot leak rows",
      "eval:bf02-atomic-write-rollback \u2014 an injected failure mid-write leaves no partial fhir_resources/history/write_inputs rows (single-transaction integrity)",
      "eval:bf02-write-inputs-parity \u2014 every fhir_resources row has exactly one verbatim write_inputs payload (1:1 replay parity)",
      "eval:bf02-history-append-only \u2014 updating a resource preserves the prior version content as a new monotonic history row with no destructive overwrite",
      "eval:bf02-seed-idempotent \u2014 running the seed twice yields identical row counts and honors the completion marker (no duplicates)",
      "eval:bf02-synthetic-only-tripwire \u2014 the synthetic-only scanner exits 0 on the seed/fixture corpus and non-zero on a planted real-PHI fixture"
    ],
    dangerChecks: ["cross-tenant-leak", "fail-open-authz"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-03",
    title:
      "Typed write primitive \u2192 lossless FHIR R4 / US Core 6.1.0 + loss-ledger + golden round-trip + terminology validate-on-write + stored Consent resource",
    profile: "fhir",
    goal: "Build the typed write primitive that maps the ~8 scribe resources to FHIR R4 / US Core 6.1.0 and persists canonical FHIR plus its prior version and the replayable raw typed payload in ONE atomic transaction. Losslessness is gated by a loss-ledger and by golden round-trip fixtures validated against the official HL7 FHIR validator. Coded fields are validated on write against a version-pinned, license-clean terminology pack (local SQL set-membership, no network), and the FHIR Consent resource is stored losslessly via the same canonical path (the directive-to-SQL enforcement compiler is deferred post-v0; storage is in scope now).",
    why: 'FHIR R4 is the source of truth and the typed primitive is the only write API; a lossy mapping silently corrupts the clinical record, and an unverified "FHIR-valid"/"conformant" claim is how conformance rots. Keeping the raw typed payload (write_inputs) lets FHIR be re-derived when the mapping improves, and the loss-ledger + HL7-validated golden round-trips make losslessness and conformance machine-proven rather than asserted.',
    dependsOn: ["BF-01", "BF-02"],
    allowedPaths: [
      "packages/core/src/write/**",
      "packages/core/src/fhir/**",
      "packages/core/src/terminology/**",
      "packages/core/src/index.ts",
      "packages/core/src/**/*.test.ts",
      "packages/core/package.json",
      "fixtures/golden/**",
      "fixtures/terminology/**",
      "scripts/fhir/**",
      "package.json",
      // Dependency additions (allowed via package.json) must record their
      // lockfile change (lockfile gate) — as BF-01/BF-02 already do.
      "bun.lock",
      "docs/adr/**",
      "docs/loss-ledger.md"
    ],
    forbiddenPaths: ["drizzle/**", "packages/sdk/**", "packages/mcp/**", "apps/**"],
    acceptance: [
      "A typed write primitive exists for each of the documented scribe resources (~8: Patient, Encounter, Condition, Observation, MedicationRequest, AllergyIntolerance, Procedure, DocumentReference), each with an explicit Zod input schema and an explicit return type, returning a Result discriminated union { ok:true; data } | { ok:false; error } at the public boundary (no any/@ts-ignore/eslint-disable).",
      "Each primitive maps its typed input to a FHIR R4 resource conforming to the corresponding US Core 6.1.0 profile, and the canonical FHIR JSON (not the typed input) is what is persisted to fhir_resources \u2014 FHIR R4 is the source of truth.",
      "The write runs as ONE atomic transaction that inserts the canonical FHIR resource into fhir_resources, the superseded version into history, and the raw typed payload into write_inputs; a forced mid-transaction failure leaves zero rows across all three tables (no partial write, no dual write).",
      "Every row the primitive inserts carries the caller's practice_id (synthetic), stamped server-side from the authenticated context and never read from client-controllable input.",
      "For each scribe resource a synthetic typed input \u2192 FHIR \u2192 typed input round-trip reproduces the original input with zero unaccounted-for field loss; any dropped or transformed field has a matching loss-ledger entry, and a round-trip diff with no matching ledger entry FAILS the gate (lossless-or-ledgered invariant).",
      "Every golden FHIR fixture passes the official HL7 FHIR validator against FHIR R4 + US Core 6.1.0 with zero errors; the validate step exits non-zero on any validator error so 'FHIR-valid' is never assumed without the validator, and the validator output is captured as evidence.",
      "docs/loss-ledger.md exists and is empty unless a field is intentionally dropped; each entry references an ADR under docs/adr/ recording explicit human sign-off (a field may be dropped ONLY via ADR + sign-off).",
      "write_inputs replay: re-deriving FHIR from a stored write_inputs row reproduces the canonical FHIR persisted at write time (the mapping is deterministic and replayable).",
      "Terminology validate-on-write: coded fields are checked by pure local SQL set-membership against a version-pinned terminology pack (its version is recorded on the result); only `required`-strength bindings on small enumerated value sets REJECT the write (fail-closed), while extensible/preferred bindings and large intensional sets record an audited data-quality WARNING rather than blocking. Only redistributable vocabularies are bundled (ICD-10-CM, RxNorm core, LOINC with the Regenstrief NOTICE); NO SNOMED concept content is shipped (SNOMED is validated for SCTID/URI format only). The validator is an interface (BundledPackValidator default + a RemoteTxValidator seam, I/O byte-compatible with `$validate-code`) so a real terminology server can be swapped in with no schema change. validate-on-write never makes a blocking network call.",
      "The FHIR Consent resource is accepted by the typed write path and stored losslessly in fhir_resources (canonical JSONB) like any other resource (round-trip + RLS-scoped); query-time directive enforcement is explicitly out of scope here (deferred to a post-v0 consent compiler).",
      "All data used by code, tests, and fixtures is synthetic only; the repo gate (tsc/eslint/knip/jscpd/dependency-cruiser/semgrep/synthetic-only/allowed-paths) passes green."
    ],
    verify: [
      "docker compose up -d",
      "bun install --frozen-lockfile",
      "bun run gate",
      "bun test packages/core",
      "bun run fhir:roundtrip",
      "bun run fhir:validate"
    ],
    evals: [
      "eval/fhir-roundtrip-lossless: feed each of the ~8 scribe resources a synthetic typed input and assert the FHIR\u2192typed round-trip is field-equivalent OR every diff is covered by a loss-ledger entry; reintroducing a silently dropped field fails the eval.",
      "eval/loss-ledger-enforced: a mapping change that drops or transforms a field WITHOUT an ADR-backed loss-ledger entry fails the gate (lossy-passing-as-lossless regression).",
      "eval/hl7-validator-required: a golden fixture mutated to violate FHIR R4 / US Core 6.1.0 is REJECTED by the HL7 validator step with a non-zero exit (fake-conformance regression \u2014 no 'valid' without the validator).",
      "eval/write-atomicity: a forced mid-transaction failure leaves zero rows in fhir_resources, history, and write_inputs (no partial or dual write).",
      "eval/write-inputs-replay: re-deriving FHIR from a stored write_inputs row reproduces the canonical FHIR persisted at write time.",
      "eval/terminology-required-binding-rejects: a write with an invalid code on a required-strength enumerated binding is REJECTED (fail-closed) while an extensible-binding miss is accepted with an audited warning; the result records the terminology pack version, and validation issues zero network calls (a planted SNOMED concept-membership check, which we do not ship, is NOT used to block).",
      "eval/consent-stored-lossless: a synthetic FHIR Consent resource round-trips losslessly through the write path and is RLS-scoped to its practice_id (no directive enforcement asserted here)."
    ],
    dangerChecks: ["lossy-fhir", "fake-conformance", "cross-tenant-leak"],
    caps: {
      maxAttempts: 3,
      maxTurns: 75,
      maxBudgetUSD: 13
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-04",
    title:
      "SQL-on-FHIR v2 ViewDefinition runner \u2192 vd_* projections + spidx + HL7 conformance suite",
    profile: "retrieval",
    goal: "Build a SQL-on-FHIR v2 ViewDefinition runner in TypeScript over Postgres (using fhirpath.js) that materializes canonical FHIR resources into indexed typed vd_* projection tables plus a search-parameter index (spidx), so the agent/app read off <5ms typed projections instead of JSONB scans. Prove standards-credibility by passing the official HL7 sql-on-fhir conformance suite.",
    why: "Indexed typed projections are the performance primitive \u2014 the Medplum/HAPI model; Aidbox-style JSONB-direct search does not scale (target <5ms typed reads). Passing the published HL7 sql-on-fhir conformance suite is the standards-credible contributor magnet and the only honest basis for claiming SQL-on-FHIR support. The vd_* projections + spidx are the read surface every later slice (cited search BF-06, CCP BF-07, SDK BF-08, benchmark BF-11) is built on, so getting them rebuildable-from-canonical and RLS-fail-closed now is load-bearing.",
    dependsOn: ["BF-01", "BF-02", "BF-03"],
    allowedPaths: [
      "packages/sql-on-fhir/**",
      "packages/core/migrations/**",
      "packages/core/src/schema/**",
      "fixtures/sql-on-fhir/**",
      "tests/sql-on-fhir/**",
      "docs/adr/**",
      "drizzle/**"
    ],
    forbiddenPaths: ["packages/core/src/schema/fhir-resources.ts"],
    acceptance: [
      "The official HL7 sql-on-fhir v2 conformance suite is vendored under fixtures/sql-on-fhir/ with its upstream version/commit pinned and recorded; a `bun run conformance` task executes every case, prints total/passed/failed/skipped counts, and exits non-zero on any unexpected failure.",
      "The runner passes 100% of the conformance cases it claims to support; every intentionally unsupported case is in an explicit declared allowlist with a written reason (no silent skips) and the unsupported count is printed.",
      "ViewDefinitions are validated against the published SQL-on-FHIR v2 ViewDefinition schema (Zod at the boundary) before execution; column `path` expressions are evaluated via fhirpath.js and the runner supports forEach/forEachOrNull, unionAll, where filters, and constant substitution.",
      "Running a ViewDefinition against canonical fhir_resources materializes a typed `vd_<name>` Postgres table whose columns and types match the ViewDefinition's declared columns; the table is created idempotently and a full drop+rebuild from canonical FHIR produces byte-identical rows (projection is a pure function of canonical FHIR).",
      "A search-parameter index (`spidx`) table is populated for the supported US Core search params of the ~8 scribe resources; an equality lookup on an indexed param returns exactly the same resource ids as a JSONB scan over fhir_resources (parity test).",
      "Every vd_* projection row and every spidx row carries a non-null practice_id and is protected by a fail-closed RLS policy; a negative test proves a session scoped to practice A reads zero of practice B's vd_*/spidx rows (cross-tenant query returns no rows, never leaking existence or erroring open).",
      "A typed single-resource read off a vd_* table uses an index \u2014 `EXPLAIN` shows an Index Scan (not Seq Scan) on the indexed lookup \u2014 and the measured median latency over N reads on the seeded synthetic corpus is printed (target <5ms).",
      "The projection/spidx upsert is exposed as a transactional function usable inside the canonical write transaction (one write path, no dual write); a test asserts a rolled-back write transaction leaves zero vd_*/spidx rows.",
      "All test and fixture data is synthetic-only and the synthetic-only scanner passes; `bun run gate` is green (strict typecheck/no-any, lint with no escape hatches, tests, Semgrep, synthetic-only, allowed-paths)."
    ],
    verify: [
      "docker compose up -d db",
      "bun install --frozen-lockfile",
      "bun run db:migrate",
      "bun test packages/sql-on-fhir",
      "bun run conformance",
      "bun test tests/sql-on-fhir",
      "bun run gate"
    ],
    evals: [
      "BF-04-conformance-real: the HL7 sql-on-fhir suite actually executes and the reported pass count matches an independent recount from the suite manifest \u2014 a stubbed/tampered runner that prints PASS without running is caught (fake-conformance).",
      "BF-04-skip-honesty: any conformance case omitted from the run must appear in the declared unsupported allowlist with a reason; an undeclared skip or a downgraded-to-pass case fails the eval (fake-conformance).",
      "BF-04-rls-cross-tenant: a ViewDefinition projection query and a spidx equality lookup executed as practice A return zero of practice B's rows on every SQL path (cross-tenant-leak).",
      "BF-04-rebuild-determinism: dropping and rebuilding vd_*/spidx from canonical FHIR yields identical projection rows, confirming the read side is droppable and rebuildable from canonical FHIR with no drift."
    ],
    dangerChecks: ["cross-tenant-leak", "fake-conformance"],
    caps: {
      maxAttempts: 3,
      maxTurns: 80,
      maxBudgetUSD: 12
    },
    requiredAgents: ["planner", "maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-05",
    title:
      "ABAC policy receipt on every read (scope-before-retrieve, default-deny, purpose-of-use) + hash-chained append-only tamper-evident audit with tamper detection",
    profile: "security",
    goal: "Build the read-path security primitives: an ABAC policy decision that is default-deny and emits a structured policy receipt on every allow AND deny, computed from request scope BEFORE any target row is retrieved, with purpose-of-use (TREAT / HPAYMT / HOPERAT / HRESCH / ETREAT) as a typed, required input bound onto both the decision and the receipt; plus an append-only, hash-chained (prev_hash + row_hash) tamper-evident audit log with a verification routine that detects any mutation, reordering, insertion, or deletion and exposes each row_hash for downstream citation linkage. The decision is a pure typed default-deny function (Cedar/OPA semantics — default-deny, forbid-wins, no rule ordering — without adopting an external runtime PDP in v0).",
    why: "Retrofitting authorization and audit is how PHI leaks and how tampering goes unnoticed. Scope-before-retrieve plus default-deny prevents the scope-after-retrieve leak class, and a verifiable prev_hash/row_hash chain makes the audit trail trustworthy enough to anchor CCP span citations and satisfy HIPAA 45 CFR 164.312 audit-controls and integrity. These are primitives consumed by cited search (BF-06), CCP (BF-07), and governance (BF-09), so they must be correct and fail-closed from row zero.",
    dependsOn: ["BF-01", "BF-02"],
    allowedPaths: ["packages/core/**", "drizzle/**", "docker-compose.yml"],
    forbiddenPaths: ["sgrule-tests/**", "docs/loop/**", "packages/fhir/**"],
    acceptance: [
      "The ABAC decision function returns a structured policy receipt for BOTH allow and deny outcomes; the receipt is a typed object containing at least: decision ('allow' | 'deny'), actor/subject id, resource type, practice_id, a required `purposeOfUse` enum (TREAT | HPAYMT | HOPERAT | HRESCH | ETREAT), matched rule id (or null), human-readable reason, and an ISO-8601 timestamp.",
      "Purpose-of-use is a required, typed input to the decision (Zod enum at the boundary): a missing, empty, or unrecognized purpose-of-use resolves to DENY with a receipt (never defaulted to an allow-implying purpose); the purposeOfUse value used in the decision is the value recorded on the receipt and the audit row (no divergence). ETREAT (emergency/break-glass elevation) is NOT grantable in v0 — a request asserting ETREAT is default-denied (the break-glass elevation flow is deferred post-v0).",
      "DEFAULT-DENY is enforced: any request with no matching allow rule, a missing/invalid/unparseable policy input, or an evaluation error resolves to 'deny' with a receipt; a negative test asserts an unrecognized actor and an empty/garbage scope each yield deny (never throw-to-allow, never undefined-as-allow).",
      "Scope-before-retrieve: the decision is computed solely from request scope (actor + practice_id + resource type/filters) and never loads the target rows; a test proves the deny path issues zero data queries against fhir_resources/projection tables (e.g. via a query spy or by the function signature accepting scope, not rows).",
      "Audit table is append-only at the DB layer: a trigger/rule or revoked UPDATE/DELETE privilege rejects both UPDATE and DELETE; an integration test asserts that an UPDATE and a DELETE against the audit table both fail with a database error.",
      "Hash chain: each audit row persists prev_hash and row_hash where row_hash = SHA-256 over a canonical serialization of the row's logical fields concatenated with prev_hash; the first row chains from a fixed documented genesis hash; a test asserts row_hash is deterministic for identical input and that row N+1's prev_hash equals row N's row_hash.",
      "Tamper detection: a chain-verification routine walks the audit log, recomputes hashes, and returns a structured result that flags the exact first broken link on any mutation, insertion, reordering, or deletion; an eval mutates a committed row using elevated privilege (bypassing the append-only guard) and asserts verification reports the precise broken index, while a clean chain verifies OK.",
      "practice_id + RLS fail-closed applies to the audit table itself: a cross-practice_id read of audit rows returns zero rows (audit is tenant-scoped like every other row); a test asserts an actor scoped to practice A cannot read practice B's audit rows.",
      "Audit-bypass is impossible on the gated read path: every policy decision (allow OR deny) emits exactly one audit row; a test asserts a denied read still produces an audit entry and that one decision never yields zero or duplicate audit rows.",
      "The audit writer returns/exposes the persisted row_hash to its caller so downstream CCP spans can carry it for citation linkage; a test asserts the returned row_hash equals the value stored in the audit row.",
      "All ABAC/audit modules satisfy the repo TS bar (no any, no @ts-ignore/eslint-disable, exhaustive switch on the decision/outcome union, explicit return types on exports, Zod validation of policy input and audit input at the boundary) and the full gate passes for the touched packages."
    ],
    verify: [
      "docker compose up -d",
      "bun install",
      "bun run typecheck",
      "bun run lint",
      "bun test packages/core/",
      "bun run gate"
    ],
    evals: [
      "abac-default-deny: unknown actor, empty scope, and forced evaluation error each resolve to deny WITH a structured receipt (fail-closed, never throw-to-allow)",
      "abac-purpose-of-use-required: a missing/empty/unrecognized purpose-of-use denies with a receipt; the purposeOfUse used in the decision equals the value on the receipt and audit row; an ETREAT request is default-denied in v0 (break-glass deferred)",
      "abac-scope-before-retrieve: the deny decision performs zero reads of target rows (decision computed from scope only, verified by query spy)",
      "audit-append-only: UPDATE and DELETE against the audit table are both rejected at the DB layer",
      "audit-hash-chain-verify: a clean chain verifies OK and row N+1.prev_hash == row N.row_hash with deterministic SHA-256 row_hash",
      "audit-tamper-detect: a row mutated/reordered/inserted/deleted via elevated privilege is flagged at the exact broken link",
      "audit-no-read-without-receipt: every policy-gated read (allow OR deny) emits exactly one audit row",
      "audit-rls-fail-closed: a cross-practice_id read of audit rows returns zero rows"
    ],
    dangerChecks: ["scope-after-retrieve", "fail-open-authz", "audit-bypass", "cross-tenant-leak"],
    caps: {
      maxAttempts: 3,
      maxTurns: 75,
      maxBudgetUSD: 11
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-06",
    title:
      "Cited search (hybrid BM25 + pgvector, RRF-fused; pluggable reranker OFF by default) with scope-before-retrieve and policy/audit-stamped results",
    profile: "retrieval",
    goal: "Add HYBRID cited search over the typed vd_* projections — a BM25 lexical arm and a pgvector (HNSW) semantic arm fused with Reciprocal Rank Fusion in SQL — that applies the ABAC + practice_id scope filter inside the retrieval query (scope-before-retrieve, default-deny), returning results where every hit carries a citation and freshness and the response carries excludedByPolicy, a structured policyReceipt, and an auditEventId. A cross-encoder reranker is a pluggable stage that is OFF by default; in the default config no embedding/rerank call leaves the tenant boundary (self-hosted open-weight models only — synthetic-only in dev).",
    why: "Cited search is the deterministic sub-5-minute wow and the safe read surface the agent depends on. Clinical retrieval needs BOTH modes by construction (exact codes/MRNs need lexical; paraphrased findings need vector), and adding the vector arm later is a migration, not a flag — so hybrid ships in v0. Pushing the scope/RLS filter into the retrieval query (never as a post-fetch app filter) and stamping every read with a policy receipt + audit id is what prevents cross-tenant and scope-after-retrieve leaks; keeping embeddings/rerank inside the boundary (no external PHI egress) is the security floor.",
    dependsOn: ["BF-04", "BF-05", "BF-13"],
    allowedPaths: [
      "packages/core/src/search/**",
      "packages/core/src/index.ts",
      "packages/core/test/**",
      "drizzle/**",
      "fixtures/synthetic/**",
      "loop/evals/retrieval/**"
    ],
    forbiddenPaths: [
      "packages/core/src/abac/**",
      "packages/core/src/policy/**",
      "packages/core/src/audit/**",
      "packages/core/src/write/**",
      "packages/core/src/fhir/**",
      "loop/contracts/**",
      "loop/gates/**"
    ],
    acceptance: [
      "A `searchClinical` HYBRID read primitive is exported from `packages/core` with an explicit return type `Promise<Result<SearchResponse, BonfireError>>`; no `any`, no `as` casts, no `@ts-ignore`/eslint-disable; input and output are parsed by Zod 4 schemas at the boundary.",
      "Hybrid retrieval fuses a BM25 lexical arm and a pgvector HNSW semantic arm via Reciprocal Rank Fusion (RRF) computed in SQL; a test asserts a query matching only an exact code/token (lexical-strong) and a query matching only paraphrased text (vector-strong) each surface the expected resource, proving both arms contribute. `pgvector >= 0.8.2` is required and iterative index scans are enabled so the RLS/scope filter over HNSW does not silently lose recall for sparse tenants.",
      "The cross-encoder reranker is a pluggable stage that is OFF by default; with it disabled the search returns the RRF-fused ranking, and a test asserts the default config performs zero reranking. In the default configuration NO embedding or rerank call goes to an external/off-box API (self-hosted open-weight models only); a test/config-assertion proves the default path makes no external model call (no PHI egress).",
      "Each row in `SearchResponse.results` carries a `citation` (resourceId + JSONB path + audit `row_hash`) and a `freshness` timestamp (projection as-of), and the top-level response carries `excludedByPolicy` (resource ids/types withheld by the scope filter, with count), a structured `policyReceipt` (allow/deny + reason code), and an `auditEventId`.",
      "Scope-before-retrieve is enforced: the ABAC scope predicate and `practice_id` filter are pushed into the SQL retrieval query (WHERE/CTE), provable from the captured query plan (EXPLAIN) \u2014 rows are never fetched then filtered in application code.",
      "Default-deny: when the ABAC decision for a candidate is anything other than an explicit allow (including ambiguity or a policy-evaluation error), the candidate is excluded into `excludedByPolicy` and never appears in `results`; a test injecting a policy error asserts the row is denied, not returned.",
      "Cross-tenant isolation: with the identical search term seeded under two distinct `practice_id`s and RLS active, a search executed as practice A returns zero rows authored under practice B (negative test passes).",
      "Every search \u2014 including a zero-result search \u2014 writes exactly one append-only hash-chained AuditEvent and returns its id as `auditEventId`; no `searchClinical` code path returns results without first writing the audit event.",
      "Migrations add a GIN/BM25 lexical index AND a pgvector HNSW index over the searched typed-projection columns and the search uses them; EXPLAIN shows the lexical index and the HNSW index in use and no sequential scan over the `fhir_resources` JSONB. The embedding provider is pluggable and the model id + dimension are stored alongside each vector (re-embed migration safety).",
      "A deterministic golden synthetic-query fixture produces stable, ordered results; a snapshot test pins the `citation`, `freshness`, `excludedByPolicy`, and `policyReceipt` shape."
    ],
    verify: [
      "docker compose up -d",
      "bun run db:migrate",
      "bun test packages/core",
      "bun run gate",
      "bun run loop eval --slice BF-06"
    ],
    evals: [
      "BF-06-eval-scope-before-retrieve: assert the ABAC + practice_id predicate appears in the captured retrieval SQL/EXPLAIN; rewriting the search to post-fetch filtering fails the eval (scope-after-retrieve regression guard).",
      "BF-06-eval-cross-tenant-isolation: seed an identical term under two practice_ids; searching as practice A returns zero of B's rows with RLS active; removing the practice_id/RLS filter fails the eval.",
      "BF-06-eval-default-deny: a candidate whose policy decision is non-allow/ambiguous/erroring is placed in excludedByPolicy and never in results; a fail-open change (returning on error) fails the eval.",
      "BF-06-eval-audit-on-read: every search (including zero-result) writes exactly one append-only hash-chained AuditEvent and returns auditEventId; a path that returns results with no audit write fails the eval.",
      "BF-06-eval-citation-freshness: each result carries a valid citation (resourceId + JSONB path + audit row_hash) and freshness; a result missing the citation or audit hash fails the eval.",
      "BF-06-eval-hybrid-index-used: EXPLAIN confirms both the lexical (GIN/BM25) index and the pgvector HNSW index are used with no sequential scan over fhir_resources JSONB, and RRF fusion is applied (architecture/perf regression guard).",
      "BF-06-eval-no-phi-egress: in the default config, search performs zero external embedding/rerank API calls and the reranker stage is off; flipping a model provider to an off-box endpoint in the default path fails the eval (PHI-egress guard)."
    ],
    dangerChecks: ["scope-after-retrieve", "cross-tenant-leak", "fail-open-authz", "audit-bypass"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-07",
    title:
      "Cited Context Projection (CCP): compact span-cited serialization + U-shape ordering + token measurement hooks",
    profile: "retrieval",
    goal: "Build the Cited Context Projection \u2014 the agent's default read surface \u2014 that serializes a policy-scoped cited-search result set into a compact, span-cited document where every span carries (resource id, JSONB path, audit hash), ordered U-shape, with offline token-measurement hooks. Raw FHIR stays an explicit, rarely-needed escape hatch.",
    why: "The whole thesis \u2014 cheaper and more accurate are the same move \u2014 lives here: the agent never reads raw FHIR, it reads the CCP built from canonical FHIR underneath. Compact serialization plus span citations make agent reads token-lean and verifiable, and the audit hash extends tamper-evidence all the way to the citation.",
    dependsOn: ["BF-05", "BF-06"],
    allowedPaths: [
      "packages/core/src/ccp/**",
      "packages/core/src/index.ts",
      "loop/evals/corpus/bf-07/**",
      "docs/adr/**"
    ],
    forbiddenPaths: [
      "seed/**",
      "drizzle/**",
      "packages/core/src/fhir/**",
      "packages/core/src/views/**",
      "packages/core/src/audit/**",
      "packages/core/src/search/**",
      "loop/cli/**",
      "loop/gates/**",
      "loop/contracts/**",
      "loop/verify/**"
    ],
    acceptance: [
      "The public `buildCcp` (or equivalent) entry in packages/core/src/ccp returns a Result discriminated union (ok | err) at the boundary: malformed or out-of-scope input yields an `err` variant and never throws; only programmer-error paths throw (CQ2 idiom).",
      "Every CCP document is validated by a Zod 4 schema with explicit exported return types; each span has a non-empty `resourceId`, a `jsonPath` (JSONB path into canonical FHIR), and an `auditHash` field.",
      "Citation precision = 1.0 on the golden fixture set: for every span, resolving (`resourceId`, `jsonPath`) against the canonical `fhir_resources` row yields a value equal to the span's projected value (executable test).",
      "Every span's `auditHash` equals the `row_hash` of the corresponding hash-chained audit entry for that read; mutating the source value or the audit row is detected as a hash mismatch (executable test).",
      "The serializer emits spans in a documented U-shape ordering (highest-salience items first and last, lower-salience in the middle), asserted deterministically against a fixture with a known salience ranking.",
      "A token-measurement hook reports token counts for a CCP document and for the compact-JSON baseline of the identical span set via a pluggable, named tokenizer, running fully offline with zero API keys.",
      "On the golden fixture set the measured CCP serialization is >=1.4x smaller in tokens than the compact-JSON serialization of the identical span set under the named tokenizer (serialization residual lever only; the 10-100x reduction from returning only the slice is owned by BF-06 and is not re-claimed here).",
      "Building a CCP from a result set scoped to practice A never materializes a span that resolves to another practice_id's resource (default-deny / empty), and the projection performs no canonical-FHIR read outside the policy-scoped set passed from BF-06 (no scope-after-retrieve, no cross-tenant leak) \u2014 proven by a negative test.",
      "`bun run gate` passes with zero `any`, no `@ts-ignore`/`eslint-disable`, exhaustive switches, explicit return types on exports, and the allowed-paths diff check green (no files touched outside allowedPaths)."
    ],
    verify: ["bun run gate", "bun test packages/core/src/ccp", "loop eval --slice BF-07"],
    evals: [
      "bf-07-citation-resolves: for every span in a built CCP, (resourceId, jsonPath) resolves against the canonical fhir_resources row and the projected value equals the resolved value (citation precision = 1.0 on the golden set).",
      "bf-07-audit-hash-binds: every CCP span's auditHash equals the row_hash of the corresponding hash-chained audit entry; a mutated source value or audit row is detected as a hash mismatch.",
      "bf-07-scope-respected: building a CCP from a result set scoped to practice A never materializes a span resolving to practice B's resource id (default-deny), and no canonical-FHIR read occurs outside the policy-scoped set (no scope-after-retrieve).",
      "bf-07-token-residual: the token-measurement hook reports CCP serialization >=1.4x fewer tokens than compact-JSON of the identical span set under the named tokenizer, fully offline with zero keys.",
      "bf-07-ushape-ordering: spans are emitted in the documented U-shape (highest-salience first and last) for a fixture with a known salience ranking.",
      "bf-07-result-boundary: buildCcp returns a Result err variant on malformed/out-of-scope input and an ok variant on valid input; no throw at the public boundary."
    ],
    dangerChecks: ["scope-after-retrieve", "cross-tenant-leak", "audit-bypass"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-08",
    title: "Auto-generated typed TS SDK + reactive useClinicalQuery + propose-only local MCP tools",
    profile: "contract",
    goal: "Ship the auto-generated typed TS SDK (from a type-schema IR) that mirrors Bonfire's public surface and returns the Result discriminated union at every boundary, a reactive useClinicalQuery hook over Postgres LISTEN/NOTIFY, and a local MCP server exposing a narrow propose-only typed tool allowlist with no raw SQL/FHIRPath/shell/filesystem access and no approve/commit tool.",
    why: "This is the AI-native client layer: agents and apps consume Bonfire through one typed, default-deny surface instead of touching raw FHIR or SQL. The SDK and MCP are exactly where an agent could break tenant isolation, fail open on authorization, or gain approve/commit power, so this slice makes propose-only governance and cross-tenant safety structural at the client boundary rather than a runtime hope.",
    dependsOn: ["BF-03", "BF-04", "BF-05", "BF-06", "BF-07"],
    allowedPaths: [
      "packages/sdk/**",
      "packages/mcp/**",
      "drizzle/migrations/**",
      "loop/evals/bf-08/**",
      "tsconfig.json"
    ],
    forbiddenPaths: [
      "seed/**",
      "packages/core/**",
      "apps/**",
      "loop/gates/**",
      "loop/contracts/**"
    ],
    acceptance: [
      "`bun run --filter @bonfire/sdk gen` regenerates the typed SDK from the type-schema IR and is idempotent: running it then `git diff --exit-code -- packages/sdk/src/generated` reports no changes, proving the SDK is generated and not hand-edited.",
      "The generated SDK and MCP packages type-check under the strict bar: `bun run typecheck` passes with zero `any`, zero `@ts-ignore`/`eslint-disable`, NodeNext ESM, and explicit return types on all exports; `bun run lint` (eslint strict, no escape hatches) passes.",
      "The SDK exposes one typed method per public operation it mirrors (typed write primitive, CCP read, cited search) and every boundary method returns `Result<T, BonfireError>` (the ok/error discriminated union); a unit test asserts a domain-error path returns `{ ok: false, error: { code } }` with a stable code and never throws across the SDK boundary.",
      "An @microsoft/api-extractor public-surface snapshot for `@bonfire/sdk` and `@bonfire/mcp` is generated and committed; the gate fails on an unreviewed surface change.",
      "`useClinicalQuery` subscribes via Postgres LISTEN/NOTIFY: an integration test that updates a `vd_*` projection row in practice A causes the hook to emit a fresh snapshot within 2s, while an identical update under a different `practice_id` produces no emission for practice A's subscriber (tenant-scoped reactivity).",
      "The MCP server `tools/list` returns exactly the documented typed allowlist and contains no tool exposing raw SQL, FHIRPath, shell, filesystem, or any approve/commit action; a test asserts the exact tool set by name and input schema.",
      "Calling an MCP tool name not on the allowlist, or passing an argument outside its typed schema, returns a structured default-deny and executes nothing; a negative test asserts zero rows and zero side effects.",
      "Every MCP tool response returning clinical data carries the ABAC policy receipt and audit id propagated from the underlying read; an MCP call made in practice B's context requesting practice A data returns deny/empty with a receipt and zero rows (no cross-tenant leak via the agent path).",
      "Tool arguments are prompt-injection sanitized: an execution-watching eval feeds an injected instruction inside a tool argument and asserts scope is unchanged and no unlisted action is triggered.",
      "`bun run gate` passes including dependency-cruiser boundaries (`apps \u2192 sdk \u2192 core`, `mcp \u2192 core`; sdk and mcp do not import each other's internals or core internals beyond published `exports`), knip (no dead code), jscpd, and the allowed-paths diff check; the BF-02/BF-04/BF-05 RLS and audit-chain regression proofs still pass with the added NOTIFY trigger."
    ],
    verify: [
      "bun install",
      "docker compose up -d",
      "bun run --filter @bonfire/sdk gen && git diff --exit-code -- packages/sdk/src/generated",
      "bun run typecheck",
      "bun run lint",
      "bun test packages/sdk",
      "bun test packages/mcp",
      "bun test loop/evals/bf-08",
      "bun run gate"
    ],
    evals: [
      "BF-08-mcp-propose-only: assert MCP tools/list exposes no approve/commit/raw-sql/fhirpath/shell/file tool and that invoking any such name is denied (propose-only-broken tripwire).",
      "BF-08-mcp-default-deny: assert an unlisted tool name or an off-schema argument is denied by default and executes nothing (fail-open-authz tripwire).",
      "BF-08-mcp-cross-tenant: assert an MCP tool call made in practice B's context cannot return practice A rows (returns deny/empty + receipt, zero rows) \u2014 cross-tenant-leak tripwire on the agent path.",
      "BF-08-mcp-prompt-injection: assert an injected instruction inside a tool argument is neutralized and does not widen scope or trigger an unlisted action.",
      "BF-08-useclinicalquery-reactivity: assert a same-practice `vd_*` update re-emits a snapshot via LISTEN/NOTIFY while a different-practice update does not (reactive correctness + tenant scoping).",
      "BF-08-sdk-result-no-throw: assert every SDK boundary method returns a Result value and never throws on a domain-error path."
    ],
    dangerChecks: ["propose-only-broken", "cross-tenant-leak", "fail-open-authz"],
    caps: {
      maxAttempts: 3,
      maxTurns: 80,
      maxBudgetUSD: 14
    },
    requiredAgents: ["planner", "maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-09",
    title: "Propose -> approve -> commit governance (agent cannot approve; denial audited)",
    profile: "agent-safety",
    goal: "Implement the propose -> approve -> commit governance flow for clinical writes so an agent actor can only propose; any approve or commit attempt by a non-clinician (agent/system) is default-denied and the denial is written to the tamper-evident audit chain, a Clinician can approve a proposed record, and an approved proposal commits to an immutable committed/signed-note record.",
    why: 'Propose-only governance is the core AI-safety boundary and the HIPAA 45 CFR 164.312 access-control control that stops an autonomous agent from approving or committing clinical data. "Agent able to approve/commit (propose-only invariant broken)" is one of the spec\'s named dangerous failure modes, so the invariant must be structurally enforced (default-deny) and eval-gated, never assumed; every governance decision including a denial must be auditable to the citation.',
    dependsOn: ["BF-02", "BF-03", "BF-05", "BF-08"],
    allowedPaths: [
      "packages/core/src/governance/**",
      "packages/core/src/index.ts",
      "packages/core/test/**",
      "packages/mcp/src/**",
      "packages/mcp/test/**",
      "apps/api/src/routes/governance/**",
      "apps/api/test/**",
      "drizzle/**",
      "loop/evals/governance/**"
    ],
    forbiddenPaths: [
      "packages/core/src/audit/**",
      "packages/core/src/abac/**",
      "packages/core/src/fhir/**",
      "loop/gates/**"
    ],
    acceptance: [
      "A governance state machine defines explicit states proposed -> approved -> committed plus denied/rejected; a transition test exercises every edge and rejects every illegal transition (e.g. proposed -> committed without approved) with a typed error, so a proposal can never reach committed without passing through approved.",
      "The approval/commit authority check is DEFAULT-DENY: an actor whose role is not clinician (an agent/system/MCP actor, or any unknown role, or an errored policy lookup) calling approve or commit returns Result { ok: false, error: { code: 'GOVERNANCE_FORBIDDEN' } }; a test asserts an agent actor is denied and the proposal state is unchanged.",
      "A Clinician actor (role clinician) CAN approve a proposed record, transitioning it to approved with a structured allow Result; a test asserts the clinician allow path succeeds and a non-clinician on the same proposal denies.",
      "An agent actor (role agent) CAN create a proposed record (propose is permitted); a test asserts propose succeeds for the agent, isolating that only approve/commit are denied, not propose.",
      "Every approve, commit, and denial appends a governance event to the BF-05 tamper-evident audit chain via the audit public API (no direct table write); a test asserts an agent's blocked approval attempt produces an audit record carrying actor, action, decision=deny, and reason (the 'denial audited' requirement), and that the record is hash-chain linked.",
      "The MCP tool registry (BF-08) exposes NO approve and NO commit tool: a test enumerates the live tool allowlist and asserts neither 'approve', 'commit', nor any tool that mutates governance state beyond proposed is present; only a propose tool can advance state from the agent surface.",
      "A committed/signed-note schema (Zod at the boundary + DB row) captures proposal id, committed FHIR resource reference, approver human identity, signed-at timestamp, and the audit hash of the commit event; the schema validates a golden committed record and rejects a record missing the approver identity or signature.",
      "A committed/signed record is immutable after commit: re-approve, re-commit, or any mutation of a committed record returns default-deny / a typed error and leaves state and the audit chain unchanged (test asserts no state change and no new commit event).",
      "All new public governance surface returns the Result<T, BonfireError> discriminated union at the boundary (authorization denials never throw across the public API); strict typecheck passes with no any, no @ts-ignore, and an exhaustive switch over the governance state union."
    ],
    verify: [
      "docker compose up -d",
      "bun run db:migrate",
      "bun test packages/core",
      "bun test packages/mcp",
      "bun test apps/api",
      "bun run typecheck",
      "bun run gate",
      "loop eval --slice BF-09"
    ],
    evals: [
      "propose-only-broken/agent-cannot-approve: an agent actor calling approve or commit is DENIED (default-deny); fails if the agent can transition a proposal to approved or committed.",
      "propose-only-broken/no-approve-commit-mcp-tool: the live MCP tool registry exposes no approve and no commit tool; fails if either is callable from the agent surface.",
      "fail-open-authz/clinician-only-approval: only role=clinician can approve (anything not an explicit clinician allow, including an errored policy lookup, denies); fails if a non-clinician approval succeeds.",
      "audit-bypass/governance-denial-audited: an agent's blocked approval attempt writes a hash-chain-linked audit record with decision=deny and a reason; fails if any approve/commit/deny governance action occurs without a corresponding audit entry.",
      "governance/committed-note-immutable: a committed/signed note cannot be re-approved, re-committed, or mutated; fails if a committed record changes state or emits a second commit event."
    ],
    dangerChecks: ["propose-only-broken", "fail-open-authz", "audit-bypass"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-10",
    title:
      "1-call FHIR R4 document-Bundle export + bring-your-own-bundle import (idempotent round-trip)",
    profile: "fhir",
    goal: "Add a single-call FHIR R4 document-Bundle export (Composition is the first entry, every reference resolves to a fullUrl inside the same Bundle) and a bring-your-own-bundle FHIR import path, with an idempotent export -> import -> export round-trip that is validated against the HL7 FHIR validator and guarded by the loss-ledger.",
    why: "Existing-FHIR teams need a zero-friction way to get data out (1-call document export) and in (BYO-bundle import) so Bonfire interops with the wider FHIR ecosystem. An idempotent, validator-checked, tenant-isolated round-trip is the concrete proof that the canonical store is truly lossless and RLS-safe \u2014 the credibility the open-source, agent-native positioning depends on.",
    dependsOn: ["BF-01", "BF-02", "BF-03", "BF-05", "BF-08"],
    allowedPaths: [
      "packages/core/src/fhir/export/**",
      "packages/core/src/fhir/import/**",
      "packages/core/src/fhir/bundle/**",
      "packages/sdk/src/fhir/**",
      "apps/api/src/routes/fhir/**",
      "fixtures/fhir/**",
      "docs/adr/**"
    ],
    forbiddenPaths: [
      "drizzle/**",
      "packages/core/src/db/**",
      "packages/core/src/fhir/mapping/**",
      "packages/mcp/**"
    ],
    acceptance: [
      "A single SDK call (and its 1:1 HTTP route) returns a FHIR R4 Bundle whose `type` is `document` and whose FIRST entry resource is a `Composition`.",
      "Reference closure: every `reference` in the exported Bundle resolves to an entry `fullUrl` contained in the same Bundle \u2014 a closure check asserts zero dangling references.",
      "The exported document Bundle passes the HL7 FHIR validator (R4 / US Core 6.1.0) reused from BF-03 with zero errors (conformance is validated by running the validator, never asserted in prose).",
      "Tenant isolation: an export executed under practice B contains no resource stamped with practice A's `practice_id`; a cross-tenant negative test confirms RLS fail-closed on the export and reference-resolution paths.",
      "Import accepts a bring-your-own FHIR R4 Bundle, validates it with the HL7 validator, and rejects (Result error, zero rows written) any Bundle that fails validation or carries an unsupported resource type.",
      "Import writes each resource to `fhir_resources` (canonical JSONB) + `history` in ONE atomic transaction stamped with the caller's `practice_id`; a forced mid-import failure rolls back leaving zero partial rows.",
      "Idempotent round-trip: export -> import -> export yields canonical resources byte-identical to the first export after deterministic normalization (stable ordering, server-assigned `meta.lastUpdated` ignored); re-importing the same Bundle twice produces no duplicate resources (idempotency key = resource logical id + practice_id).",
      "Loss-ledger guard: any field that does not survive the round-trip must have a matching loss-ledger ADR entry \u2014 a round-trip diff with no corresponding loss-ledger entry FAILS the gate.",
      "The public boundary returns the `Result<T, BonfireError>` discriminated union with stable `code`s (e.g. `FHIR_VALIDATION_FAILED`, `UNSUPPORTED_RESOURCE`, `CROSS_TENANT_DENIED`); no throw escapes the public boundary and authorization failures DEFAULT-DENY."
    ],
    verify: [
      "docker compose up -d",
      "bun test packages/core/src/fhir/export",
      "bun test packages/core/src/fhir/import",
      "bun test packages/core/src/fhir/bundle",
      "bun test packages/sdk/src/fhir",
      "bun test apps/api/src/routes/fhir",
      "bun run fhir:validate-export",
      "bun run gate"
    ],
    evals: [
      "fhir-export-document-shape: exported Bundle.type === 'document' and entry[0].resource.resourceType === 'Composition'",
      "fhir-export-reference-closure: exported document Bundle has zero dangling references (every reference target present as a fullUrl entry)",
      "fhir-export-cross-tenant-deny: export under practice B returns no resource bearing practice A's practice_id (cross-tenant-leak)",
      "fhir-import-rejects-invalid: a non-conformant or unsupported-resource Bundle is rejected via the HL7 validator with zero rows written (fake-conformance)",
      "fhir-import-atomic-rollback: a forced mid-import failure leaves zero partial rows in fhir_resources/history",
      "fhir-roundtrip-idempotent: export -> import -> export is byte-stable after normalization and re-import creates no duplicates (lossy-fhir)",
      "fhir-loss-ledger-required: a round-trip field drop with no matching loss-ledger ADR entry fails the gate (lossy-fhir)"
    ],
    dangerChecks: [
      "cross-tenant-leak",
      "lossy-fhir",
      "fake-conformance",
      "audit-bypass",
      "fail-open-authz"
    ],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 10
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-11",
    title:
      "BTAB benchmark: Synthea-primary, 3 arms, deterministic server-state grading + security axis, accuracy×cost Pareto (accuracy-per-1K secondary), SHA-256 pre-registered splits, publish RESULTS.md",
    profile: "benchmark",
    goal: "Build BTAB, the open benchmark that proves the thesis. PRIMARY data is a version-pinned, redistributable Synthea cohort (Apache-2.0) committed to the repo so the whole benchmark is one-command reproducible and synthetic-only. Run a fixed golden-query suite over three context arms (raw FHIR, compact JSON, Bonfire CCP) using a named per-model tokenizer. GRADING is deterministic server-state assertion (Bonfire IS the DB): READ tasks use executable FHIRPath/SQL reference answers with normalized exact-match — not an LLM judge as scorer of record. Report median tokens/query, task accuracy, citation precision/recall, and a security/governance axis as an accuracy×cost Pareto; accuracy-per-1K-tokens is a SECONDARY efficiency figure, never the ranking key. Publish a reproducible RESULTS.md over SHA-256 pre-registered splits, run >=3x at temp 0 with mean+/-variance.",
    why: 'BTAB is the project\'s marketing artifact and the moat is honesty: a reproducible, contamination-free benchmark is the only credible proof of the thesis. MIMIC-IV is a trap (its DUA forbids redistribution and closed-LLM-API use and breaks synthetic-only) so it can never be the turnkey headline; Synthea is the redistributable primary, with an optional MIMIC/FHIR-AgentBench secondary line for credentialed users only. Deterministic server-state grading (not an LLM judge) and reporting cheaper-as-measured rather than asserting "more accurate" are what make the number trustworthy; a fabricated, rounded-up, LLM-judge-scored, or non-reproducible number destroys the trust the entire open-source positioning depends on.',
    dependsOn: ["BF-02", "BF-05", "BF-06", "BF-07"],
    allowedPaths: [
      "apps/benchmark/**",
      "RESULTS.md",
      "docs/benchmark/**",
      ".github/workflows/btab.yml"
    ],
    forbiddenPaths: ["seed/**", "packages/**", "apps/api/**", "apps/demo/**", "drizzle/**"],
    acceptance: [
      "Exactly three named, selectable context arms are implemented \u2014 (a) raw FHIR (full canonical record), (b) compact JSON (non-cited compact serialization), (c) Bonfire CCP (span-cited projection) \u2014 and a unit test asserts each arm produces serialized context for every fixture query in the golden suite.",
      "A named tokenizer is declared and version-pinned per model; the runner refuses to emit token metrics when the tokenizer is unnamed/unpinned (default-deny), and token counts are computed via that named tokenizer (not a char/word heuristic). RESULTS.md records the tokenizer name + version.",
      "The PRIMARY benchmark corpus is a version-pinned, redistributable Synthea cohort (Apache-2.0; e.g. `bonfire-bench-v0`) committed under apps/benchmark/ with its Synthea version + seed recorded, loaded into Bonfire; RESULTS.md states the synthetic-data realism ceiling explicitly. Any MIMIC/FHIR-AgentBench comparison is an OPTIONAL secondary line gated behind credentialed access, never the redistributable headline.",
      "Grading is DETERMINISTIC server-state assertion, not an LLM judge as scorer of record: READ tasks compare the agent answer to an executable FHIRPath/SQL reference over the pinned cohort with normalized exact-match, and WRITE tasks assert the resulting FHIR/DB state + audit delta. An LLM judge may be used ONLY for irreducible free-text and, when used, is gated (report Cohen's kappa vs human, AB/BA position-bias < 0.10, a cross-family judge, >=500 hand-validated samples, false-negative skew) — a config that scores the headline via an LLM judge fails the gate.",
      "Metrics are computed and reported per arm: median tokens/query, task accuracy on the fixed golden-query suite, and citation precision/recall (CCP arm), reported as an accuracy×cost Pareto; accuracy-per-1K-tokens is reported as a SECONDARY efficiency figure and is NEVER used as the ranking key. Each run is executed >=3x at temperature 0 and RESULTS.md reports mean +/- variance. Each metric function has a unit test on known inputs with expected outputs.",
      "A security/governance axis is a first-class scored output: adversarial tasks where the correct outcome is a block/refusal (cross-tenant access attempt, ABAC-denied write, an agent attempting to commit) are scored, and RESULTS.md reports a safe-refusal rate and a cross-tenant-leak rate that MUST be 0 (a nonzero cross-tenant-leak rate fails the benchmark).",
      "A fixed, versioned golden-query suite is committed under apps/benchmark/ with count > 0, where every query carries an executable reference answer and expected gold citation spans (resource id + JSONB path).",
      "Held-out splits are SHA-256 pre-registered: a committed split manifest records each split's sha256; the runner verifies the live corpus split hash against the manifest before running and exits non-zero on any mismatch (no train/test contamination; default-deny).",
      "The token-delta metric runs fully OFFLINE with ZERO API keys via a documented command, is deterministic, and two consecutive runs over the same corpus+splits+tokenizer produce byte-identical token metrics.",
      "The benchmark corpus and RESULTS.md are SYNTHETIC-ONLY: the semantic synthetic-only scanner passes over apps/benchmark/** and RESULTS.md with zero real-PHI signals.",
      "RESULTS.md is published and self-describing: it states the baseline arm, the named tokenizer + version, the per-arm metric table, the SHA-256 split hashes, the corpus SHA, and the exact one-command reproduce instruction, plus the run date.",
      "Every headline figure in RESULTS.md (token-reduction ratio, accuracy, accuracy-per-1K-tokens) equals the value recomputed from the committed raw run records \u2014 a no-overclaim test recomputes from inputs and fails on any discrepancy beyond rounding it declares.",
      "No file outside allowedPaths is modified (allowed-paths diff check passes); the product packages, harness, seed, and migrations are consumed read-only, never edited."
    ],
    verify: [
      "bun install --frozen-lockfile",
      "turbo run build --filter=@bonfire/benchmark",
      "turbo run test --filter=@bonfire/benchmark",
      "bun run --cwd apps/benchmark bench:verify-splits",
      "bun run --cwd apps/benchmark bench:tokens",
      "bun run --cwd apps/benchmark bench:report -- --check",
      "git diff --exit-code RESULTS.md",
      "bun run gate"
    ],
    evals: [
      "btab-tokenizer-named: with the tokenizer unset/unpinned the runner refuses to emit token metrics (default-deny, non-zero exit); with it set, the emitted count matches the named tokenizer on a fixture record",
      "btab-split-integrity: tampering a pre-registered split file makes the runner detect a SHA-256 mismatch and exit non-zero before any metric is produced (no silent contamination)",
      "btab-token-determinism: two offline, zero-key runs over the same corpus+splits+tokenizer produce byte-identical token metrics (reproducibility)",
      "btab-no-overclaim: the reduction/accuracy/accuracy-per-1K figures written to RESULTS.md equal the values recomputed from the raw run records; a fabricated or rounded-up number fails the eval",
      "btab-results-traceable: RESULTS.md embeds the corpus SHA + split SHAs + tokenizer id, and the eval re-derives the headline metric from exactly those inputs",
      "btab-synthetic-only: the semantic synthetic-only scanner over the benchmark corpus + RESULTS.md returns zero real-PHI signals",
      "btab-three-arms: each of the raw-FHIR, compact-JSON, and CCP arms produces context and an answer for every golden query, and the CCP arm additionally emits citations scored for precision/recall",
      "btab-deterministic-grading: READ task scores are computed by executable FHIRPath/SQL reference answers (normalized exact-match), not an LLM judge; rewiring the headline score to an LLM judge fails the eval (the judge is allowed only for free-text under the kappa/position-bias gate)",
      "btab-security-axis: adversarial cross-tenant/ABAC-deny/agent-commit tasks are scored and RESULTS.md reports cross-tenant-leak rate = 0; a single leaked cross-tenant row fails the benchmark (security axis is first-class, not optional)",
      "btab-synthea-redistributable: the primary corpus is the committed version-pinned Synthea cohort and the benchmark runs end-to-end with zero credentialed/PHI data; making the headline depend on MIMIC/PhysioNet credentials fails the eval"
    ],
    dangerChecks: ["fake-conformance", "cross-tenant-leak"],
    caps: {
      maxAttempts: 3,
      maxTurns: 80,
      maxBudgetUSD: 12
    },
    requiredAgents: ["planner", "maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-12",
    title:
      "Flagship OSS AI-scribe reference app + npx bonfire init + LLM-consumable docs + compliance evidence pack + launch assets",
    profile: "docs-release",
    goal: 'Ship the flagship OSS AI-scribe reference app built entirely on Bonfire\'s public surface, an `npx bonfire init` scaffolder, LLM-consumable docs, a compliance evidence pack (machine-runnable RLS proofs, ABAC default-deny analysis, audit-chain verification, 45 CFR 164.312 map), and launch assets whose every claim is backed by a reproducible artifact. This is the final integration slice that re-proves the full danger surface end-to-end and delivers the "Done when" outcomes.',
    why: "The reference app is the onboarding funnel and the proof that Bonfire is a real agent-native backend, not a demo: a clean clone boots with zero API keys, a five-beat wow runs under 5 minutes, the BTAB number is published, and the compliance pack removes the HIPAA grunt work. Honesty is the moat \u2014 launch assets must link every conformance/benchmark claim to a reproducible artifact, and the app must demonstrate scope-before-retrieve, tenant isolation, audit integrity, and propose-only governance under real exercise.",
    dependsOn: [
      "BF-01",
      "BF-02",
      "BF-03",
      "BF-04",
      "BF-05",
      "BF-06",
      "BF-07",
      "BF-08",
      "BF-09",
      "BF-10",
      "BF-11"
    ],
    allowedPaths: [
      "apps/scribe/**",
      "packages/cli/**",
      "docs/compliance/**",
      "docs/llm/**",
      "evidence/**",
      "evals/BF-12/**",
      "tests/acceptance/**",
      "scripts/**",
      "AGENTS.md",
      "llms.txt",
      "README.md",
      "package.json",
      "turbo.json"
    ],
    forbiddenPaths: [
      "packages/core/**",
      "packages/server/**",
      "packages/sdk/**",
      "packages/mcp/**",
      "packages/fhir/**",
      "migrations/**",
      "scripts/**/synthetic*",
      "scripts/**/*scan*"
    ],
    acceptance: [
      "Clean clone: `bun install` then `docker compose up -d --wait` boots the full stack with ZERO API keys (no API key in any required env var); compose healthchecks report healthy and the documented health endpoint returns HTTP 200.",
      "`npx bonfire init <dir>` (published from packages/cli) scaffolds a runnable project from an empty directory, exits 0, and the scaffold itself boots with `docker compose up` \u2014 exercised by scripts/smoke-init.sh which exits non-zero on any failure.",
      "The reference AI-scribe app under apps/scribe builds and runs ENTIRELY on Bonfire's public surface: it imports only the typed SDK/MCP/HTTP surface (e.g. @bonfire/sdk), with zero direct imports of `pg`, raw SQL strings, `fhirpath`, or internal packages \u2014 enforced by dependency-cruiser/lint and asserted in the gate.",
      "An automated Playwright E2E walks the five-beat wow in the browser to completion, asserting each beat individually, with total wall-clock under 5 minutes and no API keys configured.",
      "Reference scribe flow is propose-only: the agent drafts a CCP-cited note; the note can only be committed/signed by the human approve action; the agent exposes no approve/commit tool and an attempted agent commit is denied and recorded in the audit chain.",
      "Cited search inside the app is scope-before-retrieve: results carry citations + freshness + policy receipt + audit id, and out-of-scope rows never reach the model (excludedByPolicy is populated for filtered rows).",
      "Cross-tenant isolation holds in the app: as practice A, no path (SDK, cited search, MCP) returns practice B's patient/encounter/note data; the RLS proof script demonstrates the deny and exits non-zero if any leak occurs.",
      "Compliance evidence pack shipped under docs/compliance/ + evidence/: (a) machine-runnable RLS proofs, (b) ABAC/policy default-deny analysis, (c) audit-chain verification that recomputes prev_hash/row_hash and detects a planted tamper, (d) a 45 CFR 164.312 mapping table linking \u00a7164.312(a) access control\u2192RLS, \u00a7164.312(b) audit\u2192hash-chained log, \u00a7164.312(c) integrity\u2192row_hash/prev_hash, \u00a7164.312(d) authn\u2192identity, \u00a7164.312(e) transmission\u2192TLS, each to specific code and a passing test.",
      "LLM-consumable docs shipped (AGENTS.md + llms.txt + docs/llm/) describing the typed write primitives, the CCP read surface, the typed MCP allowlist, and the propose-only invariant; a check asserts they reference the actual exported public surface (no stale or invented tool names).",
      "Launch assets shipped: the README headline BTAB number is sourced from BF-11 RESULTS.md (3 arms + named tokenizer stated), and `bun run check:claims` fails if any conformance/benchmark claim in README/launch copy lacks a backing reproducible artifact or its number drifts from the freshly generated artifact.",
      "At least one design-partner acceptance test is defined under tests/acceptance/ and passes against the running stack.",
      "No real PHI: the synthetic-only scanner passes over apps/scribe seed/fixtures and all BF-12 docs; nothing PHI-bearing is added to the repo.",
      "Full gate is green: `bun run gate` passes (tsc --build, eslint strict with no @ts-ignore/eslint-disable, knip, jscpd, dependency-cruiser, semgrep, secret scan, synthetic-only) and every touched file stays within allowedPaths (allowed-paths diff check passes)."
    ],
    verify: [
      "bun install --frozen-lockfile",
      "docker compose up -d --wait",
      "bun run typecheck",
      "bun run gate",
      "bun test apps/scribe",
      "bun run --filter @bonfire/cli test",
      "bash scripts/smoke-init.sh",
      "bun run evidence:verify",
      "bun run check:claims",
      "bunx playwright test apps/scribe/e2e/wow.spec.ts",
      "bun run evals -- --slice BF-12"
    ],
    evals: [
      "BF12-e2e-five-beat-wow-under-5min \u2014 Playwright walks the five beats end-to-end on the reference scribe app and asserts each beat plus total wall-clock < 5 minutes with zero API keys configured",
      "BF12-reference-app-scope-before-retrieve \u2014 scope-after-retrieve guard: the app's cited search applies the ABAC/RLS filter before retrieval; out-of-scope rows never reach the model and excludedByPolicy is populated",
      "BF12-reference-app-cross-tenant-deny \u2014 cross-tenant-leak guard: as practice A the scribe app cannot read practice B patient/encounter/note on any path (SDK, cited search, MCP)",
      "BF12-reference-app-propose-only \u2014 propose-only-broken guard: the agent can draft but has no approve/commit tool; only the human approve action commits, and an attempted agent commit is denied and audited",
      "BF12-evidence-pack-default-deny \u2014 fail-open-authz guard: a request with missing/invalid practice context returns a structured deny receipt, never data",
      "BF12-evidence-pack-audit-chain-verify \u2014 audit-bypass guard: the evidence script recomputes prev_hash/row_hash over the demo run and flags a planted tamper with a non-zero exit",
      "BF12-launch-claims-backed \u2014 fake-conformance guard: every conformance/benchmark claim in README/launch assets resolves to a reproducible command/artifact; an orphan claim or a number that drifts from the generated artifact fails the check",
      "BF12-design-partner-acceptance \u2014 the defined design-partner acceptance test passes against the running stack"
    ],
    dangerChecks: [
      "scope-after-retrieve",
      "cross-tenant-leak",
      "fake-conformance",
      "fail-open-authz",
      "audit-bypass",
      "propose-only-broken"
    ],
    caps: {
      maxAttempts: 3,
      maxTurns: 90,
      maxBudgetUSD: 15
    },
    requiredAgents: ["planner", "maker", "verifier", "security-auditor"],
    greptileRequired: true
  },
  {
    id: "BF-13",
    title:
      "BYO-auth verifier: external OIDC/JWT verification -> (iss,sub) membership mapping -> RLS tenant/role context (one IdP adapter; SMART vocabulary, server deferred)",
    profile: "security",
    goal: "Build the thin, IdP-agnostic identity boundary that connects external authentication to fail-closed RLS. A `verifyToken` function (jose: cached kid-aware JWKS with key rotation, a positive `alg` allow-list, asserted iss + aud + exp) returns a typed Result that fails closed; verified claims are mapped via a server-side `(iss, sub) -> membership` table to the practice_id + role used by BF-01's RLS GUC, set transaction-locally. One configurable OIDC adapter ships in v0; the SMART claim vocabulary (fhirUser, patient/clinician compartment) is adopted now so SMART is a later additive adapter, but the SMART authorization server is deferred.",
    why: "RLS is only as trustworthy as the code path that sets the tenant context, so the verified-identity -> practice_id bridge is the single load-bearing line that makes fail-closed multi-tenancy real for an agent-native backend. The dangerous failure modes are concrete and from-row-zero: algorithm-confusion / `alg:none`, missing iss/aud, trusting client-supplied tenant/role, and pooled-connection context bleed (session-level tenant context leaking across pooled-connection checkouts). Consuming verified identity (not being a SMART OAuth server) is the right, bounded v0 surface.",
    dependsOn: ["BF-01"],
    allowedPaths: [
      "packages/core/src/auth/**",
      "packages/core/src/index.ts",
      "packages/core/src/**/*.test.ts",
      "apps/api/src/auth/**",
      "apps/api/src/middleware/**",
      "apps/api/test/**",
      "drizzle/**",
      "docs/adr/**",
      "package.json"
    ],
    forbiddenPaths: [
      "packages/sdk/**",
      "packages/mcp/**",
      "packages/core/src/fhir/**",
      "packages/core/src/write/**"
    ],
    acceptance: [
      "`verifyToken` is exported with an explicit return type `Promise<Result<VerifiedIdentity, BonfireError>>`; it verifies the signature against a cached, kid-aware JWKS fetched from the configured IdP (supporting key rotation), enforces a positive `alg` allow-list (e.g. RS256/ES256/EdDSA), and asserts `iss`, `aud`, and `exp`. No `any`/`as`/`@ts-ignore`/eslint-disable; input/output parsed by Zod 4 at the boundary.",
      "Algorithm-confusion and `alg:none` are rejected: a token with `alg:none`, or an RS256-issued token re-signed as HS256 with the public key, fails verification (returns a typed error, fails closed) -- the `alg` is taken from the configured allow-list, never trusted from the token header.",
      "Missing/invalid `iss` or `aud`, an expired token, an unknown kid, or any verification error returns a Result error and sets NO tenant context, so BF-01's default-deny RLS returns zero rows (verification failure fails closed, never throws across the boundary).",
      "Claims are NOT trusted for authorization scope: practice_id and role are resolved by a server-side `(iss, sub) -> membership` lookup (a tenant-scoped table), never read from a token claim or any request body/header; a token whose `sub` has no membership row is denied (no tenant context set).",
      "The resolved practice_id/role is applied to RLS context ONLY via the transaction-local pooling-safe pattern (`set_config('app.current_practice_id', $1, true)` inside the per-request transaction), reusing BF-01's `db.withTenant()` wrapper; bare/session `SET` for `app.*` is absent (an ast-grep/semgrep rule bans it) and practice_id never originates from request input (a rule bans `practice_id` from request body/header).",
      "Pooled-connection no-bleed: an integration test runs request B (practice B identity) on the physical pooled connection just used by request A (practice A) and asserts B sees only practice B context and a fresh connection with no verified identity yields zero rows (transaction-local context never leaks across checkouts).",
      "BYO-IdP by config: the verifier accepts any OIDC issuer via configuration (issuer URL + JWKS URL + audience + claim-name map); exactly one adapter is wired in v0 and no auth vendor SDK is bundled. The identity claim is named per the SMART vocabulary (`fhirUser`) and roles model patient-vs-clinician compartments, but no SMART authorization-server endpoints (authorize/token/.well-known/smart-configuration) are implemented (explicitly deferred).",
      "Every authentication decision (success and failure) emits exactly one append-only hash-chained audit entry (BF-05 audit API) carrying the actor identity (iss,sub), the resolved practice_id (or none), and the decision; a denied verification still writes an audit row.",
      "`bun run gate` passes (strict typecheck/no-any, eslint with no escape hatches, dependency-cruiser boundaries, semgrep, secret scan, synthetic-only, allowed-paths); all tokens/keys used in tests are synthetic, generated in-test, and no real secret is committed."
    ],
    verify: [
      "docker compose up -d",
      "bun install --frozen-lockfile",
      "bun run db:migrate",
      "bun test packages/core",
      "bun test apps/api",
      "bun run gate"
    ],
    evals: [
      "bf-13-alg-confusion-rejected: `alg:none` and an RS256->HS256 re-sign are both rejected (the alg comes from the allow-list, not the token header) -- fail-open-authz guard.",
      "bf-13-iss-aud-exp-enforced: a token with a wrong/absent iss or aud, or an expired exp, is rejected and sets no tenant context.",
      "bf-13-claims-not-trusted: a verified token whose claims assert a different practice_id/role than its `(iss,sub)` membership row is scoped by the MEMBERSHIP row, not the claim; a sub with no membership is denied (privilege-escalation guard).",
      "bf-13-verify-fail-closed: any verification error sets no GUC and BF-01 default-deny returns zero rows (never throw-to-allow).",
      "bf-13-pool-no-bleed: request B on request A's pooled connection sees only B's context; a fresh connection with no identity returns zero rows (cross-tenant-leak / pooler-bleed guard).",
      "bf-13-auth-decision-audited: each success and failure writes exactly one hash-chained audit row carrying (iss,sub), resolved practice_id, and decision."
    ],
    dangerChecks: ["fail-open-authz", "cross-tenant-leak", "audit-bypass"],
    caps: {
      maxAttempts: 3,
      maxTurns: 70,
      maxBudgetUSD: 11
    },
    requiredAgents: ["maker", "verifier", "security-auditor"],
    greptileRequired: true
  }
];
