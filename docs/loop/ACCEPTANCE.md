# Bonfire Acceptance Gates

This file defines the objective gates that the loop must use. If a task cannot
be checked against this file or a slice-specific extension of it, it is not ready
for autonomous implementation.

## Slice Contract

Every slice starts with:

```text
ID:
GOAL:
WHY:
ALLOWED FILES:
FORBIDDEN FILES:
ACCEPTANCE:
VERIFY COMMAND:
MAX ATTEMPTS:
MAX TURNS:
MAX BUDGET USD:
```

The maker only works inside `ALLOWED FILES`. The verifier fails the slice if
acceptance is vague, missing, or not objectively testable.

Task contracts are generated from `docs/loop/tasks.json`:

```bash
scripts/loop/task.mjs contract BF-XX
```

The task registry is source-of-truth. The mutable pass/fail state is
`docs/loop/task-status.json`.

## Harness Skeleton Gate

- `AGENTS.md` exists and defines autonomy, safety, stack, and merge rules.
- `docs/loop/STATE.md`, `RUNBOOK.md`, and `ACCEPTANCE.md` exist.
- Codex and Claude Code maker/checker/security agents exist.
- `scripts/loop/create-worktree.sh`, `verify.sh`, `ledger.mjs`, and
  `greptile-gate.mjs` exist.
- `scripts/loop/task.mjs`, `docs/loop/tasks.json`, and
  `docs/loop/task-status.json` exist.
- `scripts/loop/task.mjs validate` passes.
- `scripts/loop/verify.sh` fails clearly before the app scaffold exists.
- CI can syntax-check harness scripts.
- No scheduled automation is enabled yet.

## Profile-Specific Gates

The registry assigns each task a profile. Verifiers must apply the matching
gate:

- `foundation`: install, typecheck, Docker boot, health smoke.
- `data`: migrations, idempotent seed, synthetic-only scan.
- `security`: negative ABAC tests, audit immutability, tamper detection.
- `contract`: SDK/API schema parity, trusted validation, typed 4xx errors.
- `retrieval`: golden queries, citations, exact baseline, no silent fallback.
- `ui`: Playwright user flow and desktop/mobile screenshot checks.
- `ui-security`: UI flow plus security auditor log/PHI checks.
- `agent-safety`: propose-only invariant and agent-approve denial.
- `fhir`: R4 document Bundle invariants and reference integrity.
- `mcp`: fixed local tool allowlist and tool-poisoning tests.
- `docs-release`: quickstart replay and claim audit.

## Demo MVP Gate

The full Bonfire demo is done only when all of these pass:

- Clean clone boots with `docker compose up`.
- Runtime requires zero API keys.
- Runtime can complete the scripted path after network is disabled.
- Demo data is synthetic and passes the synthetic-only scanner.
- The browser demo shows cited semantic search, ABAC denial with audit, a
  propose-only note flow, and FHIR export/import.
- SDK examples run against the local API.
- README clearly distinguishes shipped behavior from roadmap/design behavior.
- CI, Bonfire verifier, security auditor, and Greptile `5/5` are green.

## Greptile Gate

No PR may merge unless the latest Greptile review for that PR reports `5/5`.
If Greptile exposes a required GitHub check, branch protection should require
that check. If Greptile reports by comment or review body, the fallback
`scripts/loop/greptile-gate.mjs` parser is the merge gate.

The fallback gate must distinguish reviewer absence from reviewer failure:

- skip draft PRs until the PR is marked ready for review;
- poll boundedly when no Greptile artifact is visible yet;
- inspect both pull-request merge SHA and head SHA check runs;
- fail immediately when a visible score is below `5/5`;
- fail with diagnostics when the wait window expires without readable output.
