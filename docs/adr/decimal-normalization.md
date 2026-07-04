# ADR: FHIR decimal scale is normalized to JCS number form

- Status: Accepted (BF-03)
- Sign-off: human-reviewed and approved (loss-ledger entry Observation `/valueQuantity/value`)

## Context

FHIR `decimal` is significant-digit aware: `2.0` and `2` are distinct on the
wire (trailing zeros convey measurement precision). The canonical hashed form of
a resource is RFC 8785 (JCS), whose number serialization follows ECMAScript
`Number.prototype.toString`, which drops trailing-zero scale (`2.0` → `2`). BF-02
already accepted this for hashing and left wire-byte decimal preservation to
BF-03.

A fully lossless fix is a **branded decimal string** carried through
canonicalization — but that requires editing `packages/core/src/db/canonical-json.ts`,
which is outside BF-03's allowed paths. Rather than silently normalize, this
slice makes the loss **explicit and gated**.

## Decision

Persist canonical FHIR through JCS number normalization. The single
`Observation` `/valueQuantity/value` loss-ledger entry records the transform;
the golden `fixtures/golden/observation-decimal.json` (a literal `2.0`) makes
it observable, and `bun run fhir:roundtrip` fails if that decimal-scale diff is
ever unledgered — or if this ADR is deleted.

## Consequences

- Numeric value is always preserved exactly; only insignificant trailing scale
  is dropped. No clinical value changes.
- If precision-exact decimals become required, a follow-up slice adds branded
  decimal handling in `canonical-json.ts` and removes this ledger entry.
