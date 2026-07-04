# ADR: The write primitive's typed error contract

- Status: Accepted (BF-03)
- Sign-off: human-reviewed and approved

## Context

Expected, recoverable failures must be VALUES callers branch on, not thrown
strings (CQ2). Genuine faults must still roll the atomic transaction back.

## Decision

`writeScribeResource` returns `Result<WriteResult, WriteError>` where
`WriteError.code` is a stable enum:

- `INVALID_SCRIBE_INPUT` — the untrusted input failed the Zod scribe schema.
  This is the fail-closed rejection for `required`-strength coded fields: an
  off-value `gender` / `clinicalStatus` / `status` never reaches the mapper.
- `INVALID_FHIR_INPUT` / `RESOURCE_NOT_FOUND` / `VERSION_CONFLICT` — propagated
  unchanged from the fhir-store layer (BF-02).

A genuine database fault (constraint abort, connection loss) is THROWN from the
store so the enclosing `withTenant` transaction rolls back the whole write — no
partial write, no dual write. It never surfaces here as an allow.

Terminology validate-on-write NEVER produces a write error: `required` codes are
already rejected by the schema, and extensible/SNOMED misses are audited
WARNINGS on `WriteResult.terminology`, not blocks.

## Consequences

Callers switch on `code` (never message strings). Messages are secret-free and
carry only a field path, never a field value.
