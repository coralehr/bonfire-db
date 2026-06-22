# Bonfire Agent Autonomy Profile

Updated: 2026-06-22

This profile is for local Bonfire loop runs where a coding agent should keep
working through dependency installs, Docker boot, PR checks, and retryable CI
failures without repeatedly asking for routine approvals. Keep human approval
for merge, force-push, destructive filesystem changes, production access, and
clinical/security product decisions.

## Codex Settings To Enable

Use this as a Codex profile for Bonfire work:

```toml
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "on-request"
approvals_reviewer = "auto_review"

[sandbox_workspace_write]
network_access = true
writable_roots = [
  "<absolute-path-to-bonfire-db>",
  "/private/tmp"
]
```

Recommended persistent approvals for this repo:

- `bun install`, `bun run`, and `bun test`
- `docker info` and `docker compose`
- `gh` for repo, PR, check, and workflow inspection
- `node scripts/loop/ci-watch.mjs`
- `git -C`, `git fetch`, `git pull`, `git push`, `git add`, and `git commit`
- `curl -fsS` for localhost smoke checks
- `scripts/loop/verify.sh`

Recommended network allowlist:

- GitHub: `github.com`, `api.github.com`, `raw.githubusercontent.com`
- JavaScript packages: `registry.npmjs.org`, `bun.sh`, `oven-sh.dev`
- Containers: `docker.io`, `registry-1.docker.io`, `ghcr.io`, `production.cloudflare.docker.com`
- Bonfire local runtime: `127.0.0.1`, `localhost`

For a disposable VM or throwaway worktree only, `approval_policy = "never"` can
remove approval prompts entirely. Do not use that setting in a repo with
uncommitted human work, production credentials, or broad filesystem access.

Claude Code equivalent: trust the repo, allow Bash/tool execution for the same
command classes above, allow dependency/container network access, and keep
destructive commands and merge actions manual.

## Harness Self-Healing Rules

When CI or verification fails, agents should classify the failure before
changing code:

- `deterministic`: syntax, typecheck, lint, tests, Docker build, or API smoke.
  Investigate root cause, fix once, rerun the smallest failing command, then
  rerun `scripts/loop/verify.sh`.
- `eventual`: external reviewer/check output not available yet, rate limits,
  Docker daemon boot race, or service health race. Retry with a bounded wait and
  diagnostics.
- `blocked`: missing credentials, missing reviewer app installation, forbidden
  file scope, product/security decision, or two repeated failures of the same
  command. Stop with exact evidence.

Every new failure class should leave one of:

- a verifier check that catches it locally,
- a bounded retry with useful diagnostics,
- or a runbook entry explaining the human action required.

After pushing a branch with an open PR, run:

```bash
node scripts/loop/ci-watch.mjs --repo ticvision/bonfire-db --pr 1 --wait-seconds 1800 --poll-seconds 30
```

The watcher polls `gh pr checks`, fails fast on red checks, and extracts
relevant GitHub Actions log snippets. Use those snippets as the next root-cause
investigation input, then repair and push again until CI is green or a stop
condition is reached.

## Greptile Gate Behavior

`scripts/loop/greptile-gate.mjs` is intentionally strict about scores and
patient about availability:

- `5/5`: pass.
- `<5/5`: fail immediately.
- no Greptile artifact yet: poll until the configured wait expires.
- Greptile artifact without an `N/5` score: poll until the configured wait
  expires, then apply the configured pending exit policy with source
  diagnostics.
- inspect both the workflow event SHA and the PR head SHA, because pull request
  workflows often run on a merge SHA while reviewer apps attach checks to the
  head SHA.

CI currently waits up to 20 minutes by default:

```bash
node scripts/loop/greptile-gate.mjs --wait-seconds "${GREPTILE_WAIT_SECONDS:-1200}" --poll-seconds 30
```

During the Greptile setup-stabilization period, CI uses
`GREPTILE_PENDING_EXIT_CODE=0`: a visible sub-5 score still fails, but missing
Greptile output soft-passes after the wait window. Set repository variable
`GREPTILE_PENDING_EXIT_CODE=1` once Greptile reliably reviews new commits.
Set `GREPTILE_WAIT_SECONDS` if the Greptile dashboard shows consistently faster
or slower review times.

Draft PRs intentionally skip the Greptile CI job. When the PR is marked ready
for review, the `ready_for_review` workflow event runs the Greptile score gate.

The trigger step is opt-in and supports two automation paths:

- Default comment trigger: `--trigger` posts `@greptileai` once per head SHA.
- `GREPTILE_TRIGGER_URL` plus optional `GREPTILE_TRIGGER_TOKEN`: POSTs a JSON
  review request payload to the configured endpoint before polling, without
  also posting the default comment.
- `GREPTILE_TRIGGER_COMMENT`: overrides the default bot-command comment. It
  supports placeholders `{repo}`, `{pr}`, `{pr_url}`, `{sha}`, and `{head_ref}`.

Without `--trigger`, the gate only polls for normal Greptile GitHub App output.

When a Greptile summary includes a reviewed commit link, the gate only accepts
that summary if it matches the current PR head or merge SHA. This prevents an
old `5/5` review from passing a newer commit.

Harness-authored trigger comments include an idempotency marker and are ignored
as review candidates, even though they mention `@greptileai`.

CI attempts the Greptile trigger only when `GREPTILE_TRIGGER_URL` or
`GREPTILE_TRIGGER_COMMENT` is configured. Keep `GREPTILE_TRIGGER_REQUIRED=false`
unless that configured trigger path is known to work.

When org policy blocks write permissions for the default `GITHUB_TOKEN`,
configure `GREPTILE_GH_TOKEN` with a fine-grained token that can read
pull requests/checks and write PR comments for this repository.

Local dry run with diagnostics:

```bash
GH_TOKEN=... GITHUB_REPOSITORY=ticvision/bonfire-db PR_NUMBER=1 \
  node scripts/loop/greptile-gate.mjs --trigger
```

## Research Basis

- Anthropic's long-running agent harness writeup recommends structured feature
  lists, one-feature-at-a-time work, progress artifacts, git commits, and
  session-start smoke tests:
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic's context engineering writeup frames reliable agents as a context
  curation problem: keep the smallest high-signal context needed for the next
  action:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- The local Codex manual documents `workspace-write`, approval policy,
  auto-review approvals, writable roots, network access, profiles, and
  automations. Use a profile rather than broad full access unless the runtime is
  already isolated.
