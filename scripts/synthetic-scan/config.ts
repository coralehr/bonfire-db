/**
 * Scanner scope — DENY-BY-DEFAULT (BP-022). The scanner sweeps every tracked
 * text file (`git ls-files`, binary skipped by null-byte sniff) so a new fixture
 * dir, a .csv, or a PHI literal in seed/tests/docs is covered automatically. The
 * only carve-outs are two REVIEWED lists, each entry carrying a reason:
 *   - EXCLUDED_PATHS: not scanned at all (the planted self-test bait).
 *   - FIELD_AWARE_EXEMPT: text-mode SSN only, no FHIR field-aware pass (vendored/
 *     canonical HL7 corpora whose example names don't follow our digit-marker
 *     convention; verified to contain no SSN/NPI/phone).
 * Scope is NEVER derived from .gitignore (an ignored file with real identifiers
 * must still be found when pointed at explicitly).
 */

/** A scope carve-out: a repo-relative dir or file prefix plus why it is exempt. */
export interface ScopeEntry {
  readonly path: string;
  readonly reason: string;
}

/** Paths swept by NOTHING. The planted corpus is intentional PHI-shaped bait — the
 *  self-test scans it directly, so the tree sweep must skip it. */
export const EXCLUDED_PATHS: readonly ScopeEntry[] = [
  {
    path: "scripts/synthetic-scan/fixtures",
    reason:
      "planted PHI-shaped self-test corpus; scanned directly by the self-test, never the tree sweep"
  }
];

/** Paths scanned in TEXT-MODE only (no FHIR field-aware detectors) because their
 *  example names/MRNs are HL7's own conventions, not our digit-marker corpus.
 *  Measured to carry no SSN/NPI/phone, so text-mode still guards the real leaks. */
export const FIELD_AWARE_EXEMPT: readonly ScopeEntry[] = [
  {
    path: "fixtures/sql-on-fhir",
    reason:
      "vendored HL7 SQL-on-FHIR conformance suite (HL7 example patients, not our synthetic corpus)"
  },
  {
    path: "fixtures/golden",
    reason:
      "HL7-validator-approved canonical golden FHIR (canonical example names, not our digit-marker convention)"
  }
];

/** The planted-bait directory (json + txt): every signal class must fire here. */
export const PLANTED_FIXTURE_DIR = "scripts/synthetic-scan/fixtures";

/** Reviewed false-positive baseline (content fingerprints, no inline pragmas). */
export const BASELINE_FILE = "scripts/synthetic-scan/baseline.json";

/**
 * HumanName family/given values WITHOUT the synthetic digit marker that are
 * still acceptable. Empty on purpose: the corpus convention is digit suffixes.
 */
export const SYNTHETIC_NAME_ALLOWLIST: readonly string[] = [];

/** Identifier.system values whose MRNs are known-synthetic. */
export const MRN_SYSTEM_ALLOWLIST: readonly string[] = ["https://synthetic.bonfire.example/mrn"];

/** Known-synthetic NPIs (empty: corpus NPIs are Luhn-invalid by construction). */
export const NPI_ALLOWLIST: readonly string[] = [];

/**
 * Weak-signal dictionary for compound scoring: unmarked common first names
 * only count as a finding when co-occurring with a plausible birthDate.
 */
export const COMMON_FIRST_NAMES: readonly string[] = [
  "margaret",
  "james",
  "mary",
  "john",
  "robert",
  "patricia",
  "michael",
  "linda",
  "william",
  "elizabeth",
  "david",
  "barbara",
  "richard",
  "susan",
  "joseph",
  "jessica",
  "thomas",
  "sarah",
  "charles",
  "karen"
];
