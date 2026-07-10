/**
 * The per-type DECLARED leaf-path table (D2b): the ONLY fields the CCP ever
 * projects. Leaf-level and scalar by construction — never a blind recursive
 * walk — so ids, `system` URIs, and internal `reference` values can never leak
 * into a span. Path grammar: dotted segments where a numeric segment indexes an
 * array (FHIR field names never contain '.'), resolvable in SQL via
 * `content #> string_to_array(path, '.')` and in TS via `resolvePath`. The `.0`
 * index pinning (first name, first coding) is the documented v0 scope.
 */
import type { JsonObject, JsonValue } from "../db/canonical-json.js";
import type { CcpSpanValue } from "./schemas.js";

/** Declared scalar leaf paths per searchable clinical type (keys = SEARCHABLE_TYPES). */
export const LEAF_PATHS: Readonly<Record<string, readonly string[]>> = {
  Patient: ["name.0.family", "name.0.given.0", "birthDate"],
  Encounter: ["class.code", "period.start", "period.end", "status"],
  Condition: [
    "code.coding.0.display",
    "code.coding.0.code",
    "code.text",
    "clinicalStatus.coding.0.code",
    "onsetDateTime",
    "note.0.text"
  ],
  Observation: [
    "code.coding.0.display",
    "valueQuantity.value",
    "valueQuantity.unit",
    "valueString",
    "note.0.text",
    "effectiveDateTime"
  ],
  MedicationRequest: ["medicationCodeableConcept.coding.0.display", "status", "authoredOn"],
  AllergyIntolerance: ["code.coding.0.display", "clinicalStatus.coding.0.code", "recordedDate"],
  Procedure: ["code.coding.0.display", "performedDateTime", "status"],
  DocumentReference: ["type.coding.0.display", "content.0.attachment.title", "date", "status"]
};

const ARRAY_INDEX = /^\d+$/;

function step(current: JsonValue, segment: string): JsonValue | undefined {
  if (Array.isArray(current)) {
    return ARRAY_INDEX.test(segment) ? current[Number(segment)] : undefined;
  }
  if (typeof current === "object" && current !== null) return current[segment];
  return undefined;
}

/**
 * Walk a declared dotted path. Returns the scalar leaf, or undefined when the
 * path does not resolve (missing field, null, or a scalar mid-path). A declared
 * path resolving to an object or array is a programmer error in the table
 * (Class 4a) and THROWS: a non-scalar leaf could smuggle a `system` URI or a
 * reference id into a span, so the walk refuses to return one.
 */
export function resolvePath(content: JsonObject, path: string): CcpSpanValue | undefined {
  let current: JsonValue | undefined = content;
  for (const segment of path.split(".")) {
    if (current === undefined || current === null) return undefined;
    current = step(current, segment);
  }
  if (current === undefined || current === null) return undefined;
  if (typeof current === "object") {
    throw new Error(`declared CCP leaf path resolved to a non-scalar: ${path}`);
  }
  return current;
}
