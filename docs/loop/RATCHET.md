# The Ratchet — bug classes this repo must never repeat

> GENERATED from `loop/memory/bug-patterns.jsonl` by `bun run loop ratchet --write`.
> Do not edit by hand. A GUARDED entry's guard is machine-verified by
> `loop ratchet` (and the test suite): if the guard artifact disappears,
> the check fails and the bug is considered reopened.

14 guarded · 10 open (debt owed a guard)

## BP-001 — gate-crash-read-as-pass — GUARDED

- Symptom: A gate tool that crashed, was missing, or was killed was reported as a pass; broken code merged behind green CI.
- Root cause: The gate runner read an absent exit status or spawn error as success instead of failure (fail-open-by-omission).
- Fix: runCommand collapses spawn error, non-zero exit, and signal kill into ok:false (loop/src/gates/exec.ts); strict mode also fails a skipped blocking gate.
- Guard: `test` → `loop/src/gates/exec.test.ts::a MISSING tool fails closed`
- Recorded: 2026-06-25

## BP-002 — gate-ordering — GUARDED

- Symptom: Expensive judge/eval stages ran (and could green a slice) despite an earlier deterministic gate failure.
- Root cause: No enforced stage ordering: deterministic gates did not short-circuit later stages, so a red Stage 0 could still reach Stage 2+.
- Fix: runGates aggregates failures within a stage but short-circuits between stages; skipped stages are reported, never silently passed (loop/src/gates/run.ts).
- Guard: `test` → `loop/src/gates/run.test.ts::short-circuits stage 1`
- Recorded: 2026-06-25

## BP-003 — greptile-race — OPEN

- Symptom: Automated Greptile polling raced review completion and auto-proceeded on a stale or incomplete review (8 incidents in the prior harness).
- Root cause: ~1100 LOC of polling logic treated an in-flight review as terminal; automation held merge authority that belonged to a human.
- Fix: Polling deleted entirely; Greptile is a required status check and the final merge is always human (plan decision A4).
- Planned guard: eval: greptile-race seeded incident eval (T9/H5, loop/evals)
- Recorded: 2026-06-25

## BP-004 — fail-open-authz — GUARDED

- Symptom: An authorization check that threw or returned a non-explicit result was treated as an allow; errors read as permission.
- Root cause: Authz result handling defaulted open: anything that was not an explicit deny (including an exception) fell through to allow.
- Fix: Default-deny everywhere: only an explicit {allow:true} grants access; structural rule bans fail-open authz shapes (sgrules/no-fail-open-auth.yml, semgrep bonfire-authz-allow-by-default).
- Guard: `ast-grep` → `sgrules/no-fail-open-auth.yml`
- Recorded: 2026-06-25

## BP-005 — cross-tenant-leak — OPEN

- Symptom: One request's tenant context bled into the next request on a reused pooled DB connection; rows belonging to another tenant became readable.
- Root cause: Tenant context was set with session-level SET on a pooled connection; the checkout that followed inherited the previous request's practice_id.
- Fix: Transaction-local context only: set_config('app.current_practice_id', $1, true) inside the per-request transaction; bare/session SET for app.* is banned by contract (BF-01/BF-13).
- Planned guard: ast-grep: ban session-level SET for app.* GUCs + eval bf-13-pool-no-bleed (BF-13)
- Recorded: 2026-06-25

## BP-006 — scope-after-retrieve — OPEN

- Symptom: Policy scope was applied AFTER retrieval: out-of-scope rows entered the candidate set and could leak through ranking, counts, or error paths.
- Root cause: Retrieval queried first and filtered later, so the policy boundary sat above the data instead of in front of it.
- Fix: Scope-before-retrieve is a slice contract invariant: the ABAC/RLS scope constrains the query itself and every read carries a policy receipt (BF-06).
- Planned guard: eval: scope-before-retrieve golden test with policy receipt (BF-06/T9, loop/evals)
- Recorded: 2026-06-25

## BP-007 — audit-bypass — OPEN

- Symptom: Audit history could be overwritten in place, so tampering with past events was undetectable.
- Root cause: Audit rows were plain mutable rows with no tamper-evidence chain linking each entry to its predecessor.
- Fix: Append-only audit with prev_hash + row_hash chain; every write path emits exactly one audit event and chain verification detects tamper (BF-05).
- Planned guard: eval: hash-chain tamper eval (BF-05/T9, loop/evals)
- Recorded: 2026-06-25

## BP-008 — lossy-fhir — OPEN

- Symptom: Typed projections silently dropped FHIR fields; data appeared complete while the canonical record lost information.
- Root cause: The typed model was treated as the source of truth, so fields it did not model vanished on write instead of being preserved in the canonical FHIR document.
- Fix: FHIR R4 JSONB is canonical and the typed primitive is a projection; any dropped field requires a loss-ledger entry with ADR + human sign-off (BF-03).
- Planned guard: eval: FHIR R4 round-trip eval (BF-03/T9, loop/evals)
- Recorded: 2026-06-25

## BP-009 — hardcoded-host-port-collision — GUARDED

- Symptom: docker compose up failed on hosts where the published host port was already taken: a local Postgres on 5432 collided with the db service's fixed bind, and a collision can silently point tests at the wrong server.
- Root cause: Published host ports were fixed literals in docker-compose.yml, so the host environment could not remap them.
- Fix: Every published port is env-overridable with a synthetic default (127.0.0.1:${DB_HOST_PORT:-5432}:5432, 127.0.0.1:${API_PORT:-8080}:8080); dev hosts with a local Postgres export DB_HOST_PORT=55432.
- Guard: `test` → `loop/src/gates/docker-invariants.test.ts::published host ports are env-overridable`
- Recorded: 2026-07-03

## BP-010 — bun-isolated-linker-breaks-docker-copy — GUARDED

- Symptom: The api image built but the runtime stage was missing workspace dependencies: the node_modules copied into the image resolved to dangling symlinks.
- Root cause: bun 1.3's default isolated linker lays out per-workspace node_modules as symlinks into a central store, which a single-directory Docker COPY of node_modules does not preserve.
- Fix: docker/api.Dockerfile installs with bun install --frozen-lockfile --production --linker hoisted so all packages land under root node_modules and survive the COPY (rationale pinned in the Dockerfile).
- Guard: `test` → `loop/src/gates/docker-invariants.test.ts::api image bun install uses the hoisted linker`
- Recorded: 2026-07-03

## BP-011 — gate-false-positive-pushes-unsafe-workaround — GUARDED

- Symptom: The template clause of semgrep rule bonfire-mcp-tool-raw-sql-concat flagged postgres.js sql tagged-template queries — the safe, bound-parameter idiom — so BF-01 shipped a sql.unsafe(constantLiteral, [params]) workaround to pass the gate: the gate steered code toward a less-reviewable API.
- Root cause: A text regex cannot distinguish a tagged template (interpolations bound as parameters by the sql tag) from an untagged template literal that splices values into statement text.
- Fix: Operator-reviewed refinement (exemption keyed to templates tagged exactly sql, statement-anchored keywords) + tenant.ts restored to the tagged-template idiom + a semgrep --test behaviour corpus (sgrule-tests/semgrep, run by the semgrep gate and CI) proving each rule fires on its KNOWN bad shapes and stays silent on the sanctioned idioms. Residual denylist-evasion shapes (typed/member/aliased fake tags, off-call-site string building) are tracked as [[BP-020]] — the load-bearing control against them is banning the .unsafe sink, not the name-keyed exemption.
- Guard: `test` → `sgrule-tests/semgrep/semgrep.ts::ruleid: bonfire-mcp-tool-raw-sql-concat`
- Recorded: 2026-07-03

## BP-012 — raw-db-client-bypasses-tenant-boundary — GUARDED

- Symptom: Nothing stopped product code from constructing its own postgres.js client and querying outside withTenant(), running statements with no tenant GUC bound — one privileged role or pooling misconfiguration away from a cross-tenant read.
- Root cause: @bonfire/core deliberately does not export its client factory, but any file could import postgres directly and mint a connection that skips the tenant boundary.
- Fix: ast-grep rule no-raw-postgres-client bans value imports of postgres outside packages/core/src/db/**; sanctioned, documented exemptions: the api /health catalog probe (apps/api/src/app.ts, non-tenant, connects as bonfire_app), seed/** and scripts/** dev surfaces, and test files (isolation proofs).
- Guard: `ast-grep` → `sgrules/no-raw-postgres-client.yml`
- Recorded: 2026-07-03

## BP-013 — service-port-published-beyond-loopback — GUARDED

- Symptom: The api service published its port on 0.0.0.0: every docker compose up exposed the dev API — and the tenant data it fronts — to the local network.
- Root cause: The compose port mapping omitted the loopback host prefix and nothing checked published bind addresses.
- Fix: api publishes 127.0.0.1:${API_PORT:-8080}:8080 (db was already loopback-only); the docker-invariants test rejects any published port that does not bind 127.0.0.1.
- Guard: `test` → `loop/src/gates/docker-invariants.test.ts::published host ports bind loopback only`
- Recorded: 2026-07-03

## BP-014 — rls-guc-cast-error-channel — GUARDED

- Symptom: A garbage (non-UUID, non-empty) app.current_practice_id makes every query on an RLS-scoped table raise 22P02 invalid input syntax instead of returning zero rows — tenant scoping degrades into an error channel that callers can catch, retry without context, or surface as 500s.
- Root cause: The policy predicate casts the GUC with a bare ::uuid, which throws on malformed input; NULLIF folds only the empty string, not arbitrary garbage.
- Fix: Migration 0001_rls_safe_uuid: safe_uuid() (STABLE, pg_input_is_valid; garbage folds to NULL, NULL predicate = zero rows) and the rls_scaffold policy rewritten onto the InitPlan-wrapped (SELECT safe_uuid(...)) template — the template BF-02 stamps onto fhir_resources/history/write_inputs.
- Guard: `test` → `packages/core/src/db/rls.test.ts::a garbage practice context yields zero rows`
- Recorded: 2026-07-03

## BP-015 — jsonb-param-double-encode — GUARDED

- Symptom: fhir_resources/history content rows held jsonb STRING SCALARS (serialized JSON inside a JSON string) instead of documents; reads that navigated the document returned undefined and re-canonicalized hashes diverged from the stored content_hash.
- Root cause: `${JSON.stringify(doc)}::jsonb` through postgres.js binds the string with the jsonb parameter type, so the cast is a no-op on an already-jsonb string value — the document is double-encoded (live probe: jsonb_typeof = 'string'; sql.json(doc) yields 'object').
- Fix: All six content-write sites use sql.json(doc); the idiom is purged from tests; the fhir-rls schema-catalog test asserts jsonb_typeof(content) = 'object' over every stored row (inversion-proof); the maker's own read-back parity test is what caught the corruption pre-merge.
- Guard: `semgrep` → `bonfire-jsonb-stringify-double-encode`
- Recorded: 2026-07-03

## BP-016 — cache-restore-clobbers-workspace-symlink — GUARDED

- Symptom: apps/api's @bonfire/core resolved to an empty husk (a real directory holding one stray .tsbuildinfo) after turbo cache activity: typed lint failed with 'type could not be resolved' across the api while root-invoked runs stayed green.
- Root cause: turbo task output globs `**/*.tsbuildinfo` walked THROUGH the node_modules workspace symlink during output capture; a later cache restore materialized the captured path as a real directory OVER the symlink, shadowing the package.
- Fix: Output globs scoped to the workspace's own build dirs (dist/**, build/**); the noEmit typecheck task declares no outputs and dependsOn ^build so referenced dist is always fresh; poisoned cache purged; the turbo-outputs test rejects any output glob starting at ** or touching node_modules.
- Guard: `test` → `loop/src/gates/turbo-outputs.test.ts::output globs never start at ** or traverse node_modules`
- Recorded: 2026-07-03

## BP-017 — error-message-echoes-scanned-content — OPEN

- Symptom: JSON.parse failures in the PHI scanner and seed propagated the runtime's error message verbatim to logs; those messages embed a snippet of the source text, so scanning a malformed PHI-bearing file could print a fragment of a real identifier.
- Root cause: Operational-error paths trusted exception messages, but parser exceptions quote their input — the one tool pointed at suspect files could leak what it exists to catch.
- Fix: All JSON.parse sites in scripts/synthetic-scan and seed catch and rethrow location-only messages ('invalid JSON in <file> (content not shown)'); the catch-all handlers now only ever see redacted messages on parse paths.
- Planned guard: scanner test harness (H5 eval wave): feed a malformed PHI-bearing fixture and assert the operational-error output contains no scanned-file content
- Recorded: 2026-07-03

## BP-018 — append-only-by-forgotten-revoke — OPEN

- Symptom: Append-only tables are one forgotten REVOKE away from mutable: the initdb default privileges pre-grant UPDATE/DELETE on every FUTURE table, so a migration that omits the explicit REVOKE silently ships a mutable 'append-only' table.
- Root cause: docker/initdb/010-roles.sh ALTER DEFAULT PRIVILEGES grants S/I/U/D wholesale, making immutability opt-out per migration instead of opt-in.
- Fix: BF-02's migration carries explicit REVOKEs (proven by has_table_privilege tests); the structural fix — flip the default grant to SELECT,INSERT and grant U/D explicitly on mutable tables, plus a catalog posture test over declared append-only tables — needs a docker/** harness wave.
- Planned guard: harness wave: initdb default-privilege flip to S/I-only + a catalog posture test enumerating append-only tables (queue before BF-05's audit table lands)
- Recorded: 2026-07-03

## BP-019 — unique-constraint-existence-oracle — OPEN

- Symptom: PK/UNIQUE/FK enforcement bypasses RLS by design: a caller supplying its own resource id gets a distinguishable failure when that id exists in ANOTHER practice — a cross-tenant id-existence probe and an id-squatting DoS (ids only, never content; random UUIDs make blind probing infeasible).
- Root cause: fhir_resources uses a global PRIMARY KEY (id) + UNIQUE (type,id); uniqueness errors are constraint-level, beneath the RLS policy filter.
- Fix: Deferred by decision: tenant-scoped composite keys (PK (practice_id,id)) or normalized 23505 handling on insert — decide with BF-04's projection identity design; danger is LOW while ids are server-generated UUIDs.
- Planned guard: eval (H5): unique-constraint existence-oracle case — a practice-B insert with practice-A's id must be indistinguishable from any other failed insert
- Recorded: 2026-07-03

## BP-020 — sql-gate-denylist-evasion — GUARDED

- Symptom: An adversarial refutation swarm bypassed the SQL-template semgrep rules and the no-sql-tag-impersonation ast-grep rule: build statement text in a local via concat/Array.join/String.concat then pass the VARIABLE to sql.unsafe() (evades both call-site-local regexes and reaches simple-protocol stacked statements that can re-bind the tenant GUC -> cross-tenant); or declare a fake `sql` tag with a type annotation / member position / import alias (typed-lint forces the very annotations the denylist patterns miss).
- Root cause: The sql-template rules are call-site/shape local and the sql-tag exemption is keyed on the identifier NAME, so a determined maker writing idiomatic typed TS can route raw SQL to an execution sink the regexes cannot see.
- Fix: Load-bearing control added: ast-grep no-raw-sql-unsafe bans a non-string-literal argument to .unsafe() — the ONLY execution sink a built string or fake tag could reach (a fake tag's output otherwise becomes a bound param in the real sql tag, and no-raw-postgres-client blocks new clients). BP-015 broadened to catch extracted-variable and CAST(...AS jsonb) forms. no-sql-tag-impersonation extended to async/let/var shapes as defense-in-depth. Residual: the impersonation denylist is still incomplete for typed/member/aliased declarations (within-tenant only once the .unsafe sink is closed).
- Guard: `ast-grep` → `sgrules/no-raw-sql-unsafe.yml`
- Recorded: 2026-07-03

## BP-021 — phi-tripwire-silent-narrowing — GUARDED

- Symptom: The synthetic-only scanner self-tests detector classes on a HARDCODED planted fixture, decoupled from the sweep set — so emptying SCAN_ROOTS, dropping a class from ALL_RULES, or deleting the scanner (behind a fail-open CI `if [ -f ]` guard) leaves the run green while sweeping nothing (proven: SCAN_ROOTS=[] exits 0).
- Root cause: Self-test coverage != scan coverage, and the scanner's config (scripts/**) sits outside GLOBAL_FORBIDDEN_PATHS, so a future maker could narrow scope and pass allowed-paths too; CI's only tripwire enforcement was one fail-open-guarded step.
- Fix: synthetic-scan-wiring pin test (runs in CI build-test via turbo test) asserts SCAN_ROOTS non-empty + covers fixtures/synthetic, ALL_RULES has all 6 canonical classes, the scan:synthetic script + loop gate + CI step exist; the CI scan and semgrep --test steps made unconditional (deletion is now a red check). Residual (open [[BP-022]]): scan EXTENSION/ROOT scope is narrow (.ndjson/.json under fixtures/synthetic only) and baseline.json is same-commit-forgeable-with-review; scripts/synthetic-scan/** not yet on the allowed-paths floor.
- Guard: `test` → `loop/src/gates/synthetic-scan-wiring.test.ts::SCAN_ROOTS still covers the synthetic fixture corpus`
- Recorded: 2026-07-03

## BP-022 — phi-tripwire-scope-narrow — OPEN

- Symptom: PHI-shaped data can land undetected outside the scanner's narrow scope: a non-.ndjson/.json file inside fixtures/synthetic (e.g. .csv), or any file under seed/ inline literals, tests/, docs/, or a new fixtures/ subdir, is swept by NO gate (gitleaks=secrets, semgrep=SQL/authz — neither detects PHI names/MRNs/DOBs). baseline.json entries are forgeable in the same commit (visible-but-reviewed suppression).
- Root cause: SCAN_ROOTS + SCAN_EXTENSIONS are minimal for BF-02's corpus; the tripwire guarantees less than 'no PHI can land'.
- Fix: (deferred) broaden SCAN_ROOTS/EXTENSIONS as later slices add fixture surfaces (BF-03 fixtures/golden, BF-11 benchmark corpus); add scripts/synthetic-scan/** to GLOBAL_FORBIDDEN_PATHS; make baseline additions require a separate reviewer signal.
- Planned guard: per-slice SCAN_ROOTS expansion + allowed-paths floor for the scanner internals + baseline provenance check (queue across BF-03/BF-11)
- Recorded: 2026-07-03

## BP-023 — new-workspace-missing-from-dockerfile — GUARDED

- Symptom: Adding `seed` to the root package.json workspaces broke the api Docker build: `bun install --frozen-lockfile --production` failed with 'Workspace not found seed' because docker/api.Dockerfile COPYs workspace manifests by explicit list. Invisible locally (docker compose reused a cached image); red only on a fresh CI build.
- Root cause: The Dockerfile enumerates each workspace manifest to COPY, so a newly-declared workspace whose manifest is not added is absent when bun resolves the workspace graph — and local compose runs don't rebuild the image, hiding it.
- Fix: COPY seed/package.json in both the deps and runtime stages (mirroring loop/); full `docker build` reproduced the failure and confirmed the fix. The docker-invariants test now asserts every non-glob root workspace has a matching COPY in the Dockerfile.
- Guard: `test` → `loop/src/gates/docker-invariants.test.ts::every non-glob root workspace manifest is COPYed for install`
- Recorded: 2026-07-03

## BP-024 — db-test-depends-on-unrun-boot-step — OPEN

- Symptom: seeded-state.test.ts asserts seed row counts but does not seed; it passed locally (operator ran `bun run seed` first per the verify[] order) and failed in CI, whose generic `turbo run test` boot only migrated. Green locally, red on a fresh CI runner.
- Root cause: A DB-backed test carried an implicit precondition (the seed having run) that it did not establish itself, so correctness depended on the runner's boot order rather than the test.
- Fix: CI boot step now mirrors the slice verify[] order (migrate then seed) so the DB-backed tests run against the same synthetic state the contract establishes. The durable fix — make DB-backed tests self-seed (hermetic) so no bare `bun test` depends on boot order — is owed.
- Planned guard: hermetic DB tests: a shared test-setup that seeds idempotently in beforeAll (or moves the seed-contract test into the seed workspace where it can import + run the seeder), so ordering is never implicit — build with BF-03's write-path tests
- Recorded: 2026-07-03
