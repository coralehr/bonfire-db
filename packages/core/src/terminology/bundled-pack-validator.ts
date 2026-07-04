/**
 * BundledPackValidator: the default terminology validator. It answers
 * `$validate-code` purely from LOCAL bundled packs via an injected concept
 * lookup — no network, ever. A missing pack or an unknown code returns
 * `result: false` WITH the pack version (when one is loaded) so the write path
 * can record an audited data-quality warning; it never throws and never blocks.
 */
import type { TerminologyValidator, ValidateCodeRequest, ValidateCodeResult } from "./validator.js";

/** The narrow read surface the validator needs over the bundled terminology tables. */
export interface TerminologyConceptLookup {
  /** The concept row (with its pack version) for an exact (system, code), or undefined. */
  findConcept(system: string, code: string): Promise<{ readonly version: string } | undefined>;
  /** The loaded pack version for a system, or undefined when no pack is loaded. */
  packVersion(system: string): Promise<string | undefined>;
}

/** Build a validator that resolves codes against local bundled packs only. */
export function createBundledPackValidator(lookup: TerminologyConceptLookup): TerminologyValidator {
  return {
    async validateCode(request: ValidateCodeRequest): Promise<ValidateCodeResult> {
      const concept = await lookup.findConcept(request.system, request.code);
      if (concept !== undefined) {
        return { result: true, version: concept.version };
      }
      const version = await lookup.packVersion(request.system);
      if (version === undefined) {
        return { result: false, message: `no bundled pack loaded for system ${request.system}` };
      }
      return {
        result: false,
        version,
        message: `code ${request.code} not found in ${request.system} pack ${version}`
      };
    }
  };
}
