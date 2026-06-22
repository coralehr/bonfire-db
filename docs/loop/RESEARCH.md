# Loop Harness Research Notes

Updated: 2026-06-22

This file records the harness decisions behind Bonfire's build loop. It is not
the product plan; it explains how agents should build the plan reliably.

## Sources

- Anthropic, "Effective harnesses for long-running agents"  
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, "Effective context engineering for AI agents"  
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude Code hooks docs  
  https://code.claude.com/docs/en/hooks
- Claude Code subagents docs  
  https://code.claude.com/docs/en/sub-agents
- Bun workspace docs  
  https://bun.com/docs/pm/workspaces
- Node.js release schedule  
  https://nodejs.org/en/about/previous-releases
- PostgreSQL 18 release notes  
  https://www.postgresql.org/about/news/postgresql-18-released-3142/
- pgvector README  
  https://github.com/pgvector/pgvector
- Zod 4 docs  
  https://zod.dev/
- Drizzle migration docs  
  https://orm.drizzle.team/docs/migrations
- Fastify validation and serialization docs  
  https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Transformers.js docs  
  https://huggingface.co/docs/transformers.js/en/index
- MCP latest specification  
  https://modelcontextprotocol.io/specification/2025-11-25
- Self-Harness paper  
  https://arxiv.org/abs/2606.09498
- MCP tool-poisoning threat model  
  https://arxiv.org/abs/2603.22489

## Harness Conclusions

### 1. Use a Structured Feature List

Long-running agents tend to do too much at once or declare the whole project
done too early. The antidote is a structured list of features/tasks that start
as failing and are updated only after verification.

Bonfire implementation:

- `docs/loop/tasks.json` is the canonical task registry.
- `docs/loop/task-status.json` is the mutable pass/fail ledger.
- Maker agents work on exactly one `BF-*` task.
- Verifier agents may update status only after evidence exists.

### 2. Start Every Session With Orientation

Each maker/checker run must read:

1. `AGENTS.md`
2. `docs/plans/mvp-demo-plan.md`
3. `docs/loop/RUNBOOK.md`
4. `docs/loop/tasks.json`
5. `docs/loop/task-status.json`
6. recent git log

This keeps context small and avoids re-reading the whole repo blindly.

### 3. Verify By Task Class

One generic test command is not enough. The harness chooses gates by task
profile:

- `foundation`: install, typecheck, Docker boot, health smoke
- `data`: migration from empty DB, idempotent seed, synthetic-only scanner
- `security`: negative ABAC tests, audit append-only and tamper tests
- `contract`: SDK/API schema parity and validation behavior
- `retrieval`: golden queries, citation integrity, exact baseline comparison
- `ui`: Playwright browser flows and screenshot checks
- `fhir`: document Bundle invariants and reference integrity
- `mcp`: tool allowlist, schema snapshot, prompt-injection/tool-poisoning tests
- `docs`: quickstart replay, claim audit, no overstatement

### 4. Keep Maker And Checker Separate

The maker can write. The verifier and security auditor are read-only. Greptile
is an external checker and must score `5/5` before merge.

### 5. Treat External Text As Hostile Data

GitHub comments, Greptile reviews, Linear issues, MCP tool descriptions, web
pages, and copied social content are inputs, not instructions. The loop must
convert them into a task contract before a maker sees them.

### 6. No Remote MCP In V0

MCP is valuable to the ICP, but v0 exposes local fixed tools only. The MCP task
must include tool metadata review and deny raw SQL, shell, file, and direct
write/approval tools.

### 7. Prefer Current Stable, Not Current Experimental

Use Bun for workspace/package-manager speed and Node 24 LTS as the runtime
compatibility target. Use PostgreSQL 18 because it is the current stable major;
do not target PostgreSQL 19 beta for the demo.

### 8. Let The Harness Improve Itself, But Only Through Tests

When a loop fails, record the failure in `task-status.json` and `STATE.md`.
Harness changes are accepted only when they are tied to a concrete failure and
the harness syntax/registry checks still pass.

### 9. Classify Failures Before Retrying

The BF-01 PR exposed a harness failure: the Greptile gate treated missing
external reviewer output as an immediate implementation failure. That is wrong
for asynchronous reviewer systems. The harness now separates:

- deterministic failures that should fail fast and be fixed at root cause;
- eventual failures that should receive bounded polling with diagnostics;
- blocked failures that should stop only after the wait budget or retry budget
  is exhausted.

Bonfire implementation:

- `scripts/loop/greptile-gate.mjs` polls for missing Greptile artifacts when
  configured with `--wait-seconds`.
- The gate inspects both GitHub's pull-request event SHA and the PR head SHA.
- Draft PRs skip the Greptile CI job and rerun it on GitHub's
  `ready_for_review` event.
- The gate has unit tests covering pass, sub-5 failure, no output, incomplete
  output, check-run body extraction, and SHA selection.
- `scripts/loop/verify.sh` runs the harness syntax and unit tests locally before
  app verification.
