# The Ratchet — bug classes this repo must never repeat

> GENERATED from `loop/memory/bug-patterns.jsonl` by `bun run loop ratchet --write`.
> Do not edit by hand. A GUARDED entry's guard is machine-verified by
> `loop ratchet` (and the test suite): if the guard artifact disappears,
> the check fails and the bug is considered reopened.

3 guarded · 5 open (debt owed a guard)

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
