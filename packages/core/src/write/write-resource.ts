/**
 * The typed write primitive: the ONLY write API for the ~8 scribe resources plus
 * Consent. It parses the untrusted input (Zod, parse-don't-validate; a bad
 * `required` code fails closed here), maps it to canonical FHIR R4 / US Core,
 * runs offline terminology validate-on-write, and persists the canonical FHIR
 * (NOT the typed input) plus its replayable raw payload via BF-02's ONE atomic
 * transaction. practice_id is stamped server-side from the tenant GUC, never read
 * from the input.
 */
import type { FhirResourceRecord } from "../db/fhir-store.js";
import { insertFhirResourceTx } from "../db/fhir-store.js";
import type { TenantSql } from "../db/tenant.js";
import { toFhir } from "../fhir/mappers.js";
import { scribeInputSchema } from "../fhir/scribe-schemas.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import { createBundledPackValidator } from "../terminology/bundled-pack-validator.js";
import { createSqlConceptLookup } from "../terminology/concept-lookup.js";
import type { WriteError } from "./errors.js";
import type { TerminologyReport } from "./terminology-check.js";
import { checkResourceTerminology } from "./terminology-check.js";

export interface WriteResult {
  readonly record: FhirResourceRecord;
  readonly terminology: TerminologyReport;
}

/**
 * Validate → map → terminology-check → persist, all inside the caller's tenant
 * transaction (call within `withTenant`). Returns a typed Result; a thrown DB
 * error propagates to roll the whole transaction back.
 */
export async function writeScribeResource(
  sql: TenantSql,
  input: unknown
): Promise<Result<WriteResult, WriteError>> {
  const parsed = scribeInputSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".");
    const where = path === undefined || path === "" ? "input" : path;
    return err({ code: "INVALID_SCRIBE_INPUT", message: `invalid scribe input at ${where}` });
  }
  const scribe = parsed.data;
  const fhir = toFhir(scribe);
  const validator = createBundledPackValidator(createSqlConceptLookup(sql));
  const terminology = await checkResourceTerminology(fhir, validator);
  const stored = await insertFhirResourceTx(sql, {
    id: scribe.id,
    type: scribe.resourceType,
    content: fhir,
    rawPayload: JSON.stringify(scribe)
  });
  if (!stored.ok) return err(stored.error);
  return ok({ record: stored.data, terminology });
}
