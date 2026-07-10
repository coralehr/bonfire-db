# The Ratchet — bug classes this repo must never repeat

> GENERATED from `loop/memory/bug-patterns.jsonl` by `bun run loop ratchet --write`.
> Do not edit by hand. A GUARDED entry's guard is machine-verified by
> `loop ratchet` (and the test suite): if the guard artifact disappears,
> the check fails and the bug is considered reopened.

38 guarded · 1 open (debt owed a guard)

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

## BP-005 — cross-tenant-leak — GUARDED

- Symptom: One request's tenant context bled into the next request on a reused pooled DB connection; rows belonging to another tenant became readable.
- Root cause: Tenant context was set with session-level SET on a pooled connection; the checkout that followed inherited the previous request's practice_id.
- Fix: Transaction-local context only: withTenant sets set_config('app.current_practice_id', $1, true) as the FIRST statement of every per-request transaction (packages/core/src/db/tenant.ts), so the GUC dies with the transaction and a pooled connection can never bleed practice A context into practice B's next checkout. Session/bare SET for app.* GUCs is banned structurally by the semgrep rule bonfire-session-set-app-guc (allows set_config(...,true)/SET LOCAL, rejects set_config(...,false)/bare SET), and no code can mint a client that skips withTenant (BP-012 no-raw-postgres-client). The bf13-pool-no-bleed Stage-2 eval is the live behavioural proof: on a max:1 pool a session SET DOES bleed across a checkout (positive control), while the product withTenant path delivers per-checkout tenant isolation and a no-identity connection default-denies to zero rows.
- Guard: `semgrep` → `bonfire-session-set-app-guc`
- Recorded: 2026-06-25

## BP-006 — scope-after-retrieve — GUARDED

- Symptom: Policy scope was applied AFTER retrieval: out-of-scope rows entered the candidate set and could leak through ranking, counts, or error paths.
- Root cause: Retrieval queried first and filtered later, so the policy boundary sat above the data instead of in front of it.
- Fix: BF-06: scope-before-retrieve is structural. deriveScope probes the BF-05 decide() authority per searchable type BEFORE any row is fetched; a non-allow decision drops the type into excludedByPolicy (types + reasons + count, NEVER row-ids — no BP-019 existence oracle) and, when nothing is allowed, ZERO fusion SQL runs (no candidate set to filter). The scope predicate (resource_type = any(allowed)) is INLINE in each arm's base WHERE and RLS supplies practice_id; every search returns a structured policyReceipt + one audit event. The Stage-2 eval proves it on the BUILT product across the firewall: a product-side query spy shows a denied search reads search_doc ZERO times while an allowed search reads it (non-vacuous); removing the deny short-circuit reddens it.
- Guard: `eval` → `loop/evals/bf06.jsonl::bf06-scope-before-retrieve`
- Recorded: 2026-06-25

## BP-007 — audit-bypass — GUARDED

- Symptom: Audit history could be overwritten in place, so tampering with past events was undetectable.
- Root cause: Audit rows were plain mutable rows with no tamper-evidence chain linking each entry to its predecessor.
- Fix: BF-05: authorizeAndAudit appends UNCONDITIONALLY (no allow/deny branch — every decision emits exactly one row); audit_log is append-only for the app (GRANT S/I + REVOKE U/D under the BP-018 flipped default, 42501 proven); the per-practice hash chain (row_hash=sha256(canonical(fields+prev_hash)), domain-separated genesis, advisory-lock append, UNIQUE(practice_id,seq)+(practice_id,prev_hash) backstops) makes any partial tamper detectable at the exact broken link. The Stage-2 eval proves THIRD-PARTY verifiability: an independent oracle (zero product code) appends spec-conformant rows, verifies the stored chain, detects an owner-mutated row at the exact index, and re-verifies clean after restore.
- Guard: `eval` → `loop/evals/bf05.jsonl::bf05-audit-tamper-detect`
- Recorded: 2026-06-25

## BP-008 — lossy-fhir — GUARDED

- Symptom: Typed projections silently dropped FHIR fields; data appeared complete while the canonical record lost information.
- Root cause: The typed model was treated as the source of truth, so fields it did not model vanished on write instead of being preserved in the canonical FHIR document.
- Fix: FHIR R4 JSONB is canonical and the typed primitive is a projection (BF-03): the write path persists+hashes the mapped canonical FHIR, never the typed input; fhir:roundtrip enforces lossless-or-ledgered (a round-trip diff with no loss-ledger entry whose ADR exists FAILS the gate). Proven by the three-state inversion test.
- Guard: `test` → `packages/core/src/fhir/roundtrip.test.ts::lossless-or-ledgered three-state inversion`
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

## BP-017 — error-message-echoes-scanned-content — GUARDED

- Symptom: JSON.parse failures in the PHI scanner and seed propagated the runtime's error message verbatim to logs. On V8/Node those messages embed a snippet of the source text (a real-PHI fragment could leak); on Bun/JSC — the actual runtime — the message is content-free ("JSON Parse error: Expected '}'"), so the leak is latent, not live. Redacting is correct defense-in-depth and makes the error path runtime-independent.
- Root cause: Operational-error paths trusted exception messages, but parser exceptions quote their input — the one tool pointed at suspect files could leak what it exists to catch.
- Fix: All JSON.parse sites in scripts/synthetic-scan and seed catch and rethrow a location-only message ('invalid JSON in <file> (content not shown)'). The execution eval spawns the built scanner on a committed malformed input and asserts the operational-error output carries that sentinel (inversion-proof: reverting the redaction drops it), never echoes the canary marker (cross-runtime leak guard), and exits on the operational-error code.
- Guard: `eval` → `loop/evals/bf02.jsonl::bf02-scanner-error-redacts-content`
- Recorded: 2026-07-03

## BP-018 — append-only-by-forgotten-revoke — GUARDED

- Symptom: Append-only tables are one forgotten REVOKE away from mutable: the initdb default privileges pre-grant UPDATE/DELETE on every FUTURE table, so a migration that omits the explicit REVOKE silently ships a mutable 'append-only' table.
- Root cause: docker/initdb/010-roles.sh ALTER DEFAULT PRIVILEGES grants S/I/U/D wholesale, making immutability opt-out per migration instead of opt-in.
- Fix: BP-018 wave (BF-05 prep): initdb docker/initdb/010-roles.sh ADP flipped to GRANT SELECT,INSERT only (append-only is now opt-out->opt-in, fail-closed); every mutable table grants U/D explicitly (fhir_resources/spidx in migrations, rls_scaffold in 0006, vd_* in the projection DDL generator ddl.ts); the audit_log table (0007) is append-only by the flipped default + REVOKE belt. A catalog posture test pins the full matrix (append-only S/I-only incl. audit_log, terminology read-only, mutable positive controls U/D).
- Guard: `test` → `packages/core/src/db/fhir-rls.test.ts::BP-018 posture`
- Recorded: 2026-07-03

## BP-019 — unique-constraint-existence-oracle — GUARDED

- Symptom: PK/UNIQUE/FK enforcement bypasses RLS by design: a caller supplying its own resource id gets a distinguishable failure when that id exists in ANOTHER practice — a cross-tenant id-existence probe and an id-squatting DoS (ids only, never content; random UUIDs make blind probing infeasible).
- Root cause: fhir_resources uses a global PRIMARY KEY (id) + UNIQUE (type,id); uniqueness errors are constraint-level, beneath the RLS policy filter.
- Fix: DONE (migration 0010): tenant-scoped identity. fhir_resources PK (id)->(practice_id,id); history PK ->(practice_id,id,version_id); write_inputs UNIQUE(fhir_resource_id)->(practice_id,fhir_resource_id) with a COMPOSITE FK to fhir_resources(practice_id,id). Every uniqueness scope on a client-influenceable value now leads with practice_id, so a cross-tenant duplicate id SUCCEEDS as the caller's own row (probe transfers zero bits) and the RLS-bypassing FK check cannot see across tenants. Server-generated UUIDv4 ids kept (no uuidv7 timestamp leak); seed on-conflict arm re-targeted to (practice_id,id).
- Guard: `eval` → `loop/evals/bf02.jsonl::bf02-tenant-id-namespace`
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
- Guard: `test` → `loop/src/gates/synthetic-scan-wiring.test.ts::the scanner sweeps deny-by-default (git ls-files), not a shrinkable allowlist`
- Recorded: 2026-07-03

## BP-022 — phi-tripwire-scope-narrow — GUARDED

- Symptom: PHI-shaped data can land undetected outside the scanner's narrow scope: a non-.ndjson/.json file inside fixtures/synthetic (e.g. .csv), or any file under seed/ inline literals, tests/, docs/, or a new fixtures/ subdir, is swept by NO gate (gitleaks=secrets, semgrep=SQL/authz — neither detects PHI names/MRNs/DOBs). baseline.json entries are forgeable in the same commit (visible-but-reviewed suppression).
- Root cause: SCAN_ROOTS + SCAN_EXTENSIONS are minimal for BF-02's corpus; the tripwire guarantees less than 'no PHI can land'.
- Fix: DONE: the scanner is DENY-BY-DEFAULT (git ls-files minus a reviewed EXCLUDED_PATHS carve-out, binaries skipped by null-byte sniff), two-tier: JSON/NDJSON content -> field-aware FHIR detectors (unless FIELD_AWARE_EXEMPT: vendored/canonical HL7 corpora whose example names aren't our digit-marker convention, measured to carry no SSN/NPI/phone); every text file -> text-mode dashed-SSN via the strict validator (near-zero FP, 0 across 389 tracked files). Each carve-out carries a reason. scripts/synthetic-scan/** added to GLOBAL_FORBIDDEN_PATHS so a slice maker cannot narrow the scanner; planted.csv exercises the non-JSON path in the self-test. Residual follow-up: merge-base baseline-provenance (same-commit self-approval) — baseline is empty today and every entry already needs reason+added_by.
- Guard: `test` → `loop/src/gates/phi-scan-coverage.test.ts::BP-022: PHI scanner coverage is deny-by-default`
- Recorded: 2026-07-03

## BP-023 — new-workspace-missing-from-dockerfile — GUARDED

- Symptom: Adding `seed` to the root package.json workspaces broke the api Docker build: `bun install --frozen-lockfile --production` failed with 'Workspace not found seed' because docker/api.Dockerfile COPYs workspace manifests by explicit list. Invisible locally (docker compose reused a cached image); red only on a fresh CI build.
- Root cause: The Dockerfile enumerates each workspace manifest to COPY, so a newly-declared workspace whose manifest is not added is absent when bun resolves the workspace graph — and local compose runs don't rebuild the image, hiding it.
- Fix: COPY seed/package.json in both the deps and runtime stages (mirroring loop/); full `docker build` reproduced the failure and confirmed the fix. The docker-invariants test now asserts every non-glob root workspace has a matching COPY in the Dockerfile.
- Guard: `test` → `loop/src/gates/docker-invariants.test.ts::every root workspace manifest (globs expanded) is COPYed for install`
- Recorded: 2026-07-03

## BP-024 — db-test-depends-on-unrun-boot-step — GUARDED

- Symptom: seeded-state.test.ts asserts seed row counts but does not seed; it passed locally (operator ran `bun run seed` first per the verify[] order) and failed in CI, whose generic `turbo run test` boot only migrated. Green locally, red on a fresh CI runner.
- Root cause: A DB-backed test carried an implicit precondition (the seed having run) that it did not establish itself, so correctness depended on the runner's boot order rather than the test.
- Fix: DONE: the seed-contract exhibit moved to seed/seeded-state.test.ts (the seed workspace owns the seeder — no core->seed cycle) and self-provisions via an exported, idempotent, advisory-locked seedIfNeeded() in beforeAll — proven to pass against a MIGRATE-ONLY DB. seed/index.ts CLI now guarded by import.meta.main so importing the seeder has no side effect. The remaining projection/terminology-dependent suites rely on the CI boot chain (migrate->seed->fhir:load-terminology->projections:rebuild BEFORE the test task), now pinned so it cannot silently lose a step (the recorded failure); full per-suite hermeticity is a scoped follow-up.
- Guard: `test` → `loop/src/gates/hermetic-tests-wiring.test.ts::BP-024: DB tests do not depend on an unrun boot step`
- Recorded: 2026-07-03

## BP-025 — synthetic-fixtures-gitignored — GUARDED

- Symptom: The 8 synthetic fixture ndjson files were never committed: a blanket `*.ndjson` .gitignore rule (a PHI-safety default) swallowed them. They existed in the worktree so the seed passed locally, but a fresh CI checkout lacked them and the seed crashed with ENOENT on patient.ndjson.
- Root cause: A broad ignore rule for a PHI-risky file extension caught the synthetic corpus too, and nothing asserted the manifest-listed fixtures were git-tracked.
- Fix: Scoped un-ignore `!fixtures/synthetic/**/*.ndjson` (parallel to the existing `!drizzle/**/*.sql`), fixtures committed; scan:synthetic still sweeps the dir every run so only synthetic data lives there. The fixtures-tracked test asserts every manifest file is git-tracked and fails fast (no DB) if one is untracked or ignored.
- Guard: `test` → `loop/src/gates/fixtures-tracked.test.ts::every manifest-listed fixture file is git-tracked`
- Recorded: 2026-07-03

## BP-026 — network-on-validate-write-path — GUARDED

- Symptom: The BF-03 'validate-on-write makes zero network calls' invariant was proven only by a globalThis.fetch test spy — a partial proxy that a future node:http/https/undici/axios import would silently evade, reopening a blocking-network-call-on-write regression (flagged convergently by the BF-03 verifier and security-auditor).
- Root cause: A behavioral invariant (no network on the write path) was guarded by a runtime spy on one API surface rather than a structural control over all of them.
- Fix: ast-grep no-network-in-write-path bans fetch() calls and node:http/node:https/undici/axios/got imports under packages/core/src/{write,terminology}/** (tests exempt — they legitimately spy to prove the invariant). Terminology validation stays pure local SQL; RemoteTxValidator is a NotImplemented stub.
- Guard: `ast-grep` → `sgrules/no-network-in-write-path.yml`
- Recorded: 2026-07-04

## BP-027 — conformance-headline-drift — GUARDED

- Symptom: MANIFEST.shareableCases was parsed but never enforced: a regressed shareable case could be downgraded into declaredUnsupported and `bun run conformance` still exited 0 — CLI, CI gate, and the (tautological) headline unit assertion all stayed green while the claimed 133 quietly shrank.
- Root cause: The exit rule only required failed==0 plus count consistency; nothing bound passed to the manifest's shareable pin, and the headline test derived its expectation from the report's own fields.
- Fix: exitCodeForReport now requires passed==shareableCases, skippedDeclared==totalCases-shareableCases and total>0; the loader enforces manifest arithmetic (totalCases-declaredUnsupported==shareableCases); the headline test pins 133/11 as literals with a downgrade-attack negative control; the bf04-conformance-real eval recounts from raw bytes.
- Guard: `test` → `packages/sql-on-fhir/src/conformance/conformance.test.ts::downgrading a failing case into declaredUnsupported still exits non-zero`
- Recorded: 2026-07-04

## BP-028 — projection-key-divergence — GUARDED

- Symptom: A canonical row whose content.id diverged from its fhir_resources.id split the two projection writers: upsert deleted vd rows by content.id while addressing by row id (stranding stale rows under the old key), and rebuild projected what upsert refused — byte-parity between the writers broke.
- Root cause: Nothing enforced content.id == id at write time; the typed write path satisfied it by construction, so the invariant was accidental, not structural.
- Fix: insertFhirResourceTx/updateFhirResourceTx fail closed on a content.id mismatch (INVALID_FHIR_INPUT); both projection writers additionally refuse divergent rows with PROJECTION_KEY_MISMATCH (defense-in-depth below core, for owner-planted rows).
- Guard: `test` → `packages/core/src/db/fhir-write.test.ts::insert with a divergent content.id is refused with zero rows written`
- Recorded: 2026-07-04

## BP-029 — rls-ratchet-name-dodge — GUARDED

- Symptom: The 0004 projection-RLS event trigger string-matched object_identity: a quoted or mixed-case relname (public."VD_Evil") dodged stamping entirely, split_part kept the quotes and corrupted the policy lookup, and CREATE TABLE AS / SELECT INTO never fired it; the catalog sweep was case-sensitive and relkind='r' only.
- Root cause: Identity STRING parsing instead of catalog resolution, plus an under-inclusive tag list. Owner-only surface (bonfire_app has no CREATE), but the belt-and-braces ratchet must not depend on polite DDL.
- Fix: drizzle/0005 resolves relations via objid->pg_class with lower(relname) matching + relnamespace/relkind scoping and adds the CTAS/SELECT INTO tags; the catalog sweep went case-insensitive over relkind in ('r','p'); quoted-name and CTAS probes prove stamping live. Residual (accepted): ALTER TABLE RENAME/SET SCHEMA are uncovered tags — the sweep is the control there.
- Guard: `test` → `tests/sql-on-fhir/rls-vd.test.ts::a QUOTED mixed-case vd table and a CTAS table are both stamped`
- Recorded: 2026-07-04

## BP-030 — conformance-trust-root-editable — GUARDED

- Symptom: fixtures/sql-on-fhir/MANIFEST.json — the sha256/count/allowlist trust root behind the conformance claim — sat inside the slice's allowedPaths: a maker could re-pin bytes, grow the allowlist and shrink shareableCases in one edit, and every machine check would faithfully follow the NEW pins.
- Root cause: The trust root lived on the same floor as the fixtures it pins; nothing distinguished pin-authoring (operator prep) from pin-consumption (maker).
- Fix: fixtures/sql-on-fhir/MANIFEST.json added to GLOBAL_FORBIDDEN_PATHS — only operator prep (pre-base, human-reviewed) can re-pin; the floor entry is pinned in the allowed-paths test matrix.
- Guard: `test` → `loop/src/contracts/allowed-paths.test.ts::fixtures/sql-on-fhir/MANIFEST.json`
- Recorded: 2026-07-04

## BP-031 — dist-dependent-lint-resolution — GUARDED

- Symptom: eslint was green locally but red in CI (18 no-unsafe-* errors in scripts/sql-on-fhir): package-name imports of @bonfire/core type-resolve via the exports map to dist/index.d.ts, which existed locally after any tsc -b but not in CI's no-build lint job, so the dependent type graph collapsed to error-typed.
- Root cause: Consumer tsconfigs without project references get no source redirect for referenced composite packages; local build artifacts masked the hole (the green-local/red-fresh-CI class).
- Fix: DONE: root-cause fix — a namespaced @bonfire/source export condition placed FIRST in each internal package's exports map + customConditions in tsconfig.base.json, so tsc AND typescript-eslint's projectService always resolve @bonfire/* to src/index.ts, dist present or not. Proven by moving dist aside and getting 0 eslint errors on the consumer graph. Project references stay (for tsc -b ordering). A resolution guard pins the mechanism, and its built-in inversion proves the condition is load-bearing (without it resolution falls back to dist).
- Guard: `test` → `loop/src/gates/dist-independent-resolution.test.ts::BP-031: @bonfire/* type resolution is dist-independent`
- Recorded: 2026-07-04

## BP-032 — comment-terminating-glob — GUARDED

- Symptom: Writing vd_*/spidx inside a /** block comment terminates the comment at the embedded */ and shreds the file into TS1434 parse errors — hit twice by the BF-04 maker and once by the operator in the close-out.
- Root cause: The vd_* naming convention followed by a prose slash collides with the block-comment terminator; nothing lints comment bodies.
- Fix: DONE: a self-testing lexer-level checker (loop/src/gates/comment-hazards.ts, package script check:comments, wired into BOTH the CI structural gate and the loop structural gate). It scans every tracked TS file with the TypeScript scanner and flags a MultiLineCommentTrivia that closed on a comment terminator immediately followed by an identifier char — the signature of an early-terminated comment. Globs inside string/template literals are invisible by construction (0 false positives over 225 files). The exported detector is pinned by a test; the script self-tests (exit 2) on every run.
- Guard: `test` → `loop/src/gates/comment-hazards.test.ts::BP-032: block-comment terminator hazard detector`
- Recorded: 2026-07-04

## BP-033 — order-by-text-alias-shadow — GUARDED

- Symptom: An audit chain that reaches 10 rows STICKS: every further appendAuditRowTx reads '9' as the tip, recomputes seq=10, collides on (practice_id,seq) -> 23505/TENANT_TX_FAILED; and verifyAuditChainTx reports a false seq_gap. Surfaced by BF-13's shared SYSTEM chain crossing 10 over many runs; a fresh-stack CI run never accumulates 10 rows in one chain, so CI structurally could not catch it.
- Root cause: appendAuditRowTx and verifyAuditChainTx both project `seq::text as seq` and then `order by seq`; Postgres binds the unqualified ORDER BY to the TEXT output alias, so the chain sorts lexicographically ('1','10','2',...,'9'). The tip read returns '9' as the max and walkChain derives expectedSeq from array position -> gap.
- Fix: Qualified both ORDER BYs to the bigint column (order by audit_log.seq) in audit/audit-log.ts + audit/verify.ts and the loop bf05-chain-oracle eval; the same latent pattern in audit-log.test.ts fixed too.
- Guard: `test` → `packages/core/src/audit/audit-log.test.ts::twelve sequential appends stay seq 1..12`
- Recorded: 2026-07-07

## BP-034 — tight-timeout-heavy-db-test — GUARDED

- Symptom: Under `turbo run test` (all packages' DB suites concurrent on one Postgres), the sql-on-fhir full-DROP+rebuild determinism tests time out at the default 5000ms (~6s needed) and cascade a CONNECTION_ENDED; green in isolation / when cached, red under load. Pre-existing (BF-04), off-floor; BF-13's added DB load made it visible.
- Root cause: A heavy full-projection-rebuild integration test was left on bun's default 5s timeout, too tight under concurrent DB contention.
- Fix: Added --timeout 20000 to the @bonfire/sql-on-fhir test script (the heavy full-DROP+rebuild determinism suite needs ~6s and flakes at bun's default 5s under concurrent turbo DB load); a loop gate test pins that DB-test timeout floor so the mitigation cannot be silently removed or lowered. A dedicated/serialized Postgres lane for the rebuild suite remains a documented follow-up (accepted residual, not the reopening vector this guard closes).
- Guard: `test` → `loop/src/gates/db-test-timeout.test.ts::BP-034: heavy DB test suites keep a generous timeout`
- Recorded: 2026-07-07

## BP-035 — phi-egress-search-path — GUARDED

- Symptom: The cited-search path could ship PHI (the raw query text) off-box: a maker wiring an external embedding/rerank call or a hosted-model API SDK into the default search path would exfiltrate the query to a third party.
- Root cause: Retrieval that embeds/ranks with a HOSTED model sends the query text off the tenant boundary; nothing structurally forbade a network client or a hosted-model SDK under the search module.
- Fix: BF-06: the default path is self-hosted + in-process (node:crypto feature-hash dev embedder; the reranker is an undefined-by-default seam, no cross-encoder ships) so it makes ZERO off-box calls. The ast-grep rule no-egress-in-search-path bans network primitives (fetch/globalThis.fetch/WebSocket/EventSource + node:http|https|net|tls|dns|dgram|http2|child_process) and hosted-model API SDKs (openai/cohere-ai/@anthropic-ai/sdk/@google/generative-ai/@huggingface/inference/replicate) via static import, require, OR dynamic import() under packages/core/src/{search,ccp}/** (local in-process inference — onnxruntime-node, @xenova/transformers — stays allowed). The bf06-no-phi-egress Stage-2 eval is the live proof: a globalThis.fetch spy shows a real, results-returning default search makes zero off-box calls. Widened in BF-07 to packages/core/src/ccp/** (the CCP serializer + offline o200k tokenizer inherit the floor; the bf07-token-residual eval's fetch spy confirms the token measurement makes zero off-box calls). Residual (follow-up): a repo-global network default-deny beyond {search,ccp}.
- Guard: `ast-grep` → `sgrules/no-egress-in-search-path.yml`
- Recorded: 2026-07-07

## BP-036 — cross-suite-shared-db-ddl-race — GUARDED

- Symptom: @bonfire/sql-on-fhir#test DROPs the shared vd_* tables + byte-identity-hashes a full rebuild of ALL fhir_resources; run concurrently under `turbo run test` with a suite that WRITES fhir_resources it flakes (two rebuilds see different corpora), and with a suite that READS vd_* it 42P01s on the DROP window. Reliably reproducible fresh once BF-06's search DB tests extended the core suite to overlap that window; green on main before only because the shorter core suite finished first.
- Root cause: DB integration suites across packages share ONE Postgres and run concurrently under turbo; a suite mutating shared schema (DROP vd_*) or the global fhir_resources corpus races another suite's reads/rebuilds — the single-Postgres BP-034 residual.
- Fix: A turbo package override serializes the sensitive suite: @bonfire/sql-on-fhir#test dependsOn @bonfire/core#test + @bonfire/api#test, so it runs last + alone — nothing writes fhir_resources / reads vd_* concurrently with its rebuild+drop. Proven 3/3 fresh + CI green. A loop gate test pins the override so removing it reopens the race.
- Guard: `test` → `loop/src/gates/serialized-db-lane.test.ts::BP-036: the sql-on-fhir DB suite runs in a serialized lane`
- Recorded: 2026-07-07

## BP-037 — ccp-serializer-injection — GUARDED

- Symptom: The CCP text serializer interpolated three untrusted response-derived strings (header sourceAuditEventId, excludedByPolicy resourceType + reason) RAW into its line-structured document; a hostile clinical/deny string carrying a newline could fabricate a forged `[9] Type/<id>` group header or a `  path: value` span line that a downstream agent reads as an authentic citation — and the content digest would then notarize the forgery. Span VALUES were JSON-encoded but these three header/summary fields were not.
- Root cause: A line-structured artifact fed to an LLM interpolated attacker-influenced, only length/enum-bounded (never charset-bounded) strings from the untrusted BF-06 SearchResponse boundary directly into template lines; a newline breaks out of the intended line.
- Fix: BF-07: JSON.stringify all three interpolations (matching the span-value Class-5 pattern) so each stays a single escaped token and the document is losslessly invertible. The ast-grep rule no-raw-response-string-in-ccp-serialize bans a bare ${x} interpolation inside serialize.ts (the JSON.stringify(x) form is clean, via inside: template_substitution stopBy: neighbor). The bf07-text-invertible Stage-2 eval is the live proof: a forged excludedByPolicy reason + 64-char auditEventId with embedded newlines produce ZERO forged group/span lines and doc.text inverts losslessly to the exact span set.
- Guard: `ast-grep` → `sgrules/no-raw-response-string-in-ccp-serialize.yml`
- Recorded: 2026-07-10

## BP-038 — mcp-egress — GUARDED

- Symptom: The local MCP server is the first place an untrusted agent enters the system. Its contract is a narrow propose-only typed tool allowlist with NO raw SQL, FHIRPath, shell, or filesystem access, but nothing structurally prevented a handler (or a later edit) from importing node:child_process, node:fs, or a network client and turning a tool call into shell execution, arbitrary file reads, or PHI egress off-box.
- Root cause: Capability was governed only by the shape of the three tool schemas, i.e. by convention. The MCP package's module surface was unconstrained, so any new import silently widened what a tool handler could reach. The vectors split in two: IMPORT-reachable (node builtins, undici/axios, hosted-model SDKs) and GLOBAL-reachable (fetch, WebSocket, EventSource, Bun.spawn/$/file/write/connect), the latter needing no import at all.
- Fix: Two complementary ast-grep guards scoped to packages/mcp/src (tests exempt: they spy to prove the invariants). sgrules/no-egress-in-mcp.yml bans the named import vectors AND the global-reachable ones (fetch/globalThis.fetch/WebSocket/EventSource/Bun.spawn/Bun.spawnSync/Bun.$/Bun.file/Bun.write/Bun.connect/Bun.listen) plus require()/dynamic import() of the banned modules. Its sibling BP-039 supplies the positive control on the import surface.
- Guard: `ast-grep` → `sgrules/no-egress-in-mcp.yml`
- Recorded: 2026-07-10

## BP-039 — mcp-import-surface — GUARDED

- Symptom: A denylist of banned imports (BP-038) is only ever as good as its enumeration: a network client it never heard of, a transitive re-export, or a package added next quarter slides straight through the agent-facing boundary. The guard silently fails OPEN on anything unnamed.
- Root cause: Denylists invert the burden of proof. The correct posture at a trust boundary is an allowlist: enumerate what the MCP server legitimately needs (its own modules, @bonfire/sdk, @bonfire/core, @modelcontextprotocol/sdk, zod) and fail closed on everything else, so a new dependency must be reviewed IN to be reachable. NOTE the same control expressed as a dependency-cruiser rule is INERT and was rejected: .dependency-cruiser.cjs sets options.includeOnly to the source dirs, which filters node builtins and node_modules out of the graph entirely, so a `from packages/mcp/src, to node:fs` edge is never a candidate and the rule can never fire (proven by injecting the import: depcruise still reported no violations).
- Fix: sgrules/mcp-import-allowlist.yml: under packages/mcp/src (tests exempt), any import_statement or export_statement whose source is not one of ./ ../ @bonfire/sdk @bonfire/core @modelcontextprotocol/sdk[/...] zod fails the structural gate. ast-grep sees every specifier, including node builtins. Inversion-proven: clean tree -> `ast-grep scan` exit 0; a real `import { readFileSync } from "node:fs"` in server.ts -> exit 1 (both this rule and BP-038 fire); restored -> exit 0.
- Guard: `ast-grep` → `sgrules/mcp-import-allowlist.yml`
- Recorded: 2026-07-10
