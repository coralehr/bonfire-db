# Bonfire Loop Runbook

The loop exists to build the Bonfire demo in small, verified slices. It may
create worktrees, make changes, run checks, push branches, and open draft PRs.
It may not merge.

## Modes

### 1. Manual

Use this until the first end-to-end slice has passed.

```bash
scripts/loop/create-worktree.sh harness-smoke
scripts/loop/ledger.mjs add --key harness-001 --source manual --sev med \
  --title "Harness smoke" --action "Run verifier on the harness skeleton"
```

### 2. Semi-auto

Default once one manual slice works.

1. Pick one item from `docs/loop/STATE.md`.
2. Create a worktree with `scripts/loop/create-worktree.sh <slice>`.
3. Run a maker agent against the slice contract.
4. Run `scripts/loop/verify.sh`.
5. Run the Bonfire verifier agent.
6. Run the security auditor when the slice touches data, authz, audit, FHIR,
   MCP, logging, or hosted playground code.
7. Open a draft PR.
8. Iterate on CI, verifier findings, security findings, and Greptile until
   Greptile reports `5/5`.

### 3. Scheduled Triage

Allowed only for discovery. A scheduled loop may update the inbox but may not
implement without an explicit human-triggered slice contract.

## Slice Order

1. Harness skeleton and CI.
2. Bun workspace, Docker compose, Postgres + pgvector boot.
3. Schema, migrations, seed, synthetic-only scanner.
4. ABAC gate and hash-chained audit.
5. Cited semantic search.
6. Demo UI search beat.
7. Denial and audit UI beat.
8. Propose-only note.
9. FHIR export/import.
10. Local MCP tools.
11. README, GIF, docs, hosted read-only playground.

## Stop Conditions

Stop and report instead of continuing when:

- The same verifier finding fails twice.
- `MAX ATTEMPTS`, `MAX TURNS`, or `MAX BUDGET USD` is reached.
- The task needs a product decision not covered by the slice contract.
- A security auditor returns `BLOCKING`.
- Greptile cannot be read from GitHub after the PR is ready for review.

## Merge Contract

Merge is allowed only after:

- CI green.
- `scripts/loop/verify.sh` green.
- Bonfire verifier: `PASS`.
- Security auditor: `CLEAR` when applicable.
- Greptile: `5/5`.
- Human final review complete.
