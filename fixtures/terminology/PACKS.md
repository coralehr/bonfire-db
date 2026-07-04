# Terminology packs (operator-curated reference data)

Local, license-clean vocabulary subsets for the BF-03 validate-on-write path
(`packages/core/src/terminology`). Loaded into the `terminology_concept` /
`terminology_pack` tables by `bun run fhir:load-terminology`. This is a
representative SAMPLE, not a complete distribution — enough to exercise the
extensible-binding WARN path and record pack provenance, the same way BF-02
shipped a hand-authored synthetic corpus rather than a full Synthea cohort.

## Bundled now

| Pack | System | Version | License | File |
|---|---|---|---|---|
| ICD-10-CM | `http://hl7.org/fhir/sid/icd-10-cm` | 2026 (FY2026) | Public domain (CMS/NCHS) | `icd10cm-sample.csv` |

ICD-10-CM is a US federal public-domain code set (CMS/NCHS); the codes and their
official descriptions may be freely redistributed. Only raw CMS/NCHS
descriptions are used — never a copyrighted third-party annotated edition.

## Deliberately NOT bundled (documented follow-up)

- **LOINC** — redistribution is permitted WITH the Regenstrief license + NOTICE,
  but *downloading* it requires accepting the Regenstrief License Agreement
  (account + acceptance form), which cannot be done autonomously. LOINC is a
  WARN-path (extensible) pack and a swappable validator input, so its absence
  weakens no fail-closed invariant. Adding LOINC 2.82 `LoincTableCore` + the
  verbatim `LOINC-NOTICE.txt` is a follow-up once the license is accepted.
- **RxNorm** — only the license-free Prescribable Content (`SAB=RXNORM`) is
  redistributable; a subset is a clean follow-up alongside LOINC.
- **SNOMED CT** — no concept content is ever bundled (IHTSDO affiliate
  licensing); SNOMED codes are validated for SCTID/URI FORMAT only
  (Verhoeff + partition + `http://snomed.info/sct`), never membership.

See `docs/adr/` (loinc-deferral) for the sign-off.
