# ADR 0004 — BF-07: Cited Context Projection (CCP)

Status: accepted · Date: 2026-07-10 · Slice: BF-07

The CCP is the agent's default read surface: it serializes a policy-scoped
BF-06 search result set into a compact, span-cited text document where every
span carries (resourceId, jsonPath, auditHash), ordered U-shape, measured by
an offline tokenizer. Raw FHIR stays an explicit, rarely-needed escape hatch
(the document's last line names it). This ADR records the load-bearing
decisions and their honest limits.

## Decisions

1. **Spans come ONLY from a declared, per-type scalar leaf-path table.** No
   blind recursive walk: `LEAF_PATHS` names every projectable field, so ids,
   `system` URIs, and internal `reference` values can never enter a span. The
   structural belt: a declared path resolving to an object or array THROWS at
   build time (programmer error in the table, not a caller error). `.0` index
   pinning (first name, first coding) is the documented v0 scope. `note.text`
   free text IS emitted — it is declared clinical content, same-tenant and
   audited, not blind-walk leakage.

2. **Every span value is JSON-encoded in the text (value-injection guard).**
   The CCP feeds an LLM downstream, so a hostile clinical string embedding
   `"\n[9] Patient/<id>\n  ssn: ..."` must not forge a group or span line.
   One line per span (`  <path>: <json>`), group headers `[`-prefixed: the
   document is losslessly invertible and the digest is verifiable from the
   emitted artifact. Paths come from the trusted table; only the value is
   attacker-influenced, and encoding neutralizes it.

3. **One canonical read, RLS-bounded; everything else fails closed.** ccp/**
   issues exactly ONE `fhir_resources` query — an id-set read under FORCE RLS
   (never a `practice_id` predicate). A hit id that does not resolve (foreign
   or stale) denies with a COUNT only — a returned id would be a cross-tenant
   existence oracle — and no partial document is emitted (fail-closed trades
   availability for integrity on a concurrent delete). A resolved row whose
   `type` differs from its hit's claimed `resourceType` denies
   (`TYPE_MISMATCH`): a relabeled hit would project through the wrong leaf
   table and mis-attribute spans.

4. **The ABAC scope is re-derived inside `buildCcp`.** RLS is tenant-scoped,
   not policy-scoped: a same-tenant, policy-denied id injected into
   `results[]` would resolve under RLS. `deriveScope` (a pure policy function
   — no retrieval, so not scope-after-retrieve) re-partitions the types for
   the BUILDING subject and purpose; any resolved row outside `allowed`
   denies (`SCOPE_EXCLUDED_TYPE`, count only). This is the guard that makes
   the CCP self-defending against a fully-consistent forged in-process
   response, and it closes the latent fail-open before BF-08 makes the
   response client-influenceable.

5. **The response receipt is cross-checked against this build.** The
   receipt's `practiceId` must equal the tenant GUC, its `purposeOfUse` the
   request purpose, its `actorId` the requesting subject, and its decision an
   explicit `allow` — else `RECEIPT_MISMATCH`. Without this, a caller could
   retrieve under HRESCH and project-and-audit as TREAT (purpose laundering),
   or replay practice B's response under practice A. Mirrors
   `appendAuditRowTx`'s own mis-attribution guard.

6. **Audit binding: one hash-chained row per build, digest in the preimage.**
   Every post-parse path (ok, empty, and every deny) appends EXACTLY ONE
   `CcpProjection` audit row inside the same tenant transaction; every span's
   `auditHash` and the document's `auditEventId` are that row's `row_hash`.
   The row's `reason` carries `spans=<n> src=<sourceAuditEventId>
   contentDigest=<sha256>` where the digest covers the RFC 8785 canonical
   JSON of `{ spans (emitted order, no auditHash), text, sourceAuditEventId }`
   — value tamper, prose tamper, reorder, replay (versionId per span), and
   provenance (the link back to the scoped search) all move the digest, and
   `reason` sits inside the row-hash preimage, so tampering either side is
   detectable. The spans' own `auditHash` is excluded from the digest and the
   text header carries the SOURCE search's audit id: the CCP's row hash
   cannot appear inside material the row itself hashes (chicken-and-egg).
   MALFORMED_INPUT alone does not audit: nothing was read and a pre-parse
   input has no attributable purpose (the `searchClinical` precedent).

7. **U-shape ordering is a pure function of the response rank order.** Odd
   ranks fill from the front, even ranks from the back: rank 1 first, rank 2
   last, rank 3 second, rank 4 second-to-last — highest salience at both
   context-window edges. Determinism (byte-identical text per response)
   inherits BF-06's total order (resource_id tiebreak).

8. **Token measurement is pluggable, named, and offline.** `measureCcp`
   compares the CCP text against compact JSON of the IDENTICAL span set under
   a named `TokenCounter` (default: gpt-tokenizer's bundled o200k_base ranks —
   zero keys, zero egress; the BP-035 semgrep floor covers ccp/**). Honest
   scope: this is the serialization-residual lever only — the 10-100x
   reduction from returning only the scoped slice is BF-06's claim and is not
   re-claimed. Measured on the golden set: ~3.7x against the contract
   baseline (span JSON including per-span auditHash); ~2.5x with the audit
   hash hoisted on BOTH sides (the hash-neutral floor, disclosed so the
   metric cannot be called gamed). The asserted floor is 1.4x.

## Accepted limits

- **JCS decimal normalization reaches cited values.** Both write path and
  readback pass values through the same JS JSON parse, so `1.40` stores and
  cites as `1.4`; citation equality compares `canonicalizeJson` on both sides
  (never `#>>` text) and stays exact. Wire-byte fidelity is BF-03's ledger.
- **Freshness is build-time.** Spans stamp the canonical row's
  (`last_updated`, `version_id`) from the same read the values come from, so
  citation precision is exact by construction; a hit ranked on
  projection-as-of text may cite newer canonical content.
- **v0 policy is all-or-nothing per subject**, so `SCOPE_EXCLUDED_TYPE` is
  exercised via a role swap today; per-type partial scopes arrive with the
  forbid rules.
