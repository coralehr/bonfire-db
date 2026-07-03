# The Ratchet — bug classes this repo must never repeat

> GENERATED from `loop/memory/bug-patterns.jsonl` by `bun run loop ratchet --write`.
> Do not edit by hand. A GUARDED entry's guard is machine-verified by
> `loop ratchet` (and the test suite): if the guard artifact disappears,
> the check fails and the bug is considered reopened.

8 guarded · 6 open (debt owed a guard)

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

## BP-011 — gate-false-positive-pushes-unsafe-workaround — OPEN

- Symptom: The template clause of semgrep rule bonfire-mcp-tool-raw-sql-concat flagged postgres.js sql tagged-template queries — the safe, bound-parameter idiom — so BF-01 shipped a sql.unsafe(constantLiteral, [params]) workaround to pass the gate: the gate steered code toward a less-reviewable API.
- Root cause: A text regex cannot distinguish a tagged template (interpolations bound as parameters by the sql tag) from an untagged template literal that splices values into statement text.
- Fix: Operator-reviewed refinement: templates tagged exactly sql are exempted via pattern-not-regex; untagged SQL-shaped templates, string concat, near-miss tags (mysql/rawsql), and unsafe() with interpolation all remain banned; inline suppressions stay banned by the suppressions gate.
- Planned guard: semgrep behaviour-test corpus (semgrep --test fixtures proving sql tagged templates pass and untagged interpolation fails) wired into the semgrep gate — queue with the BF-02 wave, alongside restoring tenant.ts's tagged template
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
