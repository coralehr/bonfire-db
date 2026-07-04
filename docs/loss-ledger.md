# Loss ledger

FHIR R4 is the source of truth. The typed write primitive is **lossless by
default**: a synthetic typed input round-trips (typed → canonical FHIR → typed)
with zero unaccounted-for field loss, machine-checked by `bun run fhir:roundtrip`.

A field may differ across a round-trip **only** via an entry below, and **every
entry must reference an ADR under `docs/adr/` recording explicit human sign-off**.
The round-trip gate parses the JSON block below and fails if any diff is not
matched by an entry, or if an entry references an ADR that does not exist
(ratchet BP-008 — lossless-or-ledgered).

Each entry is keyed by `resourceType` + JSON `pointer`.

```json
[
  {
    "resourceType": "Observation",
    "pointer": "/valueQuantity/value",
    "reason": "FHIR decimal trailing-zero scale (e.g. 2.0) is normalized to RFC 8785 (JCS) number form (2) by canonical serialization. The numeric value is preserved exactly; only insignificant trailing precision is dropped. Branded-string decimal preservation is deferred (needs db/canonical-json.ts, outside this slice's scope).",
    "adr": "docs/adr/decimal-normalization.md"
  }
]
```
