/**
 * Scanner surface: explicit roots, extensions, and allowlists — NEVER derived
 * from .gitignore (an ignored file with real identifiers must still be found
 * when pointed at explicitly).
 */

/** Repo-relative directories scanned by default. */
export const SCAN_ROOTS: readonly string[] = ["fixtures/synthetic"];

/** Files inside the roots are scanned only with these extensions. */
export const SCAN_EXTENSIONS: readonly string[] = [".ndjson", ".json"];

/** Repo-relative files excluded from root scans (metadata, not clinical payload). */
export const EXCLUDED_FILES: readonly string[] = ["fixtures/synthetic/corpus.manifest.json"];

/** The EICAR-style planted fixture every run must fire on (self-test). */
export const PLANTED_FIXTURE = "scripts/synthetic-scan/fixtures/planted.json";

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
