/**
 * The typed↔FHIR mapping seam. `toFhir` dispatches each scribe input to its
 * typed FHIR builder and serializes the result to canonical `JsonObject` — the
 * ONLY writer of persisted FHIR. `fromFhir` inverts it (strip `meta`,
 * re-validate against the scribe schema); because the builders add only
 * `meta.profile`, the inverse recovers the input exactly, and any future lossy
 * transform surfaces as a round-trip diff the gate rejects (ratchet BP-008).
 */
import type { JsonObject } from "../db/canonical-json.js";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import {
  buildAllergyIntolerance,
  buildCondition,
  buildConsent,
  buildDocumentReference,
  buildEncounter,
  buildMedicationRequest,
  buildObservation,
  buildPatient,
  buildProcedure
} from "./build.js";
import { toJsonObject } from "./json.js";
import type { ScribeInput } from "./scribe-schemas.js";
import { scribeInputSchema } from "./scribe-schemas.js";

export type MapperErrorCode = "UNMAPPABLE_FHIR";
export type MapperError = BonfireError<MapperErrorCode>;

/** Map a validated scribe input to canonical FHIR (typed builder + serialize). */
export function toFhir(input: ScribeInput): JsonObject {
  switch (input.resourceType) {
    case "Patient":
      return toJsonObject(buildPatient(input));
    case "Encounter":
      return toJsonObject(buildEncounter(input));
    case "Condition":
      return toJsonObject(buildCondition(input));
    case "Observation":
      return toJsonObject(buildObservation(input));
    case "MedicationRequest":
      return toJsonObject(buildMedicationRequest(input));
    case "AllergyIntolerance":
      return toJsonObject(buildAllergyIntolerance(input));
    case "Procedure":
      return toJsonObject(buildProcedure(input));
    case "DocumentReference":
      return toJsonObject(buildDocumentReference(input));
    case "Consent":
      return toJsonObject(buildConsent(input));
  }
}

/** Recover the scribe input from canonical FHIR (strip `meta`, re-validate). */
export function fromFhir(content: JsonObject): Result<ScribeInput, MapperError> {
  const { meta: _meta, ...rest } = content;
  const parsed = scribeInputSchema.safeParse(rest);
  if (!parsed.success) {
    return err({
      code: "UNMAPPABLE_FHIR",
      message: "canonical FHIR does not match any scribe schema"
    });
  }
  return ok(parsed.data);
}

export interface RoundTrip {
  readonly fhir: JsonObject;
  readonly recovered: Result<ScribeInput, MapperError>;
}

/** Run a full typed→FHIR→typed round-trip for diffing against the source input. */
export function roundTrip(input: ScribeInput): RoundTrip {
  const fhir = toFhir(input);
  return { fhir, recovered: fromFhir(fhir) };
}
