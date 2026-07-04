# ADR: FHIR R4 types are compile-time; conformance is machine-validated

- Status: Accepted (BF-03)
- Sign-off: human-reviewed and approved

## Context

`@types/fhir` publishes R4 resources into the ambient UMD namespace `fhir4`,
which does NOT resolve as an importable module under NodeNext (`from "fhir/r4"`
is TS2307). We still want the compiler to check every canonical resource against
the real FHIR R4 shape.

## Decision

- A single barrel (`packages/core/src/fhir/types.ts`) pulls `@types/fhir` in via
  a triple-slash `/// <reference types="fhir" />` and re-exports the resource
  types (`FhirPatient`, …). The typed builders (`fhir/build.ts`) construct
  strongly-typed `fhir4.*` resources; nothing else writes canonical FHIR.
- **Type-level `fhir4.*` conformance is necessary but not sufficient.** The
  authoritative conformance check is the official HL7 FHIR validator (R4 + US
  Core 6.1.0) run by `bun run fhir:validate`. A resource is only ever called
  "FHIR-valid" when that validator exits zero — never from prose or from types
  alone. A planted-violation golden (`*-bad-*`) proves the validator rejects.

## Consequences

The `@types/fhir` dependency is a build-time devDependency of `packages/core`.
The IG closure the validator needs is a build-time tool cache (`~/.fhir`), never
vendored or committed.
