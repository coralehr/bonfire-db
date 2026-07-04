# ADR: Terminology scope — bundle only redistributable vocabularies; defer LOINC/RxNorm enrichment

- Status: Accepted (BF-03)
- Sign-off: human-reviewed and approved

## Context

Validate-on-write checks coded fields against version-pinned terminology packs.
Different vocabularies carry different redistribution terms:

- **ICD-10-CM** — US federal public domain (CMS/NCHS); freely redistributable. A
  representative FY2026 sample is bundled (`fixtures/terminology/icd10cm-sample.csv`).
- **LOINC** — redistribution is permitted WITH the Regenstrief license + NOTICE,
  but *downloading* it requires accepting the Regenstrief License Agreement
  (account + acceptance form), which cannot be completed autonomously.
- **RxNorm** — only the license-free Prescribable Content (`SAB=RXNORM`) is
  redistributable; a curated subset is a clean follow-up.
- **SNOMED CT** — no concept content may be bundled (IHTSDO affiliate licensing).

## Decision

- Bundle only license-clean content now (ICD-10-CM sample). Record provenance +
  version + `sha256` in `terminology_pack`.
- `required`-strength small HL7 enums are fail-closed at the scribe boundary
  (`z.enum`) and re-checked by the HL7 validator — no downloads needed.
- Extensible/large bindings (ICD-10-CM, LOINC, RxNorm) are validated by **local
  SQL set-membership**; a miss (including a system with no loaded pack) is an
  **audited WARNING with the pack version**, never a block.
- **SNOMED CT is validated for SCTID/URI FORMAT only** (Verhoeff check digit +
  partition + `http://snomed.info/sct`); no membership, no content shipped.
- The validator is an interface (`BundledPackValidator` default +
  `RemoteTxValidator` seam, I/O byte-compatible with `$validate-code`), so a real
  terminology server swaps in with no schema change. Validate-on-write makes
  **zero network calls** (the remote seam throws until wired).

## Consequences

Because LOINC/RxNorm are WARN-path and the pack is a swappable validator input,
their absence weakens **no fail-closed invariant**. Adding LOINC 2.x
`LoincTableCore` + the verbatim Regenstrief NOTICE, and an RxNorm Prescribable
subset, is a data-enrichment follow-up once the licenses are accepted — the same
pattern as shipping a synthetic corpus and deferring the full cohort.
