/**
 * Terminology validate-on-write over a canonical resource's coded fields. This
 * is the EXTENSIBLE / data-quality path: a large-vocabulary code that misses the
 * bundled pack, or a malformed SNOMED SCTID, records an audited WARNING and the
 * pack version but NEVER blocks the write. `required`-strength codes are already
 * fail-closed rejected upstream by the scribe schema's closed enums. All checks
 * are local SQL membership or pure format — zero network calls.
 */
import type { JsonObject } from "../db/canonical-json.js";
import { collectCodings } from "../fhir/codings.js";
import { isSnomedSystem, isValidSctid } from "../terminology/snomed-format.js";
import { SYS_ICD10CM, SYS_LOINC, SYS_RXNORM } from "../terminology/systems.js";
import type { TerminologyValidator } from "../terminology/validator.js";

const MEMBERSHIP_SYSTEMS = new Set([SYS_ICD10CM, SYS_LOINC, SYS_RXNORM]);

export interface TerminologyWarning {
  readonly system: string;
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}

export interface TerminologyReport {
  readonly warnings: readonly TerminologyWarning[];
  readonly packVersions: Readonly<Record<string, string | null>>;
}

/** Validate the coded fields of a canonical FHIR resource; warns, never blocks. */
export async function checkResourceTerminology(
  resource: JsonObject,
  validator: TerminologyValidator
): Promise<TerminologyReport> {
  const warnings: TerminologyWarning[] = [];
  const packVersions: Record<string, string | null> = {};
  for (const coding of collectCodings(resource)) {
    if (isSnomedSystem(coding.system)) {
      if (!isValidSctid(coding.code)) {
        warnings.push({
          ...coding,
          message: "malformed SNOMED SCTID (format check only; not bundled)"
        });
      }
      continue;
    }
    if (!MEMBERSHIP_SYSTEMS.has(coding.system)) continue;
    const result = await validator.validateCode({ system: coding.system, code: coding.code });
    packVersions[coding.system] = result.version ?? null;
    if (!result.result) {
      warnings.push({ ...coding, message: result.message ?? "code not in bundled pack" });
    }
  }
  return { warnings, packVersions };
}
