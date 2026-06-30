# Bonfire DB — MVP Build Spec (v3)

Status: PRIMARY product source of truth for the loop harness.
Supersedes v2 (recoverable in git history).
Derived from the live Co-founder Plan at https://plans.bonfiredb.dev/ (captured
locally as `docs/plans/cofounder-plan.html`) and a June-2026 site audit
(bonfiredb.dev, 38 pages) + a 12-decision industry/frontier research pass with an
adversarial over-ambition review (see "Review provenance" at the end).

Where this file and the live page disagree, **this file wins for engineering scope**
(the v2 rule "the live page wins" is retired: the site is marketing-ahead-of-build
and, on two points — source of truth and benchmark data — is actively riskier than
the researched design; those are corrected here and the site should follow).

Purpose: an engineering build spec the autonomous loop executes to ship the
~14-day OSS MVP — a clean clone that boots, a five-beat wow under 5 minutes with
zero API keys, an open published benchmark number, and a reference AI-scribe app.

## Thesis (one design decision)

Agents are bad at clinical data and clinical agent loops are expensive (a full FHIR
record runs to millions of tokens; on the public FHIR-AgentBench, naive "whole
record in context" fails and the best agent config still only reaches ~0.50 answer
correctness — the bottleneck is *parsing FHIR's nested graph*, not fetching it).
Bonfire fixes both with ONE decision: **the agent never reads raw FHIR; it reads a
Cited Context Projection (CCP) we build from canonical FHIR underneath.**

- **Cheaper is measured today** (token reduction is deterministic and provable —
  Flexpa independently cut LLM context ~92% with the same SQL-on-FHIR move).
- **More accurate is the next measured test, not a claim.** We publish the
  accuracy result honestly via an open benchmark (BTAB); we do not assert "more
  accurate" ahead of the number. Honesty is the moat.

Public naming: the CCP is marketed as the **"evidence packet"**; CCP is the
internal/spec term. Both name the same artifact (compact, span-cited, query-aware
projection).

Positioning: the open-source, agent-native backend for AI-health apps. Start with
AI scribes; become the default backend. Apache-2.0, run real PHI on your own infra.

## The three primitives (built-in from row zero, never an afterthought)

### Security as a primitive
- **RLS fail-closed on every row, from row zero** — `practice_id` + Row-Level
  Security across SQL, vector, and agent paths. The hardened recipe is
  non-negotiable baseline (this is exactly the cross-tenant-leak class that ends a
  healthcare company):
  - Two DB roles: `bonfire_migrator` (owns DDL) and `bonfire_app`
    (`LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`). The app connects ONLY as
    `bonfire_app`; tables are owned by `bonfire_migrator`.
  - Every tenant-scoped table: `ENABLE` + **`FORCE` ROW LEVEL SECURITY** at
    creation, with `USING` + `WITH CHECK` policies pinned to the tenant GUC and
    scoped `TO bonfire_app`. Composite index **leading with `practice_id`** on
    every table (and as the leading column of the pgvector filter path).
  - **CI catalog guard**: a migration/CI check over `pg_class.relrowsecurity AND
    relforcerowsecurity` fails the build if any table with a `practice_id` column
    lacks both — "RLS from row zero" enforced mechanically, not by reviewer
    vigilance. Plus a policy linter that requires `USING`+`WITH CHECK` and a
    tenant index on every policy.
  - Tenant context is set **only** by trusted server code via `set_config('app.current_practice_id', $1, true)` (transaction-local) inside
    a per-request wrapping transaction — pgbouncer-transaction-mode-safe. The
    agent NEVER holds a DB connection that can set context; it goes through the
    typed SDK/MCP which sets context server-side from a verified identity.
  - **One `db.withTenant()` wrapper is the ONLY DB entry point.** An `ast-grep`/
    semgrep rule bans bare `SET` for `app.*` keys; a CI integration test runs
    request B on request A's physical pooled connection and asserts zero leakage;
    a test asserts the agent role cannot `SET ROLE` to a BYPASSRLS/projection role.
- **ABAC policy receipt on every read** — scope-before-retrieve; deny is default;
  the predicate is compiled into the SQL/RLS `WHERE` (EXPLAIN-verified), never
  post-filtered; every allow/deny carries a structured receipt. Decision engine is
  a pure, typed, default-deny TS function that compiles to a SQL predicate (we
  steal Cedar's *semantics* — default-deny, forbid-wins, no rule ordering — without
  adopting Cedar/OPA as a runtime PDP in v0; an external per-row PDP breaks
  scope-before-retrieve and the <5ms target).
- **Purpose-of-use is a typed input to the ABAC decision** — `TREAT / HPAYMT /
  HOPERAT / HRESCH / ETREAT` bound onto the request scope and the policy receipt
  (Google's actor/purpose/environment model). Consent gates **reads**; governance
  gates **writes** (documented, with a negative test that an agent cannot
  exfiltrate via write-then-read).
- **Tamper-evident audit** — append-only, `prev_hash` + `row_hash` hash chain over
  the canonicalized JSONB; tamper is detectable; audit survives to the citation
  (CCP spans carry the audit row hash + FHIRPath, so "what did the agent see" is
  reproducible per turn).
- **Propose-only governance** — the agent proposes; it cannot approve or commit;
  approval is a human action and is audited.
- **HIPAA 45 CFR 164.312 mapping in code** — RLS→access control, hash-chained
  log→audit+integrity, identity→authn, TLS→transmission; Jan-2025 NPRM floor
  (AES-256, TLS 1.3, MFA-ready, immutable audit). Not "compliant out of the box";
  it removes the grunt work.
- **Synthetic-only in v0** — no real PHI in the repo; nothing PHI-bearing through a
  cloud sandbox; semantic synthetic-only scanner as a tripwire.

### Performance as a primitive
- **Read off indexed typed projections (`vd_*`), never JSONB scans** — the
  Medplum/HAPI model (extract search-param columns at write; never rely on raw GIN
  containment). Public read-model names are concrete: `notesByPatient`, `timeline`,
  `latestScores` are `vd_*` projections. Target <5ms typed reads.
- **One write path, fresh-on-commit** — typed primitive → canonical FHIR R4 (JSONB)
  → history → write_inputs → **synchronous, deterministic, light typed-projection
  upsert + search-param extraction, all in one atomic transaction.** This is the
  Medplum model: true read-your-writes with zero infrastructure beyond Postgres,
  and it preserves "one write path, never a dual write." The projection is pure and
  rebuildable (keyed on `practice_id, resource_type, resource_id, version_id`).
- **Async outbox ONLY for genuinely heavy/eventual work** — embeddings + HNSW
  reindex run off a durable `resource_outbox` (`FOR UPDATE SKIP LOCKED`,
  at-least-once + idempotent consumer). This is the single eventually-consistent
  piece and is labeled as such. Not pg_ivm, not Materialize/RisingWave (two-database
  problem + non-Apache license), not LISTEN/NOTIFY-as-durability (LISTEN/NOTIFY is
  an acceptable low-latency wakeup nudge for the outbox relay only — the table stays
  the durable source of truth).
- **Freshness object on every write** — every write returns
  `{resource_type, resource_id, version_id, committed_at}` (a ZedToken analog on the
  monotonic `version_id` = FHIR `meta.versionId`/ETag). For the synchronous typed
  projection, freshness == canonical version by construction (no lag). The freshness
  object's real job is to surface **async-embedding staleness** (embedding row's
  `version_id` vs current canonical) so a reader can choose stale-but-fast vs wait;
  a retrieval never silently returns a slice grounded to a superseded version.
- **Token-lean CCP** — ~10–100x fewer tokens vs raw FHIR, dominated by the "return
  only the slice" architecture lever (serialization is a ~1.4–2.5x residual;
  caching cuts cost not token count and is reported separately).

### AI-nativeness as a primitive
- **Cited Context Projection (CCP / "evidence packet")** — the agent's default read
  surface; raw FHIR is an explicit, rarely-needed escape hatch. Design rules from
  the June-2026 frontier:
  - **Serialize as Markdown, not JSON** (JSON triggers malformed tool calls on
    smaller/self-hostable models; reserve JSON for tool args).
  - **Pre-flatten FHIR's graph in the DB layer** (resolve `medicationReference` →
    display+code, encounter → type, code+display together) so the agent never
    traverses references — this attacks the #1 measured failure mode.
  - Each fact line carries a stable citation token
    `{resourceType/id @ FHIRPath @ provenance(author,timestamp,audit_hash)}`,
    resolving to an immutable, RLS-scoped, tamper-evident row (the MedBeads Merkle
    thesis, obtained for free from the hash-chained audit + Postgres — NOT
    IPFS/blockchain).
  - **U-shape ordering**: highest-precision facts at head AND tail; the question
    restated at the very end; bulk/low-relevance buried in the middle or omitted
    (lost-in-the-middle is a real >30% accuracy drop).
  - **Budget tokens explicitly, project per-question (just-in-time)**; prefer
    precision over recall; emit query-relevant summaries with "expand" identifiers
    and a `N more not shown` marker rather than full resources.
  - **Grounding gate (hard, fail-closed)**: refuse-or-flag any answer whose spans
    don't resolve to cited CCP facts, with a post-gen span/NLI check (a real
    deployment got ZERO hallucinations this way). The extractive `ccp/safety.ts`
    validator prevents the unit/negation/temporality flip (the actual
    patient-safety bug).
  - **Built CCP fragments are content-hash cached; the semantic cache ships OFF by
    default** (a hot cross-patient/stale-PHI leak vector if on).
- **Typed MCP tools** — narrow typed allowlist; no raw SQL / FHIRPath / shell /
  filesystem; prompt-injection sanitization; propose-only. Plus deterministic
  "skill" tools the agent calls instead of reading: a FHIRPath/SQL execution tool
  for counting/filtering/temporal logic, a calculator, and a typed "finish" tool
  that enforces output cardinality (these — not a bigger model — are what moved
  EHR-agent benchmarks 70→98%).
- **Auto-generated typed TS SDK** (type-schema IR) + reactive `useClinicalQuery`
  (LISTEN/NOTIFY wakeup over the typed projections; durable state stays in Postgres).
- **BTAB as the proof** — the benchmark is the marketing artifact; honesty is the
  moat (see module 9).

## Source of truth (locked)

**FHIR R4 / US Core JSONB is the canonical source of truth; the typed primitive is
the write API and the `vd_*` tables are projections generated on top** (Medplum/
Aidbox camp, not Canvas). Reasons: lossless round-trip is the non-negotiable and
JSONB-canonical is the only design that trivially round-trips R4 (extensions are
~35% of real fields; a fixed typed schema silently drops uncovered
extensions/choice-`[x]`/contained resources); one uniform RLS shape (every resource
table carries `practice_id` + one policy template) keeps the fail-closed surface
small; the hash chain hashes the *authoritative bytes*. Keep `write_inputs` so FHIR
can be re-derived when the mapping improves. We declare it **"FHIR-canonical"** (not
"Aidbox-isomorphic") to keep the round-trip guarantee auditable.

> Site correction: bonfiredb.dev currently says "Postgres is the source of truth,
> FHIR generated underneath." That framing is riskier (lossy + multiplies the RLS
> surface). The accurate line is "it all lives in your Postgres; **FHIR R4 is the
> canonical shape**, typed read models are generated on top." Update the site to
> match; do not flip the plan.

## Architecture in one picture

```
            WRITE (one atomic tx)                         READ (agent / app / SDK)
  typed primitive --map--> FHIR R4 -----+              +--> typed projections (vd_*)  <5ms
   + terminology validate-on-write      |              |    (notesByPatient, timeline, latestScores)
                                        |              |
   INSERT fhir_resources (JSONB canon) -+--> COMMIT ---+--> Cited Context Projection (markdown, span-cited)
   INSERT history + write_inputs        |              |       + grounding gate (fail-closed)
   UPSERT typed projection (same tx)    |              +--> cited search: hybrid BM25 + pgvector (RRF)
   extract search-param columns         |              |       reranker = pluggable, OFF by default
   INSERT outbox --(async)--> embeddings, reindex      |
                                                       +--> 1-call FHIR export / FHIR import
   write returns: freshness object {version_id, ...}   +--> typed MCP tools (propose-only, governed)

  every row: practice_id + RLS fail-closed (FORCE)  |  every read: ABAC receipt + purpose-of-use + hash-chained audit
  identity: BYO OIDC/JWT --> (iss,sub)->membership --> tenant/role GUC  (the line that makes RLS real)
```

## Core build modules

1. **Typed write primitives → lossless FHIR R4 / US Core 6.1.0** for the ~8 scribe
   resources; `write_inputs` replay; golden round-trip fixtures validated against
   the HL7 validator; **loss-ledger** (a field may be dropped only via an ADR +
   human sign-off). Includes **terminology validate-on-write** (see module 11) and
   storing the **FHIR Consent resource losslessly** (the directive→SQL compiler is
   deferred; storage is free via the canonical path).
2. **SQL-on-FHIR v2 ViewDefinition runner** — BUILD it, ADOPT the standard. No
   existing engine does synchronous, per-resource, incremental projection into typed
   Postgres `vd_*` inside the write tx with a co-located pgvector column (Aidbox
   `$materialize` is on-demand/manual; Medplum `evalSqlOnFhir` is in-memory;
   Pathling/Google/HealthLake are batch/lake). `@bonfire/projection` = a small
   embeddable compiler emitting Postgres SQL; **reuse `fhirpath.js`** (v4.11+, MIT)
   for FHIRPath via `userInvocationTable` (register
   `getResourceKey`/`getReferenceKey`/`ofType`) with a compile-time allowlist that
   fails fast on unsupported functions. **`sof-js` is the CI differential oracle**
   (diff every projection against it on vendored fixtures). v0 conformance baseline
   = the shareable+structural subset (basic, where, foreach, union, constant(_types),
   fn_reference_keys, fn_oftype, fn_first, view_resource, validate); publish an
   **honest N/144** and document known-skipped exotic cases — full-green is a
   fast-follow, not a v0 gate. `fn_reference_keys`+`getResourceKey` are
   non-negotiable (the join glue: `vd_observation.subject → vd_patient.id`).
   External claim phrasing: "passes the official SQL-on-FHIR v2 test suite" (true,
   checkable), NOT "HL7 standard-conformant" (it is an open-community IG, not a
   balloted STU).
3. **Cited search — HYBRID in v0** — BM25 (ParadeDB `pg_search`, vendored+pinned in
   Bonfire's own Postgres image; keep a `tsvector`+`pg_trgm` fallback) + pgvector
   0.8.2+ HNSW with `halfvec`, fused with **RRF (k=60) in SQL**. Adding the vector
   arm later is a migration, not a flag, so it ships now. The cross-encoder
   **reranker is a pluggable stage, OFF by default**, and when on uses a
   **self-hosted open-weight model only (BGE-reranker-v2-m3)** — external rerank/
   embedding APIs (Voyage/Cohere) send PHI off-box and are disallowed in the default
   config. Embedding provider is pluggable (default self-hostable BGE-m3; store
   model id + dim alongside each vector for re-embed migrations). Generation-
   augmented retrieval (HyDE/Query2Doc) is the documented highest-leverage upgrade.
   scope-before-retrieve; results carry citations, freshness, `excludedByPolicy`,
   policy receipt, and audit id. Require `pgvector >= 0.8.2` + iterative index scans
   so RLS-filtered ANN doesn't silently lose recall.
4. **Cited Context Projection** — markdown serialization + pre-flattened graph +
   span citations + U-shape ordering + grounding gate + token-measurement hooks.
5. **Typed TS SDK** (type-schema IR) + reactive `useClinicalQuery` + deterministic
   skill tools (FHIRPath/SQL exec, calculator, typed `finish`).
6. **Local MCP server** — typed tool allowlist, propose-only, injection-sanitized.
7. **Governance** — propose → approve → commit; agent cannot approve (audited);
   committed/signed-note schema.
8. **FHIR import path** — bring-your-own-bundle, so existing-FHIR teams get value.
9. **BTAB benchmark** — **Synthea-primary** (Apache-2.0, redistributable,
   version-pinned `bonfire-bench-v0` cohort committed to the repo). **Deterministic
   server-state grading** (Bonfire IS the DB: assert the post-task FHIR/DB state +
   audit delta; READ tasks use executable FHIRPath/SQL reference answers with
   normalized exact-match — not an LLM judge). Three separated axes: median
   tokens/query, task accuracy + citation precision/recall, cost — reported as an
   accuracy×cost Pareto; **accuracy-per-1K-tokens is a SECONDARY efficiency figure,
   never the ranking key**. A first-class **security/governance scored axis**
   (safe-refusal rate; **cross-tenant-leak rate must be 0**; "agent tried to commit"
   routes to propose-only). ≥3 runs at temp 0, report mean±variance, publish all
   traces. LLM-as-judge ONLY for irreducible free-text, gated hard (Cohen's κ vs
   human, AB/BA position-bias <0.10, cross-family judge, ≥500 hand-validated
   samples, false-negative skew reported) — "grade the graders" publicly. State the
   synthetic-data realism ceiling. Optional secondary **FHIR-AgentBench/MIMIC line
   for credentialed users only** (fork its loader, plug Bonfire in as the backend) —
   never the redistributable headline. Publish `RESULTS.md`.
10. **Reference app** — flagship OSS AI-scribe ("Scribe Fire Starter") built
    entirely on Bonfire (the onboarding funnel) + LLM-consumable docs +
    `npx bonfire init`.
11. **Terminology validate-on-write (minimal)** — pure-SQL set-membership against a
    version-pinned "terminology pack" baked into the image (Postgres rows). Ship
    only the **redistributable** vocabs (ICD-10-CM public domain, RxNorm core,
    LOINC with the Regenstrief NOTICE) + the small required enumerated value sets
    (FHIR vital-signs LOINC, UCUM, status enums). **Never bundle SNOMED concepts**
    (UMLS Affiliate license) — validate SNOMED *URI/SCTID format* only; gate real
    SNOMED concept validation behind an operator-supplied UMLS key that caches VSAC
    expansions into the same pack. Enforce-reject ONLY `required`-strength bindings
    on small enumerated sets; everything else (extensible/preferred, huge
    intensional sets) becomes an audited data-quality **warning**, not a block. Make
    the validator an interface (`BundledPackValidator` default + `RemoteTxValidator`
    seam, I/O byte-compatible with `$validate-code`) so operators can swap in a real
    tx server with no schema change. Code pickers serve from the same pack via
    trigram/ILIKE. validate-on-write is local SQL only — never a blocking remote
    call.
12. **BYO-auth verifier** — a thin, IdP-agnostic `verifyToken` (`jose`: cached
    kid-aware JWKS, positive `alg` allow-list, assert `iss`+`aud`+`exp`, return a
    typed `Result` that fails closed). Map **verified** claims to the RLS GUC via a
    server-side `(iss, sub) → membership` table (NEVER trust raw token claims for
    `practice_id`/role; an `ast-grep` rule bans `practice_id` from request input).
    Accept any OIDC IdP by config (issuer/JWKS/audience/claim-map) — ship **one
    adapter** in v0 + the verified-identity→RLS bridge; multi-IdP normalization is a
    thin fast-follow. Adopt SMART's claim vocabulary now (`fhirUser`,
    patient-vs-clinician compartments) so SMART is a later additive adapter. **Build
    the seam, not the server** — the SMART authorization server is deferred.

## Data model (key invariants)

- `fhir_resources` (canonical JSONB) + `history` (hashed over canonicalized JSON) +
  `write_inputs`. Promote `id/type/practice_id/lastUpdated/version_id` to columns.
- `vd_*` typed projection tables (rebuildable from canonical FHIR; carry
  `version_id` + `row_hash`) + extracted search-param columns (`spidx`).
- `audit` append-only with `prev_hash` + `row_hash` (tamper-evident).
- `resource_outbox` (durable, SKIP-LOCKED) feeds the single async layer.
- `practice_id` + RLS FORCE fail-closed on every PHI-bearing row (clinical, vector,
  audit, outbox). `(practice_id, lower(email))`-style tenant-scoped unique indexes
  (global UNIQUE leaks existence across tenants).
- Seed is idempotent and synthetic-only; records a completion marker.

## Stack (locked)

Bun (runtime + dev toolchain + the loop harness) · Fastify · Drizzle ORM over
**postgres.js** · Postgres 18 + pgvector 0.8.2+ (`halfvec`, iterative scans) +
ParadeDB `pg_search` (vendored) · Zod 4 · FHIR R4 / US Core 6.1.0 · `fhirpath.js` +
`sof-js` (oracle) · `jose` (auth).

> **Bun footgun mitigations (mandatory — chosen Bun over Node, so these are the
> guardrails):** (1) use **postgres.js, NOT `Bun.sql`**, for the pooled-RLS path —
> `Bun.sql` has open transaction-mode pooling bugs (idleTimeout kills in-flight
> tx; can't disable prepared statements for PgBouncer transaction mode) that are a
> direct cross-tenant risk. (2) **Manual OpenTelemetry spans** around the
> request/DB/audit path — Bun's auto-instrumentation is broken (oven-sh/bun#26536),
> and blind tracing is unacceptable for an audit/ABAC-differentiated backend. (3)
> PgBouncer in transaction mode with `prepare:false` (or PgBouncer 1.21+ prepared-
> statement support); wrap RLS predicates as `(SELECT current_setting(...))` so
> Postgres caches them as InitPlan (avoids the >3x per-row SubPlan penalty);
> `RESET`/`DISCARD ALL` on connection return. Revisit Node 24 if Bun.sql pooling +
> OTel land.

## Public surface

- Typed write primitives (the write API), CCP read, cited (hybrid) search, 1-call
  FHIR export, FHIR import. Typed TS SDK mirrors the HTTP surface. MCP exposes a
  narrow propose-only typed tool allowlist (no raw SQL/FHIRPath/shell/file, no
  approve/commit tool). BYO-OIDC identity feeds tenant/role context.

## Compliance & deployment (BAA by tier)

- **Self-host / BYOC (run-in-your-own-cloud)** — Apache-2.0, `docker compose up`,
  PHI never leaves the customer's infra. Bonfire is **structured NOT to be a
  Business Associate** here (pending counsel): no PHI access, no BAA needed.
- **Managed cloud (hosted by Bonfire)** — Bonfire handles PHI on the customer's
  behalf and therefore **IS a Business Associate; a BAA is signed** (backed by the
  cloud provider BAA). This tier is deferred (the managed control plane is
  post-v0), but the two-tier BA stance is stated now so the site and pricing are
  consistent.
- Cloud reference path is AWS-first (MinIO/S3 seam, SSE-KMS, customer CMK) but the
  default self-host path is cloud-agnostic.

## Scope

IN (~14-day MVP): the deterministic cited-search wow, lossless FHIR mapping for ~8
scribe resources (+ terminology validate-on-write + stored Consent), SQL-on-FHIR
runner, CCP with grounding gate, **hybrid cited search (reranker off)**, typed SDK +
MCP, propose-only governance, **purpose-of-use enum on the ABAC decision**,
**BYO-auth verifier (one IdP)**, FHIR import, the **freshness object**, the
**Synthea BTAB number (deterministic grading + security axis)**, the reference app,
the compliance pack.

DEFER (fast-follow, each with its own threat model — do NOT rush into v0):
- **File / Binary attachment storage (bytes)** — the S3/MinIO + two-phase ingest +
  presigned-URL + ABAC-on-securityContext + AV/quarantine + KMS subsystem. The
  scribe beachhead stores notes as inline-text DocumentReference, so binary bytes
  are not on the activation path. If cheap, define the storage *interface seam* now
  (single S3-compatible client + the `security_context` ABAC invariant) so the
  later bytes pipeline is additive — but ship no bytes in v0.
- **Consent directive → SQL-predicate compiler** (store the Consent resource now;
  compile/enforce the directive at query time later).
- **Break-glass / ETREAT elevation** (a fail-open-risk PHI surface; do not rush).
- **SMART App Launch / SMART authorization server** (OAuth2+PKCE, backend services,
  scope parsing, `.well-known/smart-configuration`).
- **Reranker-on**, hybrid clinical/MedCPT embeddings, agent memory, multi-agent CCP
  builders; remote hosted MCP; bulk `$export`; FHIR R6; full terminology server
  (`$expand`/`$translate`/`$subsumes`); offline sync; the managed control plane.

## Done when

- Clean clone boots with `docker compose up`, zero API keys.
- Five-beat wow works in the browser in under 5 minutes.
- BTAB number is published and reproducible on the pinned Synthea cohort
  (deterministic grading; cross-tenant-leak rate = 0; accuracy×cost Pareto +
  accuracy-per-1K secondary; named tokenizer stated).
- Reference AI-scribe app ("Scribe Fire Starter") runs entirely on Bonfire.
- RLS proofs (incl. the pgbouncer no-bleed test + CI catalog guard) + policy
  analysis + audit-chain verification + 164.312 map shipped.
- BYO-auth → RLS bridge proven (verified-claim→GUC; raw-claim rejected).
- At least one design-partner acceptance test is defined and passes.

## Loop slice order (the harness slice registry derives from this)

Numbering is stable for cross-references; execution order is the dependency DAG
(`dependsOn`), so BF-13 (auth) runs early despite its number. The harness registry
(`loop/src/contracts/tasks.ts`) must be updated to 13 slices + the expanded
acceptance below (a Phase-2 harness task).

```
BF-01  Workspace + Docker + Postgres18/pgvector boot + health; RLS scaffolding from row zero
       (+ two roles, FORCE RLS, CI catalog guard, db.withTenant() wrapper).
BF-02  fhir_resources (JSONB canon) + history + write_inputs + migrations + synthetic-only scanner
       + RLS fail-closed (+ version_id + freshness object on writes).
BF-13  BYO-auth verifier: OIDC/JWT verify (jose, alg allow-list, iss/aud) -> (iss,sub)->membership
       -> tenant/role GUC. One adapter; SMART claim vocabulary only. [dependsOn BF-01]  <-- runs early
BF-03  Typed write primitive -> lossless FHIR R4 (US Core, ~8 resources) + loss-ledger
       + golden round-trip vs HL7 validator (+ terminology validate-on-write, + stored Consent resource).
BF-04  SQL-on-FHIR v2 ViewDefinition runner -> vd_* + spidx (fhirpath.js; sof-js differential oracle;
       shareable+structural subset; honest N/144). [synchronous projection on the BF-02 write path]
BF-05  ABAC policy receipt + hash-chained tamper-evident audit + tamper detection
       (+ purpose-of-use enum on the decision + receipt; consent gates reads, governance gates writes).
BF-06  Cited search: HYBRID BM25(pg_search)+pgvector RRF; reranker pluggable OFF; scope-before-retrieve;
       citations/freshness/excludedByPolicy/receipt/audit-id. [dependsOn BF-04, BF-05, BF-13]
BF-07  Cited Context Projection (markdown, pre-flattened, span-cited, U-shape) + grounding gate
       + token measurement hooks. [dependsOn BF-04, BF-06]
BF-08  Auto-generated typed TS SDK + reactive useClinicalQuery + local MCP typed tools (propose-only)
       + deterministic skill tools (FHIRPath/SQL exec, calculator, finish).
BF-09  Propose -> approve -> commit governance (agent cannot approve; audited).
BF-10  1-call FHIR export + FHIR import path (bring-your-own-bundle) [wire consent on $export now].
BF-11  BTAB benchmark: Synthea-primary, deterministic server-state grading, security axis
       (cross-tenant-leak=0), accuracy×cost Pareto + accuracy-per-1K secondary; publish RESULTS.md.
BF-12  Reference AI-scribe app ("Scribe Fire Starter") + LLM-consumable docs + compliance evidence pack
       + launch assets.
```

## Dangerous failure modes (must be eval-gated by the harness)

- Retrieval returned before the ABAC/RLS/consent filter (scope-after-retrieve leak).
- Cross-`practice_id` / cross-tenant leak on any path (SQL, vector, agent) — incl.
  the **pooler context-bleed** footgun (bare `SET`, statement-mode pooling, a
  BYPASSRLS/projection role reachable from the request path).
- BYO-auth trusting client-supplied tenant/role, or `alg:none`/algorithm-confusion
  on token verification.
- Lossy FHIR mapping passing as "lossless" (round-trip drift without a loss-ledger
  entry); typed-projection treated as canonical.
- Fake "FHIR-valid" / "conformant" confidence (claim without the HL7 validator/suite
  or beyond the documented N/144 subset).
- Audit append-only bypass or hash-chain tamper going undetected.
- Agent able to approve/commit (propose-only invariant broken), or to trigger
  break-glass/ETREAT.
- CCP grounding bypass (an answer whose spans don't resolve to cited facts);
  semantic cache returning a stale or cross-patient slice.
- Embedding/rerank/terminology call sending PHI to an external API in the default
  config.

## Review provenance

v3 reflects a `/plan-eng-review` (2026-06-30) over the v2 plan + a June-2026 site
audit (38 pages) + a 12-decision research swarm with an adversarial over-ambition
review. Locked decisions:
- **v0 ambition = recommended cut** (D2): add hybrid search, minimal terminology,
  purpose-of-use enum + stored Consent, BYO-auth (one IdP), freshness object; defer
  file-storage bytes, consent→SQL compiler, break-glass, SMART server, reranker-on.
- **Runtime = Bun everywhere** (D3), with the mandatory Bun footgun mitigations
  above (postgres.js not Bun.sql; manual OTel). Overrides the research default of
  Node 24 for the server; revisit if Bun.sql pooling + OTel land.
- **Source of truth = FHIR-JSONB canonical** (D4); correct the site, don't flip.
- **Benchmark = Synthea-primary + deterministic grading** (D5); MIMIC optional
  secondary for credentialed users only.

Top residual risks the harness must hold the line on (adversarial): (1) scope
blowout vs the ~14-day MVP — keep deferrals deferred; (2) new PHI-egress surfaces —
file storage, break-glass, semantic-cache-on stay out of v0; (3) the pooler-mode
RLS context-bleed footgun across RLS + BYO-auth + the projection role — one
`db.withTenant()` entry point + the no-bleed CI test.
