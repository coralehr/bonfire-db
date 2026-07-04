# ADR: SQL-on-FHIR v2 conformance suite + fhirpath.js pins (BF-04)

**Status:** accepted (operator prep, BF-04) · **Date:** 2026-07-04

## Decision

1. **Conformance suite = `FHIR/sql-on-fhir.js` @ commit `59953a4ff8d0bcceac368232ac8ae7454c53d5c8`**,
   vendored VERBATIM under `fixtures/sql-on-fhir/` (22 `tests/*.json`, 144 cases:
   133 `shareable` + 11 `experimental`), together with `tests.schema.json`,
   `test-report.schema.json`, and the upstream MIT license.
   - The tests live in `FHIR/sql-on-fhir.js`, NOT in the IG repo
     (`FHIR/sql-on-fhir-v2`) — the cases moved out of the IG. The repo has no
     git tags or releases, so the commit SHA is the only possible pin.
   - `fixtures/sql-on-fhir/MANIFEST.json` records the source repo + commit,
     per-file sha256 over the vendored bytes, per-file case counts, and the
     declared-unsupported allowlist. The conformance runner MUST re-hash the
     vendored bytes against the MANIFEST and independently re-count cases from
     JSON before reporting — a tampered fixture or a stubbed runner is a red
     run, not a quiet pass (danger class: fake-conformance).

2. **`fhirpath@4.10.1` EXACT (no caret).** The suite semantics were proven on
   host against 4.10.1. 4.11.0 tightened date-literal validation and can flip
   the verdict of a shareable case — an unpinned minor bump could silently turn
   a passing suite into a lying one (fake-conformance via dependency drift).
   Bumping the pin requires re-running the full suite and updating this ADR.

3. **Declared-unsupported allowlist = exactly the 11 upstream-`experimental`
   cases** (`fn_boundary` ×8, `fn_join` ×3), keyed by `(file, title)` in the
   MANIFEST with a written reason each. Target: 133/133 shareable passing,
   0 silent skips. A case may only be skipped if its `(file, title)` key is in
   the allowlist; anything else failing or missing exits non-zero.

## Regeneration

```sh
git clone https://github.com/FHIR/sql-on-fhir.js && cd sql-on-fhir.js
git checkout 59953a4ff8d0bcceac368232ac8ae7454c53d5c8
# compare tests/*.json byte-for-byte against fixtures/sql-on-fhir/tests/
```

## Consequences

- "Passes the HL7 SQL-on-FHIR v2 conformance suite" is a machine-checked,
  pinned claim: exact bytes, exact case count, exact library version.
- Upstream suite updates arrive only via a deliberate re-pin commit that
  updates the SHA, the MANIFEST hashes, and this ADR in one reviewed change.
