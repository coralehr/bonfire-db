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

## Harness Skeleton Gate

- `AGENTS.md` exists and defines autonomy, safety, stack, and merge rules.
- `docs/loop/STATE.md`, `RUNBOOK.md`, and `ACCEPTANCE.md` exist.
- Codex and Claude Code maker/checker/security agents exist.
- `scripts/loop/create-worktree.sh`, `verify.sh`, `ledger.mjs`, and
  `greptile-gate.mjs` exist.
- `scripts/loop/verify.sh` fails clearly before the app scaffold exists.
- CI can syntax-check harness scripts.
- No scheduled automation is enabled yet.

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
