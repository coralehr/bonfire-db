/**
 * spidx extraction — the LOCKED shrunken US Core search-parameter core for
 * the scribe resources: reference params `subject` / `patient` (the RAW
 * `.reference` string, no resolution) and token params `code` /
 * `clinical-status` / `identifier` (system+code pairs from
 * CodeableConcept.coding[] / Identifier[]). Date-range, partial-date and
 * composite params are OUT OF SCOPE for v0 (see the BF-04 ADR); the spidx
 * date_low/date_high columns stay schema-reserved and unwritten.
 */
import type { JsonObject, JsonValue } from "@bonfire/core";

export type SpidxParamType = "reference" | "token";

export interface SpidxRow {
  readonly resourceType: string;
  readonly paramName: string;
  readonly paramType: SpidxParamType;
  readonly tokenSystem: string | null;
  readonly tokenCode: string | null;
  readonly refValue: string | null;
}

type ExtractKind = "reference" | "codeable-concept" | "identifier";

interface ParamSpec {
  readonly param: string;
  readonly kind: ExtractKind;
  readonly path: readonly string[];
}

/** Declarative param table: resource type -> supported search params. */
const PARAM_TABLE: Readonly<Record<string, readonly ParamSpec[]>> = {
  Patient: [{ param: "identifier", kind: "identifier", path: ["identifier"] }],
  Observation: [
    { param: "subject", kind: "reference", path: ["subject"] },
    { param: "code", kind: "codeable-concept", path: ["code"] }
  ],
  Condition: [
    { param: "subject", kind: "reference", path: ["subject"] },
    { param: "code", kind: "codeable-concept", path: ["code"] },
    { param: "clinical-status", kind: "codeable-concept", path: ["clinicalStatus"] }
  ],
  Encounter: [{ param: "subject", kind: "reference", path: ["subject"] }],
  Procedure: [
    { param: "subject", kind: "reference", path: ["subject"] },
    { param: "code", kind: "codeable-concept", path: ["code"] }
  ],
  MedicationRequest: [
    { param: "subject", kind: "reference", path: ["subject"] },
    { param: "code", kind: "codeable-concept", path: ["medicationCodeableConcept"] }
  ],
  AllergyIntolerance: [
    { param: "patient", kind: "reference", path: ["patient"] },
    { param: "code", kind: "codeable-concept", path: ["code"] },
    { param: "clinical-status", kind: "codeable-concept", path: ["clinicalStatus"] }
  ],
  DocumentReference: [
    { param: "subject", kind: "reference", path: ["subject"] },
    { param: "identifier", kind: "identifier", path: ["identifier"] }
  ]
};

/** Walk a JSON path, flattening arrays at every step (one generic walker). */
function valuesAtPath(root: JsonValue, path: readonly string[]): JsonValue[] {
  let current: JsonValue[] = [root];
  for (const key of path) {
    current = current.flatMap((value) => {
      if (Array.isArray(value)) return value.flatMap((item) => itemProperty(item, key));
      return itemProperty(value, key);
    });
  }
  return current.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function itemProperty(value: JsonValue, key: string): JsonValue[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const child = value[key];
  return child === undefined ? [] : [child];
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function extractOne(resourceType: string, spec: ParamSpec, node: JsonValue): SpidxRow[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  switch (spec.kind) {
    case "reference": {
      const reference = asString(node.reference);
      if (reference === null) return [];
      return [row(resourceType, spec.param, "reference", null, null, reference)];
    }
    case "codeable-concept": {
      const codings = valuesAtPath(node, ["coding"]);
      return codings.flatMap((coding) => {
        if (typeof coding !== "object" || coding === null || Array.isArray(coding)) return [];
        const code = asString(coding.code);
        if (code === null) return [];
        return [row(resourceType, spec.param, "token", asString(coding.system), code, null)];
      });
    }
    case "identifier": {
      const value = asString(node.value);
      if (value === null) return [];
      return [row(resourceType, spec.param, "token", asString(node.system), value, null)];
    }
  }
}

function row(
  resourceType: string,
  paramName: string,
  paramType: SpidxParamType,
  tokenSystem: string | null,
  tokenCode: string | null,
  refValue: string | null
): SpidxRow {
  return { resourceType, paramName, paramType, tokenSystem, tokenCode, refValue };
}

/** Extract every supported search-parameter row for one canonical resource. */
export function extractSearchParams(resource: JsonObject): SpidxRow[] {
  const resourceType = resource.resourceType;
  if (typeof resourceType !== "string") return [];
  const specs = PARAM_TABLE[resourceType] ?? [];
  return specs.flatMap((spec) =>
    valuesAtPath(resource, spec.path).flatMap((node) => extractOne(resourceType, spec, node))
  );
}
