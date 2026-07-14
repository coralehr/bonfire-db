# ADR 0005 — Rebuildable FHIR reference context graph

Status: proposed · Date: 2026-07-13 · Evidence: QT-4 v3b + valid374 mechanism gate

Bonfire will be graph-native at the governed context layer while canonical FHIR
JSON and immutable history remain in Postgres. The graph is a typed,
tenant-scoped, rebuildable projection of explicit same-server FHIR references,
not a second source of truth and not a commitment to a native graph database.

## Decision

1. `fhir_resources` and `history` remain canonical. Every relative
   `Reference.reference` is deterministically extracted with its RFC 6901 JSON
   pointer into `fhir_reference_edges`. The projected create, projected update,
   and governed-commit compositions replace edges in the same tenant
   transaction as canonical, SQL-on-FHIR, and search state. Low-level canonical
   primitives remain internal infrastructure and do not establish this
   projection invariant by themselves.
2. The projection stores only explicit edges. Inferred/semantic relationships
   may be introduced later only under a distinct edge kind and evidence policy;
   they must never be silently presented as source-record references.
3. The internal walker is profile-based and bounded by depth, target count,
   storage-read edge count, citation count, allowed resource types, and source
   version. Tenant isolation is enforced by forced RLS. Purpose and principal
   scope belong to the not-yet-executable compiler adapter and must be derived
   before the reader is called. Callers will receive deterministic path
   citations and freshness, never SQL or Cypher.
4. Version-pinned references resolve only to the exact history version. Because
   this first projection indexes outgoing edges from the latest row only, an
   exact historical target may be returned as terminal evidence but is never
   expanded as a traversal frontier.
5. Query-time extraction and the materialized projection must produce identical
   canonical edge bytes. A per-resource projection head binds source type,
   version, count, and digest, so an intentionally empty projection differs
   from an absent one and an unchanged-reference version bump cannot false-pass.
   `compareReferenceProjectionTx` provides the zero-model receipt used by
   rebuild and storage-engine comparisons.
6. A storage-neutral `evidence-compiler/v1` contract fixes the plan, principal,
   purpose, source snapshot, bounds, citations, and hashes. No executable public
   compiler ships in this slice: v0 ABAC omits several QT-4 resource types, and
   retrieval must not precede a separately reviewed policy expansion.

## Evidence boundary

QT-4 v3b measured answer correctness of 7/42 for A6a, 25/42 for vocabulary,
and 28/42 for vocabulary plus traversal. The registered vocabulary contrast was
+42.9 percentage points (95% paired interval +20.5 to +63.6; exact p=.000277).
Traversal added +7.1 points over vocabulary (interval 0 to +15.9; p=.25), which
is promising but unresolved.

The untouched valid374 zero-model gate later measured microbiology macro
evidence recall of 15.1% / 76.8% / 92.5% across the same three packet arms;
traversal gained 36 gold resource ids and lost none. These are mechanism metrics,
not answer correctness. The sealed 1,122-answer holdout must complete before
traversal is promoted.

Nothing in either result compares Postgres with Neo4j, Neptune, RDF, or another
physical engine. A native engine is considered only if a byte- and
authorization-equivalent implementation materially improves the registered
latency/cost target on production-scale charts.

## Security and failure semantics

- The edge primary key and source foreign key lead with `practice_id`, avoiding
  the cross-tenant uniqueness/FK existence oracle closed by BP-019.
- Targets have no foreign key. A dangling reference is recorded, not rejected;
  missing, deleted, stale-version, and out-of-scope targets are unavailable
  without disclosing which condition applied.
- The app role has select/insert/delete but no update; replacement is atomic.
- Every returned target must have a retained `fetched` path citation. Citation
  exhaustion omits the target rather than returning uncited evidence.
- Current and exact historical target requests use distinct identities;
  duplicate missing paths remain missing, and stale outgoing edge versions are
  rejected before expansion.
- Edge-row reads are deterministically limited in SQL, not only sliced after an
  unbounded fetch.
- RLS is enabled and forced. No or malformed tenant GUC returns zero rows.
- Projection errors after the canonical insert throw, causing the entire tenant
  transaction—including governance, typed views, search, and edges—to roll back.

## Promotion gates

Before an executable `compileEvidence` endpoint is exposed:

1. expand and adversarially review ABAC for the required FHIR resource types,
   patient/consent scope, purpose, and break-glass behavior;
2. prove scope-before-retrieve and receipt cross-checks on every path;
3. pass cross-practice, deleted, stale-version, bound-exhaustion, and path replay
   tests with no distinguishable resource-existence leakage;
4. complete the valid374 answer holdout and A11 path-required efficacy run; and
5. meet the existing p95 latency target with packet and model economics reported
   separately.

Until those gates pass, the SQL reader and executable walker are deliberately
not exported from `@bonfire/core`; only the storage-neutral contract and bounded
types/constants are public.
