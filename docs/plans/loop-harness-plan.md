# Bonfire Loop Engineering Harness — Build Plan

Status: DRAFT under `/plan-eng-review` — architecture forks (A1–A5) and
code-quality forks (CQ1–CQ2) RESOLVED; build order re-sequenced after the
cross-model (Codex) challenge. Awaiting final approval. No teardown and no harness
code happens until you approve.

Author intent: build the world-class, frontier-grade (June 2026) loop engineering
scaffold that autonomous coding agents will use to build and maintain Bonfire DB —
an open-source healthcare-infrastructure project whose code quality and system
design must be world-class for the whole life of the project.

Source of truth for the PRODUCT being built: `docs/plans/mvp-demo-plan.md` (v2,
kept) — the engineering build spec derived from the live Co-founder Plan at
https://plans.bonfiredb.dev/ (captured as `docs/plans/cofounder-plan.html`,
2026-06-25). It defines slices BF-01..BF-12 with security, performance, and
AI-nativeness as first-class primitives. This plan is about the HARNESS that
builds it. Where the local spec and the live page disagree, the live page wins.

## Locked scope decisions (from this review's Step 0)

- **Teardown mode: total greenfield.** Delete everything except `docs/plans/*`.
  Re-derive the harness design from first principles + research, not from the
  prior implementation. (User chose this over "fresh rebuild, keep the design.")
- **Frontier reach: proven + emerging, maximal now.** Build the complete proven
  primitive set AND the emerging layer (self-harness, continual-harness,
  multi-agent parallel, dynamic tool assembly).
- **Risk acknowledged:** a blank-page rewrite can re-derive a worse architecture
  and reintroduce already-solved bugs. Mitigation (free, in-mandate): seed the
  eval corpus + Ratchet memory on day one with the known historical incident
  classes so they can never recur, without copying any prior code.

## Two codebases, one repo

```
THE HARNESS  (this plan)            THE PRODUCT  (built BY the harness)
  finds work, isolates it,            Bonfire DB v0 per mvp-demo-plan.md:
  makes it, checks it (maker≠          cited search, ABAC+consent gate,
  checker), gates it, remembers        hash-chained audit, propose-only
  every failure, lets a human          agent writes, FHIR R4 round-trip,
  gate every mutation, and             typed SDK + local MCP.
  improves itself.
```

The harness is held to the SAME world-class bar as the product. It is typed,
tested, linted, and gated like shipping code, because an agent-written product is
only as good as the harness that gates it.

## The frontier formula

`Agent = Model + Harness`. A decent model with a great harness beats a great
model with a bad harness. The harness's job is the loop:

`discover → isolate → make → verify (maker≠checker) → gate (deterministic→eval→verify) → human → remember`

---

## 1. Teardown plan (what gets deleted, what survives)

DELETE (greenfield):

```
.agents/  .claude/agents/  .claude/skills/(local bonfire)  .codex/
.github/workflows/loop-ci.yml
scripts/  (loop/, seed/, smoke/)
apps/  packages/  drizzle/  seed/
docker-compose.yml  Dockerfile  tsconfig*.json  package.json  bun.lock
docs/loop/   AGENTS.md  README.md   (regenerated to the new bar)
```

KEEP:

```
docs/plans/*    (the product spec + this harness plan + brand/deploy artifacts)
.git/           (history is the archive; teardown is a commit, not a force-push)
```

Teardown is a normal commit on a feature branch. Nothing is force-pushed; the
prior implementation stays recoverable in history.

---

## 2. Target repo architecture (world-class TS monorepo)

Traits taken from Convex / Neon / Azure SDK / Feature-Sliced Design research:
hard boundaries with one-way dependencies, explicit public API per package,
compiler-enforced module isolation, parse-don't-validate at every edge.

```
bonfire-db/
  package.json            Bun workspace; Node 24 LTS compatible
  tsconfig.base.json      strict + project references (composite)
  dprint / biome config   one formatter, checked in
  eslint.config.ts        typescript-eslint strict-type-checked + ai-guardrails
  dependency-cruiser.cjs  module-boundary rules (one-way deps, no cycles)
  knip.json  jscpd.json  semgrep rules  stryker.conf
  sgconfig.yml            ast-grep structural rules (search + slop gates, A6)
  .mcp.json               Serena (LSP symbol nav) + ast-grep MCP (A6)

  loop/                   THE HARNESS (first-class, typed, tested)
    cli/                  `loop <command>` (Bun/TS): triage worktree gate
                          ratchet eval metrics self-improve
    agents/               ONE source of truth -> generates .claude + .codex defs
    skills/               ONE source -> generates Claude + Codex skill files
    contracts/            slice contract Zod schema + loader + allowed-paths check
    gates/                deterministic gate runners (typecheck/lint/knip/...)
    verify/               verifier structured VERDICT schema + handoff validation
    memory/               STATE ledger, bug-patterns KB, Ratchet generator
    evals/                eval corpus + runner (execution-watching) + bias control
    observability/        trace emitter + metrics rollup
    self-harness/         trace+KB miner -> harness-change proposer (gated)

  packages/               THE PRODUCT (built by the loop, per mvp-demo-plan.md)
    core/  sdk/  mcp/
  apps/   api/  demo/
  drizzle/  seed/
  docs/   adr/  loop/  plans/  architecture.md  ...
  .github/workflows/      CI: deterministic gates, evals, nightly mutation
```

Module dependency direction (enforced by dependency-cruiser, not by convention):

```
apps/*  ─▶  packages/sdk ─▶ packages/core ◀─ packages/mcp
                              ▲
loop/*  ─▶ loop/* only (harness never imports product internals)
```

TypeScript bar (machine-checked): `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `module/moduleResolution: NodeNext`,
`composite: true`, emit `.d.ts` + maps. No `any` (error), no `@ts-ignore`
(blocked), `unknown` + narrowing at edges, discriminated unions + exhaustive
`switch`, branded ID types, Zod at every boundary, `package.json` `exports`
restricting deep imports, public API frozen by `@microsoft/api-extractor`
snapshot.

Error handling (hybrid — convergent practice of Supabase/Neon/Convex):
- Public SDK/API boundary returns a tagged discriminated union
  `Result<T, BonfireError> = { ok: true; data: T } | { ok: false; error: BonfireError }`
  (TS exhaustiveness forces the `ok` check before `data` is reachable — stronger
  than Supabase's nullable `{data,error}` tuple).
- Internal core/harness code throws typed error classes, caught at boundaries
  (idiomatic, low ceremony; matches Neon's pg-compatible driver and Convex).
- All errors are structured values carrying a stable `code` (SQLSTATE /
  `ConvexError.data` discipline); callers branch on `code`, never on strings.
- Authz is DEFAULT-DENY: anything not an explicit `{ allow: true }` — including
  an error — denies. Makes fail-open structurally hard regardless of idiom.
- `neverthrow`-everywhere is rejected (no exemplar enforces Results internally;
  friction not worth it). neverthrow optional, boundary-scoped only.

---

## 3. The loop primitives (proven core)

1. **Heartbeat / discovery** — `loop triage` scans the product spec (generates
   the slice registry), CI, open issues, and the STATE ledger, then PROPOSES the
   next slice. Driven by `/loop` (cadence), `/goal` (run-until-condition, always
   turn-capped), or `/schedule` (cron, dev-only). Report-only by default.

2. **Isolation** — `loop worktree <slice>` creates a per-agent worktree
   `bonfire-<slice>-<session>` with a unique slug. Every writing agent gets its
   own worktree. This is the safe form of "parallel on the shared tree." (A2)

3. **Slice contract (spec-driven)** — each unit of work is a typed, Zod-validated
   contract: `id, goal, why, profile, allowedPaths, forbiddenPaths, acceptance[],
   verify[], evals[], caps{maxAttempts,maxTurns,maxBudgetUSD}, requiredAgents`.
   The slice registry is HUMAN-AUTHORED (a typed `tasks` file), reviewed once
   against `mvp-demo-plan.md` (v2), carrying the BF-01..BF-12 IDs + acceptance
   from the refreshed product spec — NOT auto-parsed from prose (prose parsing would
   silently rewrite work boundaries; Codex finding). CI fails the slice if touched
   files fall outside `allowedPaths` (the prior harness lacked this drift check).
   The verifier rejects a slice whose acceptance is not objectively checkable.

4. **Maker ≠ checker** — distinct agents, checkers read-only:
   - `planner` — decomposes a slice into tracer-bullet steps (optional).
   - `maker` — writes code in the worktree (Read/Write/Edit/Grep/Glob only).
   - `verifier` — RUNS the gate (exit status, files, tests, lint, evals), never
     self-grades, emits a structured VERDICT validated against a Zod schema.
   - `security-auditor` — PHI/synthetic-only/authz/audit/tool-exposure (read-only).
   - External AI review: Greptile 5/5 required signal (see A4). No local judge panel.

5. **Gate pipeline** — deterministic-first, judge-second, "silent success,
   verbose failure":

```
  Stage 0  HOOKS (every edit)    format · typecheck · lint  ─▶ inject failures back to maker
  Stage 1  DETERMINISTIC (CI)    tsc --build · eslint strict (no @ts-ignore/disable)
                                 · knip (dead code) · jscpd (dup) · dependency-cruiser
                                 · api-extractor (surface) · coverage on CHANGED lines
                                 · Semgrep + secret scan · synthetic-only (semantic)
                                 · allowed-paths diff check
  Stage 2  EVALS (exec-watching) run the built artifact, assert behavior
                                 (golden queries, ABAC deny, audit tamper, FHIR rt)
  Stage 3  VERIFIER + SEC AUDIT  verifier emits structured VERDICT; security-auditor
                                 checks PHI/authz/audit. Greptile 5/5 required signal.
  Stage 4  HUMAN CHECKPOINT      human reads diff + verdict + 5/5, performs the merge.
                                 final merge is ALWAYS human. never auto-merge.
  NIGHTLY  Stryker (mutation) + fast-check (property) on critical paths (cost-bounded)
```

Gate severity tiers (Codex finding): in Phase 1 bring-up, gates split into
BLOCKING (typecheck, lint with no escape hatches, tests, Semgrep/secret scan,
synthetic-only, allowed-paths) and ADVISORY (knip, jscpd, api-extractor,
no-magic-numbers) until the codebase shape stabilizes; advisories graduate to
blocking by end of Phase 2. Avoids early false-positive noise blocking real work.
Greptile enforcement of record: a required status check where Greptile exposes
one; otherwise the human-merge checklist records the reviewed-SHA 5/5 link before
merge. The merge is never performed without a recorded 5/5.

6. **Memory / the Ratchet** — the "agents remember bugs and never repeat them"
   requirement, made machine-enforced:
   - `loop/memory/bug-patterns.jsonl`: every confirmed failure becomes
     `{id, class, symptom, rootCause, fix, permanentGuard}`.
   - A failure is not "closed" until it produces a permanent guard: a lint rule,
     a Semgrep rule, an eval case, or an AGENTS.md checklist line.
   - `loop ratchet` GENERATES the enforceable artifacts from the KB, so memory is
     enforced by the toolchain, not by an agent remembering prose.
   - STATE ledger (inbox/active/done/failed) is the spine the loop reads/writes
     every run. The agent forgets; the repo enforces.

7. **Eval harness (the measurable self-improvement loop)** — `loop eval`:
   execution-watching evals seeded from incidents + acceptance criteria; tiered
   difficulty; release thresholds; a judge-bias control set (known-good moves) to
   detect judge drift. Evals gate landing AND measure the harness improving.
   The corpus MUST cover the product's dangerous failure modes (mvp-demo-plan v2):
   retrieval returned before the ABAC/RLS filter, cross-tenant / cross-practice_id
   leak on any path (SQL/vector/agent), lossy FHIR mapping passing as "lossless",
   fake "FHIR-valid"/conformant confidence, audit append-only bypass / hash-chain
   tamper, and a broken propose-only invariant (agent able to approve/commit).

8. **Context engineering** — fan-out → reduce → synthesize (3–5 concurrent sweet
   spot, hard cap per platform); subagents return distilled summaries; large tool
   output offloaded to the filesystem; proactive compaction; clean handoff before
   context rots; ≤10 focused MCP tools.

9. **Observability** — every agent run emits a trace (jsonl): tokens, cost,
   latency, gate results, verdict, files touched. `loop metrics` rolls up. This
   is the cost-watch the loop needs and the on-ramp to self-improvement.

10. **Human checkpoint** — report-only default; the loop proposes, a human gates
    every mutation. Dial up per task (draft PRs); never standing, never prod,
    never PHI through a cloud sandbox.

---

## 4. The emerging layer (maximal frontier — user-selected; built in Phase 3)

Per the cross-model sequencing decision, the emerging layer is built AFTER the
thin gated harness ships the first product slices, hardened around failures
actually observed (not before BF-01). Full scope retained; only the order changed.

11. **Self-harness** — `loop self-improve` mines its own traces + bug KB, proposes
    harness improvements (new gates, sharper prompts, tool tweaks), validates them
    against the eval corpus + judge-bias control, and opens a PR. Autonomy
    boundary is OPEN (A3).
12. **Continual-harness** — mid-slice online correction: the verifier injects a
    corrected instruction/tool/memory into the maker loop without a full reset,
    bounded by slice caps.
13. **Multi-agent parallel** — fan out N slices concurrently, each in its own
    worktree; a merge-coordinator serializes integration and re-runs the gate on
    the merged result; lanes partitioned by module to minimize conflicts. (A2)
14. **Dynamic tool assembly** — the planner assembles the minimal toolset per
    slice from the HARNESS tool registry (≤10 tools), schemas derived from typed
    functions, instead of a fixed global set. SAFETY (Codex finding): this applies
    to the harness's own agent tooling ONLY. The PRODUCT's MCP surface stays a
    fixed allowlist with no arbitrary tool execution (per mvp-demo-plan.md);
    dynamic assembly never widens the product's exposed tools.

---

## 5. Anti-slop gate stack (research-mapped)

Every known AI-slop pattern maps to an automated gate. Hard constraints the agent
cannot ignore; the verifier agent catches the semantic slop tools can't.

| Slop pattern | Gate | Stage |
|---|---|---|
| `any` / `@ts-ignore` / `as` escape | typescript-eslint `no-explicit-any`, `ban-ts-comment`; eslint-plugin-no-comments | 0/1 |
| hallucinated APIs / packages | `bun install --frozen-lockfile`; knip unresolved; new-dep human gate | 1 |
| copy-paste duplication | jscpd (fail on new dup) | 1 |
| dead / unreachable code | knip; `no-unreachable` | 1 |
| premature abstraction | dependency-cruiser single-importer; verifier "rule of three" | 1/3 |
| god files / functions | eslint-plugin-ai-guardrails `max-file-lines`/`max-function-lines`; `complexity` | 1 |
| shallow / tautological tests | Stryker mutation (nightly, critical paths); verifier test-honesty audit | nightly/3 |
| missed edge cases | fast-check property tests | nightly |
| swallowed errors / fail-open | `no-empty`, `no-floating-promises`; Semgrep authz; verifier fail-closed check | 1/3 |
| over-commenting | ai-guardrails `no-ai-obvious-comments`; verifier "why-not-what" | 1/3 |
| magic numbers | `no-magic-numbers` | 1 |
| insecure defaults | Semgrep + secret scan; security-auditor | 1/3 |
| module-boundary violations | dependency-cruiser | 1 |
| public-API drift | api-extractor snapshot | 1 |
| inconsistent naming | `naming-convention`; verifier consistency-with-neighbors | 1/3 |
| PHI / real data | semantic synthetic-only scanner (not regex); security-auditor | 1/3 |

Note: `ast-grep` (A6) is the structural enforcement engine for the syntax-aware
slop rules above (empty catch, fail-open shapes, banned constructs) and doubles
as the agent's structural search tool — one tool serving search and gates.

---

## 6. RESOLVED DECISIONS (A1–A5, CQ1–CQ2)

> The load-bearing, hard-to-reverse forks, each decided via AskUserQuestion in
> this review and locked here.

- **A1 — Orchestration substrate. DECIDED: Claude Code dynamic Workflows as the
  fan-out/concurrency/retry/resume engine + a typed Bun/TS `loop` CLI for the
  deterministic steps (worktree, gate, ratchet, eval, verify, metrics, traces).**
  No daemon, no hosted service, no new heavyweight dependency. The `loop` CLI is
  usable standalone so the loop is not hard-locked to one orchestrator host.
  Rationale: boring-by-default, fewest moving parts, spends innovation tokens on
  the product not the scheduler.
- **A2 — Parallel-safety model. DECIDED: worktree-per-agent + serial
  merge-coordinator.** Every writing agent runs in its own git worktree
  (`bonfire-<slice>-<session>`, unique slug). A serial merge-coordinator
  integrates finished worktrees one at a time and re-runs the FULL gate on the
  merged result; slices are partitioned into lanes by module to minimize
  conflicts. No two agents ever share a checkout. This is the exact form the
  monorepo `CLAUDE.md` mandates ("pre-create one worktree per agent"); it
  delivers real parallelism with zero shared-tree collisions.
- **A3 — Self-harness autonomy boundary. DECIDED: tiered auto-apply.**
  - AUTO-APPLY lane (no human): only changes that (a) touch the self-tunable
    allowlist — agent/maker prompts, Ratchet-generated additive lint/semgrep/eval
    seeds, tool-registry descriptions — AND (b) pass the full eval corpus +
    judge-bias control + every deterministic gate AND (c) are net-additive.
    Auto-applies land as a dedicated gated PR that merges only if all of the
    above hold. Every auto-apply is trace+ledger logged and revertible in one
    commit; a weekly human review covers the auto-applied set.
  - HUMAN-GATED lane: anything structural or on the denylist — gate definitions,
    merge policy, human-checkpoint, PHI/synthetic scanner, eval bias-control set,
    autonomy config.
  - HARD INVARIANT: auto-apply may only ADD or STRENGTHEN a guard, never remove
    or weaken one. Any change that reduces coverage is structural by definition
    and routes to the human lane. This bounds the blast radius the tiered posture
    accepts.
- **A4 — Merge/review gate. DECIDED: Greptile 5/5 is the AI reviewer; human is
  the final merge authority.**
  - FIXED: Greptile 5/5 is a required quality signal on every PR. The final merge
    is always performed by a human after review. No auto-merge, ever.
  - CORE (always runs, not "AI review"): deterministic gate stack +
    execution-watching evals + the verifier (runs tests/checks, emits a
    structured VERDICT) + the security-auditor (PHI/synthetic/authz/audit).
  - NO separate local cross-model judge panel: with Greptile providing external
    AI review and a human reviewing every merge, a second AI grader is redundant.
  - Greptile-flakiness note: because a human is the final merge authority, the
    automated polling/racing that caused the prior 8 Greptile incidents is gone.
    The human waits for and reads the 5/5; we wire Greptile's required check via
    branch protection where it exposes one, and keep zero brittle auto-proceed
    logic. If Greptile exposes no required check, the human verifies the 5/5
    before merging.
- **CQ1 — Test rigor cadence. DECIDED: per-PR coverage on changed lines +
  verifier test-honesty audit; nightly Stryker mutation + fast-check property
  tests on critical paths (ABAC, consent, audit hash-chain, PHI/synthetic,
  FHIR).** Rigor where a clinical bug matters most, without exploding per-PR CI
  cost on an agent repo.
- **CQ2 — Error-handling idiom. DECIDED: hybrid (Result union at the public
  boundary, throw internally), default-deny authz, structured coded errors,
  no neverthrow-everywhere.** Grounded in Supabase/Neon/Convex (see section 2
  Error handling). Reverses the initial neverthrow-everywhere lean after research.
- **A5 — Memory substrate. DECIDED: in-repo bug-pattern ledger + Ratchet
  generator (enforced, not recalled).** `bug-patterns.jsonl` + STATE ledger +
  eval corpus live in the repo (git-versioned, diffable, offline, zero external
  dep). `loop ratchet` generates an enforceable guard from each entry (lint rule,
  Semgrep rule, eval case, or AGENTS.md checklist line). A bug is not "closed"
  until it produced a guard, so the SPECIFIC regression a guard encodes cannot
  recur (the gate fails). Broad semantic / timing / cross-layer bug CLASSES are
  reduced, not eliminated (Codex: no guard makes all bugs impossible). EUREKA:
  for repeat of a KNOWN bug, deterministic enforcement is strictly stronger than
  probabilistic semantic recall. An embedding/vector recall index is rejected (see A6); ripgrep over the
  small JSONL ledger is exact and instant, with no index to stale.

- **A6 — Agent search / retrieval substrate. DECIDED: agentic on-demand search,
  NO embeddings.** Mirrors how Claude Code/Codex already work and the 2026
  consensus that agentic search matches/beats vector RAG (Anthropic removed vector
  search from Claude Code; Amazon Science AAAI 2026: ~94.5% of RAG faithfulness,
  zero vector store). Three free, local layers:
  - LEXICAL (backbone): native on-disk search (ripgrep / ugrep / bfs), built into
    Claude Code + Codex. Zero setup, always fresh.
  - STRUCTURAL: `ast-grep` (+ agent-skill / MCP) for syntax-aware search AND as
    the enforcement engine for the syntax-level slop rules in the gates/Ratchet
    (one tool, two jobs).
  - SYMBOL: Serena MCP (LSP-backed, local TS language server) for
    references/implementations/scoped reads+edits; reads only the relevant symbol,
    not whole files (token-efficient). Runs locally = zero code/data egress (PHI
    posture).
  - NO embeddings/vector index for code OR the bug-ledger: staleness, index
    maintenance, and data-egress costs outweigh the benefit; the ledger is a small
    JSONL where ripgrep is exact and instant.

---

## 7. Build order (re-sequenced after the cross-model challenge)

All scope retained; the ORDER changed so a thin gated harness ships real product
work before the emerging layer is built. Three phases.

PHASE 1 — Thin gated harness (prove the spine)

```
H0  Repo skeleton: Bun workspace, strict tsconfig + project refs, formatter,
    eslint strict (no escape hatches), CI. Blocking gates only (severity tiers).
    Wire the agent search stack (native lexical + ast-grep + Serena MCP, A6).
H1  Human-authored slice registry (Zod) reviewed once vs mvp-demo-plan.md (v2),
    carrying BF-01..BF-12 IDs + acceptance; allowed-paths diff check.
H2  Agent single-source generators (.claude + .codex, drift round-trip test).
    Skill generators are moved to a post-H3 phase: skills invoke the `loop` CLI
    (H3), so generating them before that CLI exists would ship half-baked skills.
H3  Deterministic gate runners (Stage 0/1) + `loop gate` + worktree isolation.
H4  Memory spine: STATE ledger + bug-patterns KB + `loop ratchet`, seeded with
    historical incident classes. Verifier VERDICT schema. Greptile + human gate.
```

PHASE 2 — Ship the first product slices (prove the loop on real work)

```
P2a BF-01 (workspace + Docker + Postgres/pgvector boot + health) runs through the
    loop end to end: maker -> gates -> verifier -> Greptile 5/5 -> you merge.
P2b BF-02 (schema/migrations/seed/synthetic scanner) the same way.
    Graduate advisory gates (knip/jscpd/api-extractor) to blocking.
    Add execution-watching evals (Stage 2) seeded from BF-01/02 acceptance.
```

PHASE 3 — Emerging layer, hardened around observed failures

```
H5  Eval harness depth + judge-bias control + `loop eval`.
H8  Observability traces + `loop metrics`.
H9  Continual-harness online correction; dynamic tool assembly (harness-only).
H10 Self-harness proposer (A3, tiered auto-apply), gated.
H7+ Multi-agent parallel + merge-coordinator once >1 independent slice exists.
H11 Docs: AGENTS.md, README, CONTRIBUTING, SECURITY, ADRs, architecture.md.
    Then continue BF-03..BF-12 with the full loop.
```

Harness budget / kill criteria (Codex finding): Phase 1 is effort-capped — the
thin harness must ship BF-01 within a bounded window; if it slips, stop adding
harness and ship the product manually. Rule of record: never build a Phase 3
capability before a product failure or a concrete BF slice needs it. "Stop
building harness, ship product" overrides "add another gate."

---

## 8. Test plan for the harness itself

The harness is tested like product code (TESTING.md bar). 100% codepath coverage
is the goal; list below derived from the `/plan-eng-review` coverage diagram.

Unit / behavioral:
- Contract loader: Zod accept/reject; allowed-paths diff true AND false branches.
- Gate runners: each gate passes on a clean fixture, fails on a planted-slop
  fixture; AND stage ordering + fail-fast short-circuit (deterministic before
  eval) is asserted.
- Ratchet generator: a KB entry produces the expected lint/semgrep/eval artifact;
  AND the "a bug is not closed until it produced a guard" invariant fails closed
  when a guard is missing.
- STATE ledger: read/write/append CRUD; concurrent-append safety (no lost writes
  under parallel agents).
- Eval runner: execution-watching asserts on known-good and known-bad artifacts;
  judge-bias-control detection; seeded incident evals (greptile-race, gate
  ordering, fail-open authz) actually run and catch their regression.
- Single-source generators: generated `.claude` and `.codex` agent/skill files
  match the single source (drift round-trip test — the generator's whole purpose).
- Verifier VERDICT: structured VERDICT schema validation (accept/reject).
- Self-harness: denylist file → proposal rejected; coverage-reducing change →
  routed to human lane (net-additive invariant, A3); auto-apply fires only when
  on the allowlist AND every gate/eval/bias-control is green (A3).
- Observability: a run emits a well-formed trace; metrics rollup is correct.
- CLI: command parse + exit codes for all commands (triage, worktree, gate,
  ratchet, eval, metrics, self-improve).
- Continual-harness: online correction stays within slice caps (does not exceed
  maxTurns/maxBudget when injecting a correction).
- Dynamic tool assembly: assembled set is ≤10 tools and schemas derive from the
  typed functions (no hand-written drift).

Integration / E2E:
- Worktree + merge-coordinator: two parallel slices merge with no clobber;
  unique-slug avoids parallel-tab collision; merge RE-RUNS the full gate on the
  merged result.
- Greptile required-check wiring: the 5/5 check is present and blocks merge when
  unmet (branch-protection level).
- Full loop E2E: one trivial slice runs triage → worktree → maker → gate →
  human-checkpoint end to end.

Eval:
- Agent prompts (maker/verifier/security-auditor): prompt-regression eval runs
  when any prompt changes; output still meets the quality bar (gates self-harness
  auto-applied prompt edits).

---

## 9. Performance & scaling

The harness's performance surface is loop throughput, CI/gate latency, agent
concurrency, and token cost (not DB access — that is the product's concern).

- **Affected-only + incremental.** The gate stack runs only on affected packages
  (turbo `--filter=...[origin/main]`), `tsc --build` incremental via project
  references + `.tsbuildinfo`, eslint + coverage on CHANGED lines. Remote/build
  cache so unchanged packages are not re-checked. Keeps per-PR CI fast as the
  monorepo grows.
- **Concurrency.** 3–5 concurrent agents is the throughput sweet spot (merge cost
  dominates past that); hard cap at the Workflows limit (≤16). Worktrees are
  bounded and auto-removed after merge to cap disk.
- **Token / cost discipline.** Subagents return distilled summaries (fan-out →
  reduce → synthesize), large tool output is offloaded to the filesystem, `/goal`
  is always turn-capped, and per-slice `maxBudgetUSD` is enforced. Observability
  meters tokens/cost/latency per run so cost regressions are visible.
- **Mutation testing** is cost-bounded to nightly critical paths (CQ1), never
  per-PR repo-wide.
- **Eval latency** is bounded by slice caps; evals run the built artifact inside
  the slice's worktree.

No performance forks require a decision; this strategy is folded into the plan.

## 9b. NOT in scope (deferred, with rationale)

- Building the product slices (BF-01..BF-11) — downstream; this plan lays the
  foundation, a follow-up session runs the loop.
- Production cloud infra, real PHI, BAA hosting, HIPAA-complete controls — the
  product is a local synthetic demo (per mvp-demo-plan.md).
- Hosted/remote MCP — local-only in v0.
- Auto-merge to main, unattended prod mutation, cloud-routed reviews on PHI —
  forbidden by HIPAA + the monorepo concurrency rules.
- Embeddings / vector RAG for code search OR memory — rejected (A6). Agentic
  on-demand search (native lexical + ast-grep structural + Serena LSP) matches or
  beats it without the index, staleness, or code/data-egress cost.
- Vector recall index over the bug-ledger — explicitly skipped (you decided);
  superseded by ripgrep over the JSONL ledger (A6).

---

## 10. What already exists (and how this plan treats it)

The repo today holds a ~60–70%-correct harness plus a half-built product. Per the
greenfield decision, all of it is deleted except `docs/plans/*`; the proven
CONCEPTS reappear only as convergent first-principles design, never copied code.

| Existing | Treatment |
|---|---|
| Slice contract + `tasks.json` registry | Delete; concept → typed, human-authored Zod registry (H1) |
| maker/verifier/security-auditor (`.claude`+`.codex`) | Delete; concept → single-source-generated agents (H2) |
| profile gates, `STATE.md` spine | Delete; concept → gate pipeline + STATE ledger (H3/H4) |
| greptile-gate ~1100 LOC polling | Delete; → Greptile required-check + human-merge (A4), no auto-proceed |
| `scripts/loop/*` (ci-watch, ledger, task, verify) | Delete; → typed `loop` CLI |
| `apps/*`, `packages/*`, drizzle, seed (half-built) | Delete; rebuilt by the loop per `mvp-demo-plan.md` |
| `docs/loop/*` (RUNBOOK/AUTONOMY/ACCEPTANCE) | Delete; regenerated (concepts kept) |

Reuse vs rebuild: the architecture is reused as design (convergent); the code is
rebuilt. The 8 prior incident classes are reused as eval/Ratchet seeds (A5).

---

## 11. Failure modes (per new codepath)

| Codepath | Realistic production failure | Test? | Error handling | Visible/silent |
|---|---|---|---|---|
| Gate runner | a gate TOOL crashes (semgrep OOM, ast-grep parse error) read as "pass" | T1 | must treat any non-success as FAIL | **SILENT — CRITICAL** |
| Slice-contract loader | malformed registry → throw | yes | caught, slice rejected w/ clear error | visible |
| allowed-paths diff | maker edits out-of-scope file | yes | CI fails, slice blocked | visible |
| Ratchet generator | bad KB entry → broken generated rule reds all CI | T4 | validate generated artifact pre-commit | visible (self-inflicted) |
| Merge-coordinator | two worktrees edit same file → silent auto-resolve clobber | T5 | conflict → human; re-run gate on merge | visible if handled |
| Greptile required-check | check never resolves → merge blocked forever | — | human is final authority + manual-override path | visible |
| Self-harness auto-apply | change LOOKS additive but subtly weakens a guard | T8 | net-additive test + weekly human review + 1-commit revert | **partly silent — residual accepted risk (A3)** |
| Worktree mgmt | disk exhaustion under high parallelism | — | bounded concurrency + auto-cleanup | visible |
| Eval runner | built artifact hangs (infinite loop) | — | per-eval timeout via slice caps | visible (timeout) |

**Critical gaps flagged:** (1) gate-runner fail-open if a tool crash is read as
pass → T1 (P1); (2) self-harness subtle-weakening that passes the additive check →
T8 + mandatory weekly human review (the residual risk the tiered A3 posture accepts).

---

## 12. Worktree parallelization strategy

| Step | Modules | Depends on |
|---|---|---|
| H0 skeleton | root configs, CI, `.mcp.json` | — |
| H1 slice registry | `loop/contracts` | H0 |
| H2 generators | `loop/agents` (skills deferred post-H3) | H0 |
| H4 memory | `loop/memory` | H0 |
| H3 gates+worktree+cli | `loop/gates`, `loop/cli` | H0, H1 |
| Phase 2 BF-01→BF-02 | `packages/`, `apps/`, `drizzle/`, `seed/` | H0–H4 |
| H5 evals | `loop/evals` | H4, Phase 2 |
| H8 observability | `loop/observability` | H3 |
| H9/H10 emerging + self-harness | `loop/self-harness`, `loop/cli` | H5, H8 |

Lanes:
- Lane A: H1 → H3 (sequential — H3 depends on H1; both touch `loop/cli`)
- Lane B: H2 (independent)
- Lane C: H4 (independent)

Execution: H0 first (foundation, sequential — every lane needs root config). Then
launch Lanes A/B/C in parallel worktrees; merge. Phase 2 is strictly sequential
(BF-01 → BF-02, shared `packages/`). Phase 3: H5 + H8 in parallel, then H9/H10.
Conflict flags: Lane A's H3 and later CLI work both touch `loop/cli` — serialize
CLI changes. H0 touches root config all lanes need — must finish before any lane.

---

## 13. Implementation tasks

Synthesized from this review's findings; each derives from a specific finding.

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — gates — gate runner is fail-CLOSED
  - Surfaced by: Failure modes — a crashed gate tool must never read as pass
  - Files: `loop/gates/**`
  - Verify: planted tool-crash fixture → runner exits non-zero (FAIL)
- [ ] **T2 (P1, human: ~3h / CC: ~25min)** — contracts — human-authored Zod slice registry
  - Surfaced by: Codex #5 + A6 — no prose auto-parsing of work boundaries
  - Files: `loop/contracts/**`
  - Verify: registry validates; BF-01..11 IDs+acceptance carried from product spec
- [ ] **T3 (P1, human: ~4h / CC: ~30min)** — generators — single-source agent/skill gen + drift test
  - Surfaced by: Test review GAP — `.claude`/`.codex` must not drift
  - Files: `loop/agents/**`, `loop/skills/**`
  - Verify: generated outputs match source (round-trip test)
- [ ] **T4 (P2, human: ~2h / CC: ~15min)** — memory — Ratchet validates generated guards pre-commit
  - Surfaced by: Failure modes — a bad guard must not red all CI silently
  - Files: `loop/memory/**`
  - Verify: malformed KB entry → generation fails loudly, not a broken rule
- [ ] **T5 (P2, human: ~5h / CC: ~40min)** — cli — merge-coordinator: conflict→human, re-run gate
  - Surfaced by: A2 + Failure modes — no silent clobber on merge
  - Files: `loop/cli/**`
  - Verify: two conflicting worktrees → coordinator stops, gate re-runs on merge
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — gates — gate severity tiers (blocking vs advisory)
  - Surfaced by: Codex #10 — avoid early false-positive noise
  - Files: `loop/gates/**`, CI config
  - Verify: advisory gate failure warns; blocking gate failure blocks
- [ ] **T7 (P2, human: ~2h / CC: ~15min)** — search — wire A6 stack (ast-grep + Serena MCP + native)
  - Surfaced by: A6 — agentic search substrate, no embeddings
  - Files: `sgconfig.yml`, `.mcp.json`
  - Verify: ast-grep rule runs; Serena resolves a TS symbol locally
- [ ] **T8 (P2, human: ~4h / CC: ~30min)** — self-harness — net-additive invariant + allow/denylist
  - Surfaced by: A3 + Failure modes — bound the tiered auto-apply blast radius
  - Files: `loop/self-harness/**`
  - Verify: coverage-reducing change → human lane; denylist file → rejected
- [ ] **T9 (P2, human: ~3h / CC: ~25min)** — evals — seed corpus: incidents + product danger modes
  - Surfaced by: Eval section + Codex #11 — retrieval-before-policy, leakage, FHIR, audit
  - Files: `loop/evals/**`
  - Verify: each seeded regression fails the eval when reintroduced
- [ ] **T10 (P3, human: ~3h / CC: ~25min)** — observability — traces + metrics + cost caps
  - Surfaced by: Performance — cost/latency visibility, per-slice budget
  - Files: `loop/observability/**`
  - Verify: a run emits a well-formed trace; metrics rollup correct
- [ ] **T11 (P3, human: ~1h / CC: ~10min)** — docs — harness kill-criteria + Phase-1 budget
  - Surfaced by: Codex #8 — "stop building harness, ship product" rule
  - Files: `docs/loop/RUNBOOK.md` (regenerated), this plan
  - Verify: kill-criteria documented and referenced by triage

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (infra; no product-direction change) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | outside-voice plan review: 12 findings |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 22 issues, 2 critical gaps, 11 tasks |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (harness has no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** Outside voice (Codex) ran read-only against the plan. Central finding:
  the harness was over-built before the product exists (full H0–H11 before BF-01).
  Resolved by re-sequencing into three phases (thin gated harness → ship BF-01/02 →
  emerging layer), keeping 100% of scope. Six further hardening points folded:
  human-authored slice registry (no prose parsing), softened Ratchet overclaim,
  gate severity tiers, dynamic-tool safety, Greptile enforcement of record, and
  harness kill-criteria; the stale "A1–A5 OPEN" header was fixed.
- **CROSS-MODEL:** Codex independently reached this review's own Step-0 concern
  (build order / over-build). You chose the synthesis (re-sequence, keep all scope)
  over "keep current order" and "cut scope." Strong consensus on sequencing; the
  maximal-frontier ambition stands as your deliberate call.
- **VERDICT:** ENG (PLAN) reviewed — 8 forks resolved (A1–A6, CQ1–CQ2), 11 build
  tasks defined (T1–T3 are P1, including 2 critical-gap closers). Plan is locked
  pending your final approval; no teardown and no harness code until you approve.

NO UNRESOLVED DECISIONS
